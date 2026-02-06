import { query as sdkQuery, type HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { ForgeOptions, ForgeResult } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';

// Custom error that carries the ForgeResult for cost tracking on failure
export class ForgeError extends Error {
  result?: ForgeResult;
  constructor(message: string, result?: ForgeResult) {
    super(message);
    this.name = 'ForgeError';
    this.result = result;
  }
}

const execAsync = promisify(exec);

// ── ANSI Colors ──────────────────────────────────────────────
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
// 256-color grays — visible on both light and dark terminals
const G = [
  '\x1b[38;5;252m', // lightest
  '\x1b[38;5;249m',
  '\x1b[38;5;245m',
  '\x1b[38;5;242m',
  '\x1b[38;5;238m',
  '\x1b[38;5;235m', // darkest
];

const BANNER = [
  '███████╗ ██████╗ ██████╗  ██████╗ ███████╗',
  '██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝',
  '█████╗  ██║   ██║██████╔╝██║  ███╗█████╗  ',
  '██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝  ',
  '██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗',
  '╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝',
];

function showBanner(subtitle?: string): void {
  console.log();
  BANNER.forEach((line, i) => console.log(`${G[i]}${line}${RESET}`));
  if (subtitle) {
    console.log(`\n${DIM}${subtitle}${RESET}`);
  }
  console.log();
}

// Single-line spinner that overwrites itself in place
function createInlineSpinner(prefix: string) {
  let frameIndex = 0;
  let text = '';
  let interval: ReturnType<typeof setInterval> | null = null;
  const cols = () => process.stdout.columns || 80;

  function render() {
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
    const line = `${frame} ${prefix}${text ? ` ${DIM}${text}${RESET}` : ''}`;
    const truncated = line.length > cols() ? line.substring(0, cols() - 1) : line;
    process.stdout.write(`\x1B[2K\r${truncated}`);
    frameIndex++;
  }

  return {
    start() { interval = setInterval(render, 80); render(); },
    update(newText: string) { text = newText; },
    stop(finalLine?: string) {
      if (interval) clearInterval(interval);
      process.stdout.write('\x1B[2K\r');
      if (finalLine) console.log(finalLine);
    },
  };
}

async function saveResult(
  workingDir: string,
  result: ForgeResult,
  resultText: string
): Promise<string> {
  // Create timestamp-based directory name (filesystem safe)
  const timestamp = result.startedAt.replace(/[:.]/g, '-');
  const resultsDir = path.join(workingDir, '.forge', 'results', timestamp);

  await fs.mkdir(resultsDir, { recursive: true });

  // Save structured summary
  const summaryPath = path.join(resultsDir, 'summary.json');
  await fs.writeFile(summaryPath, JSON.stringify(result, null, 2));

  // Save full result text (no truncation)
  const resultPath = path.join(resultsDir, 'result.md');
  const resultContent = `# Forge Result

**Started**: ${result.startedAt}
**Completed**: ${result.completedAt}
**Duration**: ${result.durationSeconds.toFixed(1)}s
**Status**: ${result.status}
**Cost**: ${result.costUsd !== undefined ? `$${result.costUsd.toFixed(4)}` : 'N/A'}
**Model**: ${result.model}
${result.sessionId ? `**Session**: ${result.sessionId}` : ''}
${result.specPath ? `**Spec**: ${result.specPath}` : ''}

## Prompt

${result.prompt}

## Result

${resultText}
`;
  await fs.writeFile(resultPath, resultContent);

  return resultsDir;
}

// Format progress output with agent context
function formatProgress(agent: string | null, message: string): string {
  const name = agent ? agent.charAt(0).toUpperCase() + agent.slice(1) : 'Main';
  return `${DIM}[${name}]${RESET} ${message}`;
}

// Check if an error is transient and retryable
function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    // Rate limits, network errors, server errors
    return (
      message.includes('rate limit') ||
      message.includes('rate_limit') ||
      message.includes('429') ||
      message.includes('503') ||
      message.includes('502') ||
      message.includes('timeout') ||
      message.includes('econnreset') ||
      message.includes('econnrefused') ||
      message.includes('network') ||
      message.includes('overloaded')
    );
  }
  return false;
}

// Sleep helper for retry delays
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Detect project type and return verification commands
async function detectVerification(workingDir: string): Promise<string[]> {
  const commands: string[] = [];

  try {
    const packageJsonPath = path.join(workingDir, 'package.json');
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
    const scripts = packageJson.scripts || {};

    // TypeScript check
    if (packageJson.devDependencies?.typescript || packageJson.dependencies?.typescript) {
      commands.push('npx tsc --noEmit');
    }

    // Build command
    if (scripts.build) {
      commands.push('npm run build');
    }

    // Test command (optional - don't fail if no tests)
    if (scripts.test && !scripts.test.includes('no test specified')) {
      commands.push('npm test');
    }
  } catch {
    // No package.json - try common patterns
    try {
      await fs.access(path.join(workingDir, 'Cargo.toml'));
      commands.push('cargo check');
      commands.push('cargo build');
    } catch {}

    try {
      await fs.access(path.join(workingDir, 'go.mod'));
      commands.push('go build ./...');
    } catch {}
  }

  return commands;
}

// Run verification and return errors if any
async function runVerification(workingDir: string, quiet: boolean): Promise<{ passed: boolean; errors: string }> {
  const commands = await detectVerification(workingDir);

  if (commands.length === 0) {
    if (!quiet) console.log(`${DIM}[Verify]${RESET} No verification commands detected`);
    return { passed: true, errors: '' };
  }

  const errors: string[] = [];

  for (const cmd of commands) {
    let spinner: ReturnType<typeof createInlineSpinner> | null = null;
    if (!quiet) {
      spinner = createInlineSpinner(`${DIM}[Verify]${RESET} ${cmd}`);
      spinner.start();
    }
    try {
      await execAsync(cmd, { cwd: workingDir, timeout: 120000 });
      if (spinner) spinner.stop(`${DIM}[Verify]${RESET} \x1b[32m✓\x1b[0m ${cmd}`);
    } catch (err) {
      const error = err as { stderr?: string; stdout?: string; message?: string };
      const errorOutput = error.stderr || error.stdout || error.message || 'Unknown error';
      errors.push(`Command failed: ${cmd}\n${errorOutput}`);
      if (spinner) spinner.stop(`${DIM}[Verify]${RESET} \x1b[31m✗\x1b[0m ${cmd}`);
    }
  }

  return {
    passed: errors.length === 0,
    errors: errors.join('\n\n')
  };
}

// Run a single spec
async function runSingleSpec(options: ForgeOptions & { specContent?: string; _silent?: boolean; _onActivity?: (detail: string) => void; _runId?: string }): Promise<ForgeResult> {
  const { prompt, specPath, specContent, cwd, model = 'opus', maxTurns = 100, planOnly = false, dryRun = false, verbose = false, quiet = false, resume, _silent = false, _onActivity, _runId } = options;

  // Resolve working directory
  const workingDir = cwd ? (await fs.realpath(cwd)) : process.cwd();

  // Validate working directory exists
  try {
    const stat = await fs.stat(workingDir);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${workingDir}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Directory not found: ${workingDir}`);
    }
    throw err;
  }

  // Read spec content if provided (and not already passed)
  let finalSpecContent: string | undefined = specContent;
  if (!finalSpecContent && specPath) {
    try {
      finalSpecContent = await fs.readFile(specPath, 'utf-8');
    } catch {
      throw new Error(`Spec file not found: ${specPath}`);
    }
  }

  // Build the prompt
  let fullPrompt = prompt;
  if (finalSpecContent) {
    fullPrompt = `## Specification\n\n${finalSpecContent}\n\n## Additional Context\n\n${prompt}`;
  }

  // Configure prompt - outcome-focused, not procedural
  let workflowPrompt: string;
  if (dryRun) {
    workflowPrompt = `Analyze this work and create a task breakdown. Do NOT implement - this is a dry run for cost estimation.

Output a structured summary:

## Tasks

[List each task with number, subject, and brief description]

## Summary

- Total tasks: [count]
- Dependencies: [describe any task dependencies]

${fullPrompt}`;
  } else if (planOnly) {
    workflowPrompt = `Analyze this work and create a task breakdown. Do NOT implement - planning only.\n\n${fullPrompt}`;
  } else {
    workflowPrompt = `## Outcome

${fullPrompt}

## Acceptance Criteria

- Code compiles without errors
- All imports resolve correctly
- No TypeScript errors (if applicable)
- UI elements are visible and functional

## How to Work

You decide the best approach. You may:
- Work directly on the code
- Break work into tasks if helpful
- Use any tools available

Focus on delivering working code that meets the acceptance criteria.`;
  }

  // Verification loop settings
  const maxVerifyAttempts = 3;
  let verifyAttempt = 0;
  let currentPrompt = workflowPrompt;

  // SDK accepts shorthand model names
  const modelName = model;

  // Track timing
  const startTime = new Date();

  // Run the query
  if (!quiet) {
    if (cwd) {
      console.log(`${DIM}Working directory:${RESET} ${workingDir}`);
    }
    if (dryRun) {
      console.log(`${DIM}Mode: dry run (planning only)${RESET}\n`);
    }
  }

  // Track current agent for progress output
  let currentAgent: string | null = null;
  // Streaming state
  let currentToolName: string | null = null;
  let toolInputJson = '';
  // Session tracking
  let sessionId: string | undefined;
  // Inline spinner for non-verbose single-spec runs
  const useSpinner = !_silent && !verbose && !quiet;
  let agentSpinner: ReturnType<typeof createInlineSpinner> | null = null;

  // Hook: Bash command guardrails
  const blockedCommands: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /rm\s+-[^\s]*r[^\s]*\s+\/(?:\s|$)/, reason: 'Recursive delete of root' },
    { pattern: /rm\s+-[^\s]*r[^\s]*\s+~/, reason: 'Recursive delete of home' },
    { pattern: /git\s+push\s.*--force/, reason: 'Git force push' },
    { pattern: /git\s+push\s.*\s-f\b/, reason: 'Git force push' },
    { pattern: /git\s+reset\s+--hard/, reason: 'Git hard reset' },
    { pattern: /git\s+clean\s.*-[^\s]*f/, reason: 'Git clean with force' },
    { pattern: /mkfs/, reason: 'Filesystem format' },
    { pattern: /dd\s+if=\/dev\//, reason: 'Raw device operation' },
    { pattern: /:\(\)\s*\{/, reason: 'Fork bomb' },
  ];
  const bashGuardrail: HookCallback = async (input) => {
    const command = ((input as Record<string, unknown>).tool_input as Record<string, unknown>)?.command as string || '';
    for (const { pattern, reason } of blockedCommands) {
      if (pattern.test(command)) {
        if (!quiet) console.log(`${DIM}[forge]${RESET} Blocked: ${reason}`);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: `[forge] ${reason}`,
          },
        };
      }
    }
    return {};
  };

  // Hook: Stop handler - persist session state for resume on interrupt
  const latestSessionPath = path.join(workingDir, '.forge', 'latest-session.json');
  const persistSession = async () => {
    const state = { sessionId, startedAt: startTime.toISOString(), prompt, model: modelName, cwd: workingDir };
    await fs.mkdir(path.join(workingDir, '.forge'), { recursive: true });
    await fs.writeFile(latestSessionPath, JSON.stringify(state, null, 2));
  };
  const stopHandler: HookCallback = async () => {
    try { await persistSession(); } catch {}
    return {};
  };

  // Hook: Tool call audit log
  const auditPath = path.join(workingDir, '.forge', 'audit.jsonl');
  const auditLog: HookCallback = async (input, toolUseID) => {
    try {
      const inp = input as Record<string, unknown>;
      const entry = {
        ts: new Date().toISOString(),
        spec: specPath ? path.basename(specPath) : undefined,
        sessionId,
        tool: inp.tool_name,
        toolUseId: toolUseID,
        input: inp.tool_input,
      };
      await fs.mkdir(path.join(workingDir, '.forge'), { recursive: true });
      await fs.appendFile(auditPath, JSON.stringify(entry) + '\n');
    } catch {
      // Never crash on audit failures
    }
    return {};
  };

  // Retry configuration
  const maxRetries = 3;
  const baseDelayMs = 5000; // 5 seconds, doubles each retry

  // Main execution + verification loop
  while (verifyAttempt < maxVerifyAttempts) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      for await (const message of sdkQuery({
      prompt: currentPrompt,
      options: {
        cwd: workingDir,
        model: modelName,
        tools: { type: 'preset', preset: 'claude_code' },
        allowedTools: [
          'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob',
          'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'
        ],
        permissionMode: 'default',
        includePartialMessages: true,
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [bashGuardrail] }],
          PostToolUse: [{ hooks: [auditLog] }],
          Stop: [{ hooks: [stopHandler] }],
        },
        maxTurns: dryRun ? 20 : maxTurns,
        maxBudgetUsd: dryRun ? 5.00 : 50.00,
        ...(resume && { resume })
      }
    })) {
      // Capture session ID from init message
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id;
        if (!quiet) console.log(`${DIM}[forge]${RESET} Session: ${DIM}${sessionId}${RESET}`);
        persistSession().catch(() => {});
        if (useSpinner && !agentSpinner) {
          agentSpinner = createInlineSpinner(`${DIM}[forge]${RESET} Working...`);
          agentSpinner.start();
        }
      }

      // Stream real-time progress via partial messages
      if (message.type === 'stream_event' && (!quiet || _onActivity)) {
        const event = message.event;

        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          currentToolName = event.content_block.name;
          toolInputJson = '';
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta' && verbose && !_silent) {
            process.stdout.write(event.delta.text);
          } else if (event.delta.type === 'input_json_delta') {
            toolInputJson += event.delta.partial_json;
          }
        } else if (event.type === 'content_block_stop' && currentToolName) {
          try {
            const input = JSON.parse(toolInputJson || '{}') as Record<string, unknown>;

            // Derive activity description for parallel display
            let activity: string | undefined;
            if (currentToolName === 'Edit' || currentToolName === 'Write') {
              const filePath = input.file_path as string;
              if (filePath) activity = `Editing ${filePath.split('/').pop()}`;
            } else if (currentToolName === 'Read') {
              const filePath = input.file_path as string;
              if (filePath) activity = `Reading ${filePath.split('/').pop()}`;
            } else if (currentToolName === 'Bash') {
              const cmd = input.command as string;
              if (cmd) {
                const shortCmd = cmd.length > 40 ? cmd.substring(0, 37) + '...' : cmd;
                activity = `$ ${shortCmd}`;
              }
            } else if (currentToolName === 'Grep') {
              const pattern = input.pattern as string;
              if (pattern) activity = `Grep: ${pattern.substring(0, 30)}`;
            } else if (currentToolName === 'Glob') {
              const pattern = input.pattern as string;
              if (pattern) activity = `Glob: ${pattern.substring(0, 30)}`;
            } else if (currentToolName === 'TaskCreate') {
              const subject = input.subject as string;
              if (subject) activity = `Task: ${subject.substring(0, 35)}`;
            }

            if (_onActivity && activity) {
              _onActivity(activity);
            }

            // Console output for non-silent mode
            if (!_silent) {
              if (agentSpinner && activity) {
                // Spinner mode: update single line
                agentSpinner.update(activity);
              } else if (currentToolName === 'Task') {
                const agentType = input.subagent_type as string;
                const description = input.description as string;
                if (agentType && agentType !== currentAgent) {
                  currentAgent = agentType;
                  const desc = description ? `: ${description}` : '';
                  console.log(formatProgress(currentAgent, `Starting${desc}`));
                }
              } else if (!verbose) {
                if (currentToolName === 'TaskCreate') {
                  const subject = input.subject as string;
                  if (subject) console.log(formatProgress(currentAgent, `Creating task: ${subject}`));
                } else if (currentToolName === 'TaskUpdate') {
                  const status = input.status as string;
                  if (status === 'completed') console.log(formatProgress(currentAgent, 'Task completed'));
                } else if (currentToolName === 'Edit' || currentToolName === 'Write') {
                  const filePath = input.file_path as string;
                  if (filePath) {
                    const fileName = filePath.split('/').pop();
                    console.log(formatProgress(currentAgent, `Editing ${fileName}`));
                  }
                } else if (currentToolName === 'Bash') {
                  const cmd = input.command as string;
                  if (cmd) {
                    const shortCmd = cmd.length > 50 ? cmd.substring(0, 47) + '...' : cmd;
                    console.log(formatProgress(currentAgent, `Running: ${shortCmd}`));
                  }
                }
              }
            }
          } catch {
            // JSON parse failed - skip progress for this tool
          }
          currentToolName = null;
          toolInputJson = '';
        }
      }

      if (message.type === 'result') {
        // Stop agent spinner before any result output
        if (agentSpinner) { agentSpinner.stop(); agentSpinner = null; }

        const endTime = new Date();
        const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

        if (message.subtype === 'success') {
          const resultText = message.result || '';

          // Run verification (unless dry-run or plan-only)
          if (!dryRun && !planOnly) {
            if (!quiet) console.log(`${DIM}[forge]${RESET} Running verification...`);
            const verification = await runVerification(workingDir, quiet);

            if (!verification.passed) {
              verifyAttempt++;
              if (verifyAttempt < maxVerifyAttempts) {
                if (!quiet) {
                  console.log(`\n${DIM}[forge]${RESET} \x1b[33mVerification failed\x1b[0m (attempt ${verifyAttempt}/${maxVerifyAttempts})`);
                  console.log(`${DIM}[forge]${RESET} Sending errors back to agent for fixes...\n`);
                }
                // Update prompt with errors for next iteration
                currentPrompt = `## Previous Work

The implementation is mostly complete but verification failed.

## Errors to Fix

${verification.errors}

## Instructions

Fix these errors. The code should compile and build successfully.`;
                break; // Break out of message loop to start new query
              } else {
                if (!quiet) {
                  console.log(`\n${DIM}[forge]${RESET} \x1b[31mVerification failed after ${maxVerifyAttempts} attempts\x1b[0m`);
                  console.log(`${DIM}[forge]${RESET} Errors:\n` + verification.errors);
                }
              }
            } else {
              if (!quiet) console.log(`${DIM}[forge]${RESET} \x1b[32mVerification passed!\x1b[0m\n`);
            }
          }

          // Save result to .forge/results/
          const forgeResult: ForgeResult = {
            startedAt: startTime.toISOString(),
            completedAt: endTime.toISOString(),
            durationSeconds,
            status: 'success',
            costUsd: message.total_cost_usd,
            specPath,
            prompt,
            model: modelName,
            cwd: workingDir,
            sessionId,
            runId: _runId
          };

          const resultsDir = await saveResult(workingDir, forgeResult, resultText);

          if (_silent) {
            // Silent: no output at all (parallel mode)
          } else if (quiet) {
            // Quiet mode: just show results path
            console.log(resultsDir);
          } else {
            // Display result (full, no truncation)
            console.log('\n---\nResult:\n');
            console.log(resultText);

            // Display summary
            console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
            console.log(`  Duration: ${BOLD}${durationSeconds.toFixed(1)}s${RESET}`);
            if (message.total_cost_usd !== undefined) {
              console.log(`  Cost:     ${BOLD}$${message.total_cost_usd.toFixed(4)}${RESET}`);
            }
            console.log(`  Results:  ${DIM}${resultsDir}${RESET}`);
            if (sessionId) {
              console.log(`  Session:  ${DIM}${sessionId}${RESET}`);
              console.log(`  Resume:   forge run --resume ${sessionId} "continue"`);
            }
          }

          // Dry run: show cost estimates
          if (dryRun && !quiet) {
            const taskCountMatch = resultText.match(/Total tasks:\s*(\d+)/i);
            const taskCount = taskCountMatch ? parseInt(taskCountMatch[1], 10) : 0;

            const planningCost = message.total_cost_usd || 0;
            const minExecCost = taskCount * 1.50;
            const maxExecCost = taskCount * 2.50;
            const minTotal = planningCost + minExecCost;
            const maxTotal = planningCost + maxExecCost;

            console.log('\n===== DRY RUN ESTIMATE =====');
            console.log(`Planning cost: $${planningCost.toFixed(2)}`);
            if (taskCount > 0) {
              console.log(`Tasks: ${taskCount}`);
              console.log(`Estimated execution: $${minExecCost.toFixed(2)} - $${maxExecCost.toFixed(2)}`);
              console.log(`Estimated total: $${minTotal.toFixed(2)} - $${maxTotal.toFixed(2)}`);
            } else {
              console.log('Could not determine task count from output');
            }
            console.log('\nRun without --dry-run to execute.');
            console.log('================================');
          }

          // If we got here without breaking, we're done
          return forgeResult;
        } else if (message.subtype === 'error_during_execution') {
          const errorText = JSON.stringify(message.errors, null, 2);

          const forgeResult: ForgeResult = {
            startedAt: startTime.toISOString(),
            completedAt: endTime.toISOString(),
            durationSeconds,
            status: 'error_execution',
            costUsd: message.total_cost_usd,
            specPath,
            prompt,
            model: modelName,
            cwd: workingDir,
            sessionId,
            error: errorText,
            runId: _runId
          };

          await saveResult(workingDir, forgeResult, `Error:\n${errorText}`);

          throw new ForgeError(`Execution failed: ${errorText}`, forgeResult);
        } else if (message.subtype === 'error_max_turns') {
          const forgeResult: ForgeResult = {
            startedAt: startTime.toISOString(),
            completedAt: endTime.toISOString(),
            durationSeconds,
            status: 'error_max_turns',
            costUsd: message.total_cost_usd,
            specPath,
            prompt,
            model: modelName,
            cwd: workingDir,
            sessionId,
            error: 'Hit maximum turns limit',
            runId: _runId
          };

          await saveResult(workingDir, forgeResult, 'Error: Hit maximum turns limit');

          throw new ForgeError('Hit maximum turns limit', forgeResult);
        } else if (message.subtype === 'error_max_budget_usd') {
          const forgeResult: ForgeResult = {
            startedAt: startTime.toISOString(),
            completedAt: endTime.toISOString(),
            durationSeconds,
            status: 'error_budget',
            costUsd: message.total_cost_usd,
            specPath,
            prompt,
            model: modelName,
            cwd: workingDir,
            sessionId,
            error: 'Exceeded budget limit',
            runId: _runId
          };

          await saveResult(workingDir, forgeResult, 'Error: Exceeded budget limit');

          throw new ForgeError('Exceeded budget limit', forgeResult);
        }
      }
    }
    // If we reach here without error, break out of retry loop
    break;
  } catch (error) {
    // Stop spinner if still running
    if (agentSpinner) { agentSpinner.stop(); agentSpinner = null; }

    if (error instanceof Error && error.message.includes('not installed')) {
      throw new Error('Agent SDK not properly installed. Run: bun install @anthropic-ai/claude-agent-sdk');
    }

    // Check if error is transient and we have retries left
    if (isTransientError(error) && attempt < maxRetries) {
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      if (!quiet) {
        console.log(`\n${DIM}[forge]${RESET} \x1b[33mTransient error:\x1b[0m ${error instanceof Error ? error.message : 'Unknown error'}`);
        console.log(`${DIM}[forge]${RESET} Retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
      }
      await sleep(delayMs);
      continue;
    }

    // Non-transient error or out of retries — save result before throwing
    // If it's already a ForgeError (from the result handlers above), just re-throw
    if (error instanceof ForgeError) {
      throw error;
    }
    const endTime = new Date();
    const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    const forgeResult: ForgeResult = {
      startedAt: startTime.toISOString(),
      completedAt: endTime.toISOString(),
      durationSeconds,
      status: 'error_execution',
      specPath,
      prompt,
      model: modelName,
      cwd: workingDir,
      sessionId,
      error: errMsg,
      runId: _runId
    };
    await saveResult(workingDir, forgeResult, `Error:\n${errMsg}`).catch(() => {});
    throw new ForgeError(errMsg, forgeResult);
  }
  } // end retry loop
  } // end verification loop

  // All verification attempts exhausted — should not normally reach here
  // (the success path returns, error paths throw)
  throw new ForgeError('Verification failed after all attempts');
}

// Worker pool: runs tasks with bounded concurrency
async function workerPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await worker(items[i], i);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runNext());
  await Promise.all(workers);
  return results;
}

// Format elapsed time as "Xm Ys"
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Multi-line spinner display for parallel spec execution
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

type SpecStatus = 'waiting' | 'running' | 'success' | 'failed';

interface SpecState {
  name: string;
  status: SpecStatus;
  startedAt?: number;
  duration?: number;
  error?: string;
  detail?: string;
}

function createSpecDisplay(specFiles: string[]) {
  const states: SpecState[] = specFiles.map(name => ({ name, status: 'waiting' }));
  let frameIndex = 0;
  let linesDrawn = 0;

  function render() {
    const cols = process.stdout.columns || 80;

    // Move cursor up to overwrite previous render
    if (linesDrawn > 0) {
      process.stdout.write(`\x1B[${linesDrawn}A`);
    }

    // Fixed prefix: "X name(35) elapsed(10)" = ~49 visible chars
    const prefixWidth = 49;
    const detailMax = Math.max(0, cols - prefixWidth - 4); // 4 for "  " + padding

    const lines: string[] = [];
    for (const s of states) {
      const padName = s.name.padEnd(35);
      switch (s.status) {
        case 'waiting':
          lines.push(`  ${padName} \x1B[2mwaiting\x1B[0m`);
          break;
        case 'running': {
          const elapsed = formatElapsed(Date.now() - s.startedAt!);
          const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
          const detail = s.detail && detailMax > 5
            ? `  \x1B[2m${s.detail.substring(0, detailMax)}\x1B[0m`
            : '';
          lines.push(`${frame} ${padName} ${elapsed}${detail}`);
          break;
        }
        case 'success':
          lines.push(`\x1B[32m✓\x1B[0m ${padName} \x1B[32m${formatElapsed(s.duration! * 1000)}\x1B[0m`);
          break;
        case 'failed': {
          const errMax = Math.max(0, cols - prefixWidth - 10); // "failed" + spacing
          const errDetail = s.error && errMax > 5
            ? `  \x1B[2m${s.error.substring(0, errMax)}\x1B[0m`
            : '';
          lines.push(`\x1B[31m✗\x1B[0m ${padName} \x1B[31mfailed\x1B[0m${errDetail}`);
          break;
        }
      }
    }

    // Clear each line before writing to avoid artifacts
    for (const line of lines) {
      process.stdout.write(`\x1B[2K${line}\n`);
    }
    linesDrawn = lines.length;
    frameIndex++;
  }

  const interval = setInterval(render, 80);

  return {
    start(index: number) {
      states[index].status = 'running';
      states[index].startedAt = Date.now();
    },
    activity(index: number, detail: string) {
      states[index].detail = detail;
    },
    done(index: number, duration: number) {
      states[index].status = 'success';
      states[index].duration = duration;
      states[index].detail = undefined;
    },
    fail(index: number, error: string) {
      states[index].status = 'failed';
      states[index].error = error;
      states[index].detail = undefined;
    },
    stop() {
      clearInterval(interval);
      render(); // Final render
    },
  };
}

// Auto-detect concurrency based on available memory and CPU
function autoDetectConcurrency(): number {
  const freeMem = os.freemem();
  const memBased = Math.floor(freeMem / (2 * 1024 * 1024 * 1024)); // 2GB per worker
  const cpuBased = Math.min(os.cpus().length, 5);
  return Math.max(1, Math.min(memBased, cpuBased));
}

// Run a batch of spec files (shared by specDir and rerunFailed paths)
async function runSpecBatch(
  specFilePaths: string[],
  specFileNames: string[],
  options: ForgeOptions,
  concurrency: number,
  runId: string,
): Promise<{ spec: string; status: string; cost?: number; duration: number }[]> {
  const results: { spec: string; status: string; cost?: number; duration: number }[] = [];
  const { quiet, parallel, sequentialFirst = 0 } = options;

  // Split into sequential-first and parallel portions
  const seqCount = parallel ? Math.min(sequentialFirst, specFileNames.length) : specFileNames.length;
  const seqNames = specFileNames.slice(0, seqCount);
  const seqPaths = specFilePaths.slice(0, seqCount);
  const parNames = specFileNames.slice(seqCount);
  const parPaths = specFilePaths.slice(seqCount);

  // Sequential phase
  for (let i = 0; i < seqNames.length; i++) {
    const specFile = seqNames[i];
    const specFilePath = seqPaths[i];

    if (!quiet) {
      console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
      console.log(`Running spec ${i + 1}/${seqNames.length}${parNames.length > 0 ? ' (sequential)' : ''}: ${BOLD}${specFile}${RESET}`);
      console.log(`${DIM}${'─'.repeat(60)}${RESET}\n`);
    }

    const startTime = Date.now();
    try {
      const specContent = await fs.readFile(specFilePath, 'utf-8');

      const result = await runSingleSpec({
        ...options,
        specPath: specFilePath,
        specContent,
        specDir: undefined,
        _runId: runId,
      });

      const duration = (Date.now() - startTime) / 1000;
      results.push({ spec: specFile, status: 'success', cost: result.costUsd, duration });
    } catch (err) {
      const duration = (Date.now() - startTime) / 1000;
      const cost = err instanceof ForgeError ? err.result?.costUsd : undefined;
      results.push({
        spec: specFile,
        status: `failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
        cost,
        duration
      });

      if (!quiet) {
        console.error(`\nSpec ${specFile} failed:`, err instanceof Error ? err.message : err);
        console.log('Continuing with next spec...\n');
      }
    }
  }

  // Parallel phase
  if (parNames.length > 0) {
    const display = createSpecDisplay(parNames);

    await workerPool(parNames, concurrency, async (specFile, i) => {
      const specFilePath = parPaths[i];
      display.start(i);

      const startTime = Date.now();
      try {
        const specContent = await fs.readFile(specFilePath, 'utf-8');

        const result = await runSingleSpec({
          ...options,
          specPath: specFilePath,
          specContent,
          specDir: undefined,
          parallel: undefined,
          quiet: true,
          _silent: true,
          _onActivity: (detail) => display.activity(i, detail),
          _runId: runId,
        });

        const duration = (Date.now() - startTime) / 1000;
        display.done(i, duration);
        results.push({ spec: specFile, status: 'success', cost: result.costUsd, duration });
      } catch (err) {
        const duration = (Date.now() - startTime) / 1000;
        const cost = err instanceof ForgeError ? err.result?.costUsd : undefined;
        const errMsg = err instanceof Error ? err.message : 'Unknown error';
        display.fail(i, errMsg);
        results.push({
          spec: specFile,
          status: `failed: ${errMsg}`,
          cost,
          duration
        });
      }
    });

    display.stop();
  }

  return results;
}

// Find failed specs from latest batch in .forge/results/
async function findFailedSpecs(workingDir: string): Promise<{ runId: string; specPaths: string[] }> {
  const resultsBase = path.join(workingDir, '.forge', 'results');

  let dirs: string[];
  try {
    dirs = (await fs.readdir(resultsBase)).sort().reverse(); // newest first
  } catch {
    throw new Error('No results found in .forge/results/');
  }

  // Find the latest runId by scanning summaries
  let latestRunId: string | undefined;
  for (const dir of dirs) {
    try {
      const summary: ForgeResult = JSON.parse(
        await fs.readFile(path.join(resultsBase, dir, 'summary.json'), 'utf-8')
      );
      if (summary.runId) {
        latestRunId = summary.runId;
        break;
      }
    } catch { continue; }
  }

  if (!latestRunId) {
    throw new Error('No batch runs found (no runId in results). Run with --spec-dir first.');
  }

  // Collect all results with this runId
  const failedPaths: string[] = [];
  for (const dir of dirs) {
    try {
      const summary: ForgeResult = JSON.parse(
        await fs.readFile(path.join(resultsBase, dir, 'summary.json'), 'utf-8')
      );
      if (summary.runId === latestRunId && summary.status !== 'success' && summary.specPath) {
        failedPaths.push(summary.specPath);
      }
    } catch { continue; }
  }

  return { runId: latestRunId, specPaths: failedPaths };
}

// Display status of recent runs
export async function showStatus(options: { cwd?: string; all?: boolean; last?: number }): Promise<void> {
  showBanner();
  const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const resultsBase = path.join(workingDir, '.forge', 'results');

  let dirs: string[];
  try {
    dirs = (await fs.readdir(resultsBase)).sort().reverse(); // newest first
  } catch {
    console.log('No results found.');
    return;
  }

  // Load all summaries
  const summaries: ForgeResult[] = [];
  for (const dir of dirs) {
    try {
      const summary: ForgeResult = JSON.parse(
        await fs.readFile(path.join(resultsBase, dir, 'summary.json'), 'utf-8')
      );
      summaries.push(summary);
    } catch { continue; }
  }

  if (summaries.length === 0) {
    console.log('No results found.');
    return;
  }

  // Group by runId (ungrouped specs get their own entry)
  const groups = new Map<string, ForgeResult[]>();
  for (const s of summaries) {
    const key = s.runId || s.startedAt; // Use startedAt as unique key for non-batch runs
    const arr = groups.get(key) || [];
    arr.push(s);
    groups.set(key, arr);
  }

  // Convert to array sorted by newest first
  const groupEntries = Array.from(groups.entries()).sort((a, b) => {
    const aTime = a[1][0].startedAt;
    const bTime = b[1][0].startedAt;
    return bTime.localeCompare(aTime);
  });

  // Limit display
  const limit = options.all ? groupEntries.length : (options.last || 1);
  const displayed = groupEntries.slice(0, limit);

  for (const [key, specs] of displayed) {
    const isBatch = specs.length > 1 || specs[0].runId;
    const successCount = specs.filter(s => s.status === 'success').length;
    const totalCost = specs.reduce((sum, s) => sum + (s.costUsd || 0), 0);
    const totalDuration = specs.reduce((sum, s) => sum + s.durationSeconds, 0);

    console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
    if (isBatch) {
      console.log(`Batch: ${DIM}${key.substring(0, 8)}${RESET}  |  ${specs[0].startedAt}`);
    } else {
      console.log(`Run: ${specs[0].startedAt}`);
    }
    console.log(`${DIM}${'─'.repeat(60)}${RESET}`);

    for (const s of specs) {
      const name = s.specPath ? path.basename(s.specPath) : '(no spec)';
      const statusIcon = s.status === 'success' ? '\x1B[32m✓\x1B[0m' : '\x1B[31m✗\x1B[0m';
      const cost = s.costUsd !== undefined ? `$${s.costUsd.toFixed(2)}` : '   -';
      console.log(`  ${statusIcon} ${name.padEnd(35)} ${s.durationSeconds.toFixed(0).padStart(4)}s  ${cost}`);
    }

    console.log(`\n  ${successCount}/${specs.length} successful  |  ${totalDuration.toFixed(0)}s  |  $${totalCost.toFixed(2)}`);
  }

  console.log('');
}

// Main entry point - handles single spec or spec directory
export async function runForge(options: ForgeOptions): Promise<void> {
  const { specDir, specPath, quiet, parallel, sequentialFirst = 0, rerunFailed } = options;

  if (!quiet) {
    showBanner('AI task orchestrator');
  }

  // Resolve concurrency: use provided value or auto-detect
  const concurrency = options.concurrency ?? autoDetectConcurrency();

  // Generate a unique run ID for batch grouping
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;

  // Rerun failed specs from latest batch
  if (rerunFailed) {
    const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();
    const { runId: prevRunId, specPaths: failedPaths } = await findFailedSpecs(workingDir);

    if (failedPaths.length === 0) {
      console.log('No failed specs found in latest batch. All passed!');
      return;
    }

    const failedNames = failedPaths.map(p => path.basename(p));
    if (!quiet) {
      console.log(`Rerunning ${BOLD}${failedPaths.length}${RESET} failed spec(s) from batch ${DIM}${prevRunId.substring(0, 8)}${RESET}:`);
      failedNames.forEach((f, i) => console.log(`  ${DIM}${i + 1}.${RESET} ${f}`));
      if (parallel) {
        console.log(`\nMode: parallel (concurrency: ${options.concurrency ? concurrency : `auto: ${concurrency}`})`);
      }
      console.log('');
    }

    const wallClockStart = Date.now();
    const results = await runSpecBatch(failedPaths, failedNames, options, concurrency, runId);
    const wallClockDuration = (Date.now() - wallClockStart) / 1000;

    printBatchSummary(results, wallClockDuration, parallel ?? false, quiet ?? false);
    return;
  }

  // If spec directory provided, run each spec
  if (specDir) {
    const resolvedDir = path.resolve(specDir);

    try {
      const files = await fs.readdir(resolvedDir);
      const specFiles = files
        .filter(f => f.endsWith('.md'))
        .sort(); // Alphabetical order for predictable execution

      if (specFiles.length === 0) {
        throw new Error(`No .md files found in ${resolvedDir}`);
      }

      if (!quiet) {
        const mode = parallel
          ? `parallel (concurrency: ${options.concurrency ? concurrency : `auto: ${concurrency}`})`
          : 'sequential';
        console.log(`Found ${BOLD}${specFiles.length}${RESET} specs in ${DIM}${resolvedDir}${RESET} [${mode}]:`);
        specFiles.forEach((f, i) => console.log(`  ${DIM}${i + 1}.${RESET} ${f}`));
        if (parallel && sequentialFirst > 0) {
          console.log(`\nSequential-first: ${Math.min(sequentialFirst, specFiles.length)} spec(s) run before parallel phase`);
        }
        console.log('');
      }

      const specFilePaths = specFiles.map(f => path.join(resolvedDir, f));

      const wallClockStart = Date.now();
      const results = await runSpecBatch(specFilePaths, specFiles, options, concurrency, runId);
      const wallClockDuration = (Date.now() - wallClockStart) / 1000;

      printBatchSummary(results, wallClockDuration, parallel ?? false, quiet ?? false);

      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Spec directory not found: ${resolvedDir}`);
      }
      throw err;
    }
  }

  // Single spec or no spec - run directly
  await runSingleSpec({ ...options, _runId: runId });
}

// Print batch summary with cost tracking
function printBatchSummary(
  results: { spec: string; status: string; cost?: number; duration: number }[],
  wallClockDuration: number,
  parallel: boolean,
  quiet: boolean,
): void {
  const totalSpecDuration = results.reduce((sum, r) => sum + r.duration, 0);
  const totalCost = results.reduce((sum, r) => sum + (r.cost || 0), 0);

  if (!quiet || parallel) {
    const successCount = results.filter(r => r.status === 'success').length;
    console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
    console.log(`${BOLD}SPEC BATCH SUMMARY${RESET}`);
    console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
    results.forEach(r => {
      const icon = r.status === 'success' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      const cost = r.cost !== undefined ? `$${r.cost.toFixed(2)}` : '   -';
      const statusText = r.status === 'success' ? `${DIM}success${RESET}` : `\x1b[31m${r.status}\x1b[0m`;
      console.log(`  ${icon} ${r.spec.padEnd(30)} ${r.duration.toFixed(1).padStart(6)}s  ${cost}`);
    });
    console.log(`${DIM}${'─'.repeat(60)}${RESET}`);
    console.log(`  Wall-clock: ${BOLD}${wallClockDuration.toFixed(1)}s${RESET}`);
    if (parallel) {
      console.log(`  Spec total: ${totalSpecDuration.toFixed(1)}s`);
    }
    console.log(`  Cost:       ${BOLD}$${totalCost.toFixed(2)}${RESET}`);
    console.log(`  Result:     ${successCount === results.length ? '\x1b[32m' : '\x1b[33m'}${successCount}/${results.length} successful\x1b[0m`);
  }
}
