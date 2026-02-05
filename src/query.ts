import { query as sdkQuery, type HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { ForgeOptions, ForgeResult } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
  return `[${name}] ${message}`;
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
    if (!quiet) console.log('[Verify] No verification commands detected');
    return { passed: true, errors: '' };
  }

  const errors: string[] = [];

  for (const cmd of commands) {
    if (!quiet) console.log(`[Verify] Running: ${cmd}`);
    try {
      await execAsync(cmd, { cwd: workingDir, timeout: 120000 });
      if (!quiet) console.log(`[Verify] ✓ ${cmd}`);
    } catch (err) {
      const error = err as { stderr?: string; stdout?: string; message?: string };
      const errorOutput = error.stderr || error.stdout || error.message || 'Unknown error';
      errors.push(`Command failed: ${cmd}\n${errorOutput}`);
      if (!quiet) console.log(`[Verify] ✗ ${cmd}`);
    }
  }

  return {
    passed: errors.length === 0,
    errors: errors.join('\n\n')
  };
}

// Run a single spec
async function runSingleSpec(options: ForgeOptions & { specContent?: string }): Promise<void> {
  const { prompt, specPath, specContent, cwd, model = 'opus', maxTurns = 100, planOnly = false, dryRun = false, verbose = false, quiet = false, resume } = options;

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
      console.log(`Working directory: ${workingDir}`);
    }
    if (dryRun) {
      console.log('Starting Forge (dry run - planning only)...\n');
    } else {
      console.log('Starting Forge...\n');
    }
  }

  // Track current agent for progress output
  let currentAgent: string | null = null;
  // Streaming state
  let currentToolName: string | null = null;
  let toolInputJson = '';
  // Session tracking
  let sessionId: string | undefined;

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
        if (!quiet) console.log(`[forge] Blocked: ${reason}`);
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

  // Hook: Tool call audit log
  const auditPath = path.join(workingDir, '.forge', 'audit.jsonl');
  const auditLog: HookCallback = async (input, toolUseID) => {
    try {
      const inp = input as Record<string, unknown>;
      const entry = {
        ts: new Date().toISOString(),
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
        },
        maxTurns: dryRun ? 20 : maxTurns,
        maxBudgetUsd: dryRun ? 5.00 : 50.00,
        ...(resume && { resume })
      }
    })) {
      // Capture session ID from init message
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = message.session_id;
        if (!quiet) console.log(`[forge] Session: ${sessionId}`);
      }

      // Stream real-time progress via partial messages
      if (message.type === 'stream_event' && !quiet) {
        const event = message.event;

        if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
          currentToolName = event.content_block.name;
          toolInputJson = '';
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta' && verbose) {
            process.stdout.write(event.delta.text);
          } else if (event.delta.type === 'input_json_delta') {
            toolInputJson += event.delta.partial_json;
          }
        } else if (event.type === 'content_block_stop' && currentToolName) {
          try {
            const input = JSON.parse(toolInputJson || '{}') as Record<string, unknown>;

            // Track agent changes (both modes)
            if (currentToolName === 'Task') {
              const agentType = input.subagent_type as string;
              const description = input.description as string;
              if (agentType && agentType !== currentAgent) {
                currentAgent = agentType;
                const desc = description ? `: ${description}` : '';
                console.log(formatProgress(currentAgent, `Starting${desc}`));
              }
            }
            // Normal mode: show tool progress
            else if (!verbose) {
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
          } catch {
            // JSON parse failed - skip progress for this tool
          }
          currentToolName = null;
          toolInputJson = '';
        }
      }

      if (message.type === 'result') {
        const endTime = new Date();
        const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

        if (message.subtype === 'success') {
          const resultText = message.result || '';

          // Run verification (unless dry-run or plan-only)
          if (!dryRun && !planOnly) {
            if (!quiet) console.log('\n[forge] Running verification...');
            const verification = await runVerification(workingDir, quiet);

            if (!verification.passed) {
              verifyAttempt++;
              if (verifyAttempt < maxVerifyAttempts) {
                if (!quiet) {
                  console.log(`\n[forge] Verification failed (attempt ${verifyAttempt}/${maxVerifyAttempts})`);
                  console.log('[forge] Sending errors back to agent for fixes...\n');
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
                  console.log(`\n[forge] Verification failed after ${maxVerifyAttempts} attempts`);
                  console.log('[forge] Errors:\n' + verification.errors);
                }
              }
            } else {
              if (!quiet) console.log('[forge] Verification passed!\n');
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
            sessionId
          };

          const resultsDir = await saveResult(workingDir, forgeResult, resultText);

          if (quiet) {
            // Quiet mode: just show results path
            console.log(resultsDir);
          } else {
            // Display result (full, no truncation)
            console.log('\n---\nResult:\n');
            console.log(resultText);

            // Display summary
            console.log('\n---');
            console.log(`Duration: ${durationSeconds.toFixed(1)}s`);
            if (message.total_cost_usd !== undefined) {
              console.log(`Cost: $${message.total_cost_usd.toFixed(4)}`);
            }
            console.log(`Results saved: ${resultsDir}`);
            if (sessionId) {
              console.log(`Session: ${sessionId}`);
              console.log(`Resume: forge run --resume ${sessionId} "continue"`);
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
          return;
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
            error: errorText
          };

          await saveResult(workingDir, forgeResult, `Error:\n${errorText}`);

          console.error('\nExecution failed:', message.errors);
          process.exit(1);
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
            error: 'Hit maximum turns limit'
          };

          await saveResult(workingDir, forgeResult, 'Error: Hit maximum turns limit');

          console.error('\nHit maximum turns limit');
          process.exit(1);
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
            error: 'Exceeded budget limit'
          };

          await saveResult(workingDir, forgeResult, 'Error: Exceeded budget limit');

          console.error('\nExceeded budget limit');
          process.exit(1);
        }
      }
    }
    // If we reach here without error, break out of retry loop
    break;
  } catch (error) {
    if (error instanceof Error && error.message.includes('not installed')) {
      console.error('Agent SDK not properly installed. Run: bun install @anthropic-ai/claude-agent-sdk');
      process.exit(1);
    }

    // Check if error is transient and we have retries left
    if (isTransientError(error) && attempt < maxRetries) {
      const delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      if (!quiet) {
        console.log(`\n[forge] Transient error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        console.log(`[forge] Retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
      }
      await sleep(delayMs);
      continue;
    }

    // Non-transient error or out of retries
    throw error;
  }
  } // end retry loop
  } // end verification loop
}

// Main entry point - handles single spec or spec directory
export async function runForge(options: ForgeOptions): Promise<void> {
  const { specDir, specPath, quiet } = options;

  // If spec directory provided, run each spec sequentially
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
        console.log(`Found ${specFiles.length} specs in ${resolvedDir}:`);
        specFiles.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
        console.log('');
      }

      let totalCost = 0;
      let totalDuration = 0;
      const results: { spec: string; status: string; cost?: number; duration: number }[] = [];

      for (let i = 0; i < specFiles.length; i++) {
        const specFile = specFiles[i];
        const specFilePath = path.join(resolvedDir, specFile);

        if (!quiet) {
          console.log(`\n${'='.repeat(60)}`);
          console.log(`Running spec ${i + 1}/${specFiles.length}: ${specFile}`);
          console.log(`${'='.repeat(60)}\n`);
        }

        const startTime = Date.now();
        try {
          // Read spec content
          const specContent = await fs.readFile(specFilePath, 'utf-8');

          // Run with spec content directly
          await runSingleSpec({
            ...options,
            specPath: specFilePath,
            specContent,
            specDir: undefined, // Don't recurse
          });

          const duration = (Date.now() - startTime) / 1000;
          totalDuration += duration;
          results.push({ spec: specFile, status: 'success', duration });
        } catch (err) {
          const duration = (Date.now() - startTime) / 1000;
          totalDuration += duration;
          results.push({
            spec: specFile,
            status: `failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
            duration
          });

          if (!quiet) {
            console.error(`\nSpec ${specFile} failed:`, err instanceof Error ? err.message : err);
            console.log('Continuing with next spec...\n');
          }
        }
      }

      // Summary
      if (!quiet) {
        console.log(`\n${'='.repeat(60)}`);
        console.log('SPEC DIRECTORY SUMMARY');
        console.log(`${'='.repeat(60)}`);
        results.forEach(r => {
          console.log(`  ${r.spec}: ${r.status} (${r.duration.toFixed(1)}s)`);
        });
        console.log(`\nTotal duration: ${totalDuration.toFixed(1)}s`);
        console.log(`Successful: ${results.filter(r => r.status === 'success').length}/${results.length}`);
      }

      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Spec directory not found: ${resolvedDir}`);
      }
      throw err;
    }
  }

  // Single spec or no spec - run directly
  await runSingleSpec(options);
}
