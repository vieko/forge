import { query as sdkQuery, type HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { ForgeOptions, ForgeResult, AuditOptions, ReviewOptions } from './types.js';
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

// ── Config ───────────────────────────────────────────────────

interface ForgeConfig {
  model?: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
  verify?: string[];
}

async function loadConfig(workingDir: string): Promise<ForgeConfig> {
  try {
    const configPath = path.join(workingDir, '.forge', 'config.json');
    return JSON.parse(await fs.readFile(configPath, 'utf-8')) as ForgeConfig;
  } catch {
    return {};
  }
}

// ── ANSI Colors ──────────────────────────────────────────────
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CMD = '\x1b[36m'; // cyan — for user-facing commands
// 256-color grays — visible on both light and dark terminals
const G = [
  '\x1b[38;5;255m', // lightest
  '\x1b[38;5;251m',
  '\x1b[38;5;247m',
  '\x1b[38;5;243m', // darkest
];

const BANNER = [
  '▗▄▄▄▖ ▗▄▖ ▗▄▄▖  ▗▄▄▖▗▄▄▄▖',
  '▐▌   ▐▌ ▐▌▐▌ ▐▌▐▌   ▐▌   ',
  '▐▛▀▀▘▐▌ ▐▌▐▛▀▚▖▐▌▝▜▌▐▛▀▀▘',
  '▐▌   ▝▚▄▞▘▐▌ ▐▌▝▚▄▞▘▐▙▄▄▖',
];

function showBanner(subtitle?: string): void {
  console.log();
  BANNER.forEach((line, i) => console.log(`${G[i]}${line}${RESET}`));
  if (subtitle) {
    console.log(`\n${DIM}${subtitle}${RESET}`);
  }
  console.log();
}

// Rotating verbs for the agent spinner
const AGENT_VERBS = [
  'Working',
  'Thinking',
  'Forging',
  'Summoning',
  'Hammering',
  'Conjuring',
  'Shaping',
  'Tempering',
  'Invoking',
  'Smelting',
  'Channeling',
  'Annealing',
  'Transmuting',
  'Quenching',
  'Alloying',
];

// Single-line spinner that overwrites itself in place
// prefix: fixed left portion (e.g. "[forge]"), frame renders after it
function createInlineSpinner(prefix: string) {
  let frameIndex = 0;
  let text = '';
  let interval: ReturnType<typeof setInterval> | null = null;
  const cols = () => process.stdout.columns || 80;

  function render() {
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
    const line = `${prefix} ${CMD}${frame}${RESET}${text ? ` ${text}` : ''}`;
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
async function detectVerification(workingDir: string, configVerify?: string[]): Promise<string[]> {
  // If config specifies verify commands, use them (empty array = no verification)
  if (configVerify !== undefined) {
    return configVerify;
  }

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
async function runVerification(workingDir: string, quiet: boolean, configVerify?: string[]): Promise<{ passed: boolean; errors: string }> {
  const commands = await detectVerification(workingDir, configVerify);

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

// ── Shared SDK query core ────────────────────────────────────

// What callers pass to runQuery()
interface QueryConfig {
  prompt: string;
  workingDir: string;
  model: string;
  maxTurns: number;
  maxBudgetUsd: number;
  verbose: boolean;
  quiet: boolean;
  silent: boolean;
  onActivity?: (detail: string) => void;
  auditLogExtra?: Record<string, unknown>;
  sessionExtra?: Record<string, unknown>;
  resume?: string;
  forkSession?: boolean;
}

// What runQuery() returns on success
interface QueryResult {
  resultText: string;
  costUsd?: number;
  sessionId?: string;
  durationSeconds: number;
  numTurns?: number;
  logPath?: string;
}

// Append a timestamped line to a stream log file (fire-and-forget)
function streamLogAppend(logPath: string, message: string): void {
  fs.appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`).catch(() => {});
}

// Bash commands that are always blocked
const BLOCKED_COMMANDS: Array<{ pattern: RegExp; reason: string }> = [
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

async function runQuery(config: QueryConfig): Promise<QueryResult> {
  const {
    prompt, workingDir, model: modelName, maxTurns, maxBudgetUsd,
    verbose, quiet, silent, onActivity,
    auditLogExtra = {}, sessionExtra = {},
    resume, forkSession,
  } = config;

  const startTime = new Date();
  let sessionId: string | undefined;

  // Stream log for session visibility (fire-and-forget writes)
  // Using an object wrapper to avoid TypeScript narrowing issues with async closures
  const sessionDir = path.join(workingDir, '.forge', 'sessions');
  interface StreamLog { write: (line: string) => void; close: () => void; logPath: string }
  const streamLog: { current: StreamLog | null } = { current: null };

  // Streaming state
  let currentAgent: string | null = null;
  let currentToolName: string | null = null;
  let toolInputJson = '';
  let toolCount = 0;

  // Spinner
  const useSpinner = !silent && !verbose && !quiet;
  let agentSpinner: ReturnType<typeof createInlineSpinner> | null = null;

  // Progress mode: 'spinner' | 'verbose' | 'silent'
  const progressMode = verbose ? 'verbose' : silent ? 'silent' : 'spinner';

  // Hook: Bash command guardrails
  const bashGuardrail: HookCallback = async (input) => {
    const command = ((input as Record<string, unknown>).tool_input as Record<string, unknown>)?.command as string || '';
    for (const { pattern, reason } of BLOCKED_COMMANDS) {
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

  // Hook: Stop handler — persist session state for resume on interrupt
  const latestSessionPath = path.join(workingDir, '.forge', 'latest-session.json');
  const persistSession = async () => {
    const logPath = sessionId ? path.join(sessionDir, sessionId, 'stream.log') : undefined;
    const state = { sessionId, startedAt: startTime.toISOString(), model: modelName, cwd: workingDir, logPath, ...sessionExtra };
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
        ...auditLogExtra,
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

  // Derive activity description from a tool call
  function deriveActivity(toolName: string, input: Record<string, unknown>): string | undefined {
    if (toolName === 'Edit' || toolName === 'Write') {
      const filePath = input.file_path as string;
      if (filePath) return `${toolName === 'Write' ? 'Writing' : 'Editing'} ${filePath.split('/').pop()}`;
    } else if (toolName === 'Read') {
      const filePath = input.file_path as string;
      if (filePath) return `Reading ${filePath.split('/').pop()}`;
    } else if (toolName === 'Bash') {
      const cmd = input.command as string;
      if (cmd) {
        const shortCmd = cmd.length > 40 ? cmd.substring(0, 37) + '...' : cmd;
        return `$ ${shortCmd}`;
      }
    } else if (toolName === 'Grep') {
      const pattern = input.pattern as string;
      if (pattern) return `Grep: ${pattern.substring(0, 30)}`;
    } else if (toolName === 'Glob') {
      const pattern = input.pattern as string;
      if (pattern) return `Glob: ${pattern.substring(0, 30)}`;
    } else if (toolName === 'TaskCreate') {
      const subject = input.subject as string;
      if (subject) return `Task: ${subject.substring(0, 35)}`;
    }
    return undefined;
  }

  // Retry configuration
  const maxRetries = 3;
  const baseDelayMs = 5000; // 5 seconds, doubles each retry

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      for await (const message of sdkQuery({
        prompt,
        options: {
          cwd: workingDir,
          model: modelName,
          tools: { type: 'preset', preset: 'claude_code' },
          settingSources: ['user', 'project'],
          allowedTools: [
            'Skill', 'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob',
            'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'
          ],
          permissionMode: 'default',
          includePartialMessages: true,
          hooks: {
            PreToolUse: [{ matcher: 'Bash', hooks: [bashGuardrail] }],
            PostToolUse: [{ hooks: [auditLog] }],
            Stop: [{ hooks: [stopHandler] }],
          },
          maxTurns,
          maxBudgetUsd,
          ...(resume && { resume }),
          ...(forkSession && { forkSession: true }),
        }
      })) {
        // Capture session ID from init message
        if (message.type === 'system' && message.subtype === 'init') {
          sessionId = message.session_id;
          if (!quiet) console.log(`${DIM}[forge]${RESET} Session: ${DIM}${sessionId}${RESET}`);
          if (!quiet && forkSession && resume) console.log(`${DIM}[forge]${RESET} Forked from: ${DIM}${resume}${RESET}`);
          persistSession().catch(() => {});
          if (useSpinner && !agentSpinner) {
            agentSpinner = createInlineSpinner(`${DIM}[forge]${RESET}`);
            agentSpinner.update(`${CMD}${AGENT_VERBS[0]}...${RESET}`);
            agentSpinner.start();
          }

          // Initialize stream log for this session
          if (sessionId) {
            const logDir = path.join(sessionDir, sessionId);
            fs.mkdir(logDir, { recursive: true }).then(() => {
              const logFilePath = path.join(logDir, 'stream.log');
              fs.open(logFilePath, 'a').then(fd => {
                streamLog.current = {
                  write: (line: string) => { fd.write(line + '\n').catch(() => {}); },
                  close: () => { fd.close().catch(() => {}); },
                  logPath: logFilePath,
                };
                // Spec metadata header
                const specLabel = auditLogExtra.spec ? `, spec: ${auditLogExtra.spec}` : '';
                streamLog.current.write(`[${new Date().toISOString()}] Session started (model: ${modelName}${specLabel})`);
              }).catch(() => {});
            }).catch(() => {});
          }
        }

        // Stream real-time progress via partial messages
        if (message.type === 'stream_event' && (!quiet || onActivity)) {
          const event = message.event;

          if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
            currentToolName = event.content_block.name;
            toolInputJson = '';
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              if (progressMode === 'verbose') {
                process.stdout.write(event.delta.text);
              }
              // Log agent text blocks to stream log (reasoning visibility)
              const log = streamLog.current;
              if (log) {
                log.write(`[${new Date().toISOString()}] Text: ${event.delta.text.replace(/\n/g, '\\n')}`);
              }
            } else if (event.delta.type === 'input_json_delta') {
              toolInputJson += event.delta.partial_json;
            }
          } else if (event.type === 'content_block_stop' && currentToolName) {
            try {
              const input = JSON.parse(toolInputJson || '{}') as Record<string, unknown>;
              const activity = deriveActivity(currentToolName, input);

              if (onActivity && activity) {
                onActivity(activity);
              }

              // Write enriched entry to stream log (fire-and-forget)
              {
                const log = streamLog.current;
                if (log) {
                  const ts = `[${new Date().toISOString()}]`;
                  if (currentToolName === 'Edit' || currentToolName === 'Write') {
                    const filePath = input.file_path as string;
                    if (filePath) log.write(`${ts} ${currentToolName === 'Write' ? 'Writing' : 'Editing'} ${filePath}`);
                  } else if (currentToolName === 'Bash') {
                    const cmd = input.command as string;
                    if (cmd) log.write(`${ts} $ ${cmd}`);
                  } else if (activity) {
                    log.write(`${ts} ${activity}`);
                  }
                }
              }

              // Console output based on progress mode
              if (progressMode === 'spinner' && agentSpinner) {
                if (currentToolName === 'Task') {
                  const agentType = input.subagent_type as string;
                  const description = input.description as string;
                  if (agentType && agentType !== currentAgent) {
                    currentAgent = agentType;
                    const desc = description ? `: ${description}` : '';
                    toolCount++;
                    const verb = AGENT_VERBS[toolCount % AGENT_VERBS.length];
                    agentSpinner.update(`${CMD}${verb}...${RESET}  ${desc.substring(2)}`);
                  }
                } else if (activity) {
                  toolCount++;
                  const verb = AGENT_VERBS[toolCount % AGENT_VERBS.length];
                  agentSpinner.update(`${CMD}${verb}...${RESET}  ${activity}`);
                }
              } else if (progressMode === 'verbose') {
                if (currentToolName === 'Task') {
                  const agentType = input.subagent_type as string;
                  const description = input.description as string;
                  if (agentType && agentType !== currentAgent) {
                    currentAgent = agentType;
                    const desc = description ? `: ${description}` : '';
                    console.log(formatProgress(currentAgent, `Starting${desc}`));
                  }
                }
                // In verbose mode, text deltas already stream above
              } else if (progressMode === 'spinner' && !agentSpinner) {
                // Non-spinner fallback (quiet=false but spinner not yet started)
                if (currentToolName === 'Task') {
                  const agentType = input.subagent_type as string;
                  const description = input.description as string;
                  if (agentType && agentType !== currentAgent) {
                    currentAgent = agentType;
                    const desc = description ? `: ${description}` : '';
                    console.log(formatProgress(currentAgent, `Starting${desc}`));
                  }
                } else if (currentToolName === 'TaskCreate') {
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
              // progressMode === 'silent': no output
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
            // Log success and close stream
            const log = streamLog.current;
            if (log) {
              log.write(`[${new Date().toISOString()}] Result: success (${message.num_turns} turns, $${message.total_cost_usd?.toFixed(2) ?? 'N/A'}, ${durationSeconds.toFixed(0)}s)`);
              log.close();
            }
            return {
              resultText: message.result || '',
              costUsd: message.total_cost_usd,
              sessionId: sessionId,
              durationSeconds,
              numTurns: message.num_turns,
              logPath: streamLog.current?.logPath,
            };
          }

          // Error result (max_turns, budget, execution)
          const status: ForgeResult['status'] =
            message.subtype === 'error_max_turns' ? 'error_max_turns' :
            message.subtype === 'error_max_budget_usd' ? 'error_budget' :
            'error_execution';

          const label =
            message.subtype === 'error_max_turns' ? 'Hit maximum turns limit' :
            message.subtype === 'error_max_budget_usd' ? 'Exceeded budget limit' :
            'Execution error';

          const errors = message.errors || [];
          const errorDetail = errors.length > 0 ? errors.join('\n') : label;

          const errorResultText = `# ${label}

**Turns used**: ${message.num_turns}
**Cost**: $${message.total_cost_usd?.toFixed(4) ?? 'N/A'}
**Session**: ${message.session_id || sessionId || 'N/A'}

## Errors

${errors.length > 0 ? errors.map((e: string) => `- ${e}`).join('\n') : '_No error details from SDK._'}

## Resume

\`\`\`bash
forge run --resume ${message.session_id || sessionId} "continue"
\`\`\``;

          const forgeResult: ForgeResult = {
            startedAt: startTime.toISOString(),
            completedAt: endTime.toISOString(),
            durationSeconds,
            status,
            costUsd: message.total_cost_usd,
            prompt: config.prompt,
            model: modelName,
            cwd: workingDir,
            sessionId: message.session_id || sessionId,
            error: errorDetail,
          };

          // Log error result and close stream
          {
            const log = streamLog.current;
            if (log) {
              log.write(`[${new Date().toISOString()}] Result: ${message.subtype} (${message.num_turns} turns)`);
              log.close();
            }
          }

          await saveResult(workingDir, forgeResult, errorResultText);
          throw new ForgeError(label, forgeResult);
        }
      }
      // If we reach here without error, break out of retry loop
      break;
    } catch (error) {
      // Stop spinner if still running
      if (agentSpinner) { agentSpinner.stop(); agentSpinner = null; }

      // Log error to stream
      {
        const log = streamLog.current;
        if (log) {
          log.write(`[${new Date().toISOString()}] Error: ${error instanceof Error ? error.message : 'Unknown'}`);
        }
      }

      if (error instanceof Error && error.message.includes('not installed')) {
        streamLog.current?.close();
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
      if (error instanceof ForgeError) {
        streamLog.current?.close();
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
        prompt: config.prompt,
        model: modelName,
        cwd: workingDir,
        sessionId,
        error: errMsg,
      };
      await saveResult(workingDir, forgeResult, `Error:\n${errMsg}`).catch(() => {});
      streamLog.current?.close();
      throw new ForgeError(errMsg, forgeResult);
    }
  }

  // Should not reach here — success returns, errors throw
  streamLog.current?.close();
  throw new ForgeError('Query completed without result');
}

// ── runSingleSpec ────────────────────────────────────────────

async function runSingleSpec(options: ForgeOptions & { specContent?: string; _silent?: boolean; _onActivity?: (detail: string) => void; _runId?: string }): Promise<ForgeResult> {
  const { prompt, specPath, specContent, cwd, model, maxTurns, maxBudgetUsd, planOnly = false, dryRun = false, verbose = false, quiet = false, resume, fork, _silent = false, _onActivity, _runId } = options;
  const effectiveResume = fork || resume;
  const isFork = !!fork;

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

  // Load config and merge with defaults (CLI flags override config)
  const config = await loadConfig(workingDir);
  const effectiveModel = model || config.model || 'opus';
  const effectiveMaxTurns = maxTurns ?? config.maxTurns ?? 250;
  const effectiveMaxBudgetUsd = maxBudgetUsd ?? config.maxBudgetUsd ?? (dryRun ? 5.00 : 50.00);

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

  const modelName = effectiveModel;
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

  // Main execution + verification loop
  while (verifyAttempt < maxVerifyAttempts) {
    const qr = await runQuery({
      prompt: currentPrompt,
      workingDir,
      model: modelName,
      maxTurns: dryRun ? 20 : effectiveMaxTurns,
      maxBudgetUsd: effectiveMaxBudgetUsd,
      verbose,
      quiet,
      silent: _silent,
      onActivity: _onActivity,
      auditLogExtra: specPath ? { spec: path.basename(specPath) } : {},
      sessionExtra: { prompt, ...(isFork && { forkedFrom: fork }) },
      resume: effectiveResume,
      forkSession: isFork,
    });

    const endTime = new Date();
    const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

    // Run verification (unless dry-run or plan-only)
    if (!dryRun && !planOnly) {
      if (!quiet) console.log(`${DIM}[forge]${RESET} Running verification...`);
      if (qr.logPath) streamLogAppend(qr.logPath, 'Verify: running verification...');
      const verification = await runVerification(workingDir, quiet, config.verify);

      if (!verification.passed) {
        verifyAttempt++;
        if (qr.logPath) streamLogAppend(qr.logPath, `Verify: \u2717 failed (attempt ${verifyAttempt}/${maxVerifyAttempts})`);
        if (verifyAttempt < maxVerifyAttempts) {
          if (!quiet) {
            console.log(`\n${DIM}[forge]${RESET} \x1b[33mVerification failed\x1b[0m (attempt ${verifyAttempt}/${maxVerifyAttempts})`);
            console.log(`${DIM}[forge]${RESET} Sending errors back to agent for fixes...\n`);
          }
          // Update prompt with errors for next iteration (outcome-driven, not procedural)
          currentPrompt = `## Outcome

The codebase must pass all verification checks.

## Current State

Verification attempt ${verifyAttempt} of ${maxVerifyAttempts} failed with the errors below.

## Errors

${verification.errors}

## Acceptance Criteria

- All verification commands pass (typecheck, build, tests)
- No compilation or type errors
- All imports resolve correctly`;
          continue; // Next verification attempt
        } else {
          if (!quiet) {
            console.log(`\n${DIM}[forge]${RESET} \x1b[31mVerification failed after ${maxVerifyAttempts} attempts\x1b[0m`);
            console.log(`${DIM}[forge]${RESET} Errors:\n` + verification.errors);
          }
        }
      } else {
        if (!quiet) console.log(`${DIM}[forge]${RESET} \x1b[32mVerification passed!\x1b[0m\n`);
        if (qr.logPath) streamLogAppend(qr.logPath, 'Verify: \u2713 passed');
      }
    }

    // Save result to .forge/results/
    const forgeResult: ForgeResult = {
      startedAt: startTime.toISOString(),
      completedAt: endTime.toISOString(),
      durationSeconds,
      status: 'success',
      costUsd: qr.costUsd,
      specPath,
      prompt,
      model: modelName,
      cwd: workingDir,
      sessionId: qr.sessionId,
      forkedFrom: isFork ? fork : undefined,
      runId: _runId
    };

    const resultsDir = await saveResult(workingDir, forgeResult, qr.resultText);

    if (_silent) {
      // Silent: no output at all (parallel mode)
    } else if (quiet) {
      // Quiet mode: just show results path
      console.log(resultsDir);
    } else {
      // Display result (full, no truncation)
      console.log('\n---\nResult:\n');
      console.log(qr.resultText);

      // Display summary
      console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
      console.log(`  Duration: ${BOLD}${durationSeconds.toFixed(1)}s${RESET}`);
      if (qr.costUsd !== undefined) {
        console.log(`  Cost:     ${BOLD}$${qr.costUsd.toFixed(4)}${RESET}`);
      }
      console.log(`  Results:  ${DIM}${resultsDir}${RESET}`);
      if (qr.sessionId) {
        console.log(`  Session:  ${DIM}${qr.sessionId}${RESET}`);
        console.log(`  Resume:   ${CMD}forge run --resume ${qr.sessionId} "continue"${RESET}`);
        console.log(`  Fork:     ${CMD}forge run --fork ${qr.sessionId} "try different approach"${RESET}`);
      }
    }

    // Dry run: show cost estimates
    if (dryRun && !quiet) {
      const taskCountMatch = qr.resultText.match(/Total tasks:\s*(\d+)/i);
      const taskCount = taskCountMatch ? parseInt(taskCountMatch[1], 10) : 0;

      const planningCost = qr.costUsd || 0;
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
      console.log(`\nRun without ${CMD}--dry-run${RESET} to execute.`);
      console.log('================================');
    }

    return forgeResult;
  }

  // All verification attempts exhausted — should not normally reach here
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
  const nameWidth = Math.max(35, ...specFiles.map(f => f.length));
  let frameIndex = 0;
  let linesDrawn = 0;
  let finished = false;

  function render() {
    const cols = process.stdout.columns || 80;

    // Move cursor up to overwrite previous render (cursor is ON last line, not below it)
    if (linesDrawn > 0) {
      process.stdout.write(`\x1B[${linesDrawn}A`);
    }

    const prefixWidth = nameWidth + 14; // "X " + name + " elapsed(10)"
    const detailMax = Math.max(0, cols - prefixWidth - 4); // 4 for "  " + padding

    const lines: string[] = [];

    // Header line with rotating verb (every ~12 frames ≈ 1s)
    if (!finished) {
      const verb = AGENT_VERBS[Math.floor(frameIndex / 12) % AGENT_VERBS.length];
      lines.push(`${CMD}${verb}...${RESET}`);
    } else {
      lines.push('');
    }

    for (const s of states) {
      const padName = s.name.padEnd(nameWidth);
      switch (s.status) {
        case 'waiting':
          lines.push(`  ${padName} ${DIM}waiting${RESET}`);
          break;
        case 'running': {
          const elapsed = formatElapsed(Date.now() - s.startedAt!);
          const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
          const detail = s.detail && detailMax > 5
            ? `  ${DIM}${s.detail.substring(0, detailMax)}${RESET}`
            : '';
          lines.push(`${CMD}${frame}${RESET} ${padName} ${elapsed}${detail}`);
          break;
        }
        case 'success':
          lines.push(`\x1B[32m✓\x1B[0m ${padName} \x1B[32m${formatElapsed(s.duration! * 1000)}\x1B[0m`);
          break;
        case 'failed': {
          const errMax = Math.max(0, cols - prefixWidth - 10); // "failed" + spacing
          const errDetail = s.error && errMax > 5
            ? `  ${DIM}${s.error.substring(0, errMax)}${RESET}`
            : '';
          lines.push(`\x1B[31m✗\x1B[0m ${padName} \x1B[31mfailed\x1B[0m${errDetail}`);
          break;
        }
      }
    }

    // Clear and write each line; no trailing \n on last line to prevent scroll
    for (let i = 0; i < lines.length; i++) {
      const eol = i < lines.length - 1 ? '\n' : '';
      process.stdout.write(`\x1B[2K\r${lines[i]}${eol}`);
    }
    linesDrawn = lines.length - 1; // cursor is ON last line, move up N-1 to reach first
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
      finished = true;
      clearInterval(interval);
      render(); // Final render
      process.stdout.write('\n'); // Move below display for subsequent output
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
    showBanner('SHAPED BY PROMPTS ▲ TEMPERED BY FIRE.');
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
      console.log(`Rerunning ${BOLD}${failedPaths.length}${RESET} failed spec(s) from batch ${DIM}${prevRunId.substring(0, 8)}${RESET}`);
      if (!parallel) {
        failedNames.forEach((f, i) => console.log(`  ${DIM}${i + 1}.${RESET} ${f}`));
      }
      if (parallel) {
        console.log(`${DIM}[parallel (concurrency: ${options.concurrency ? concurrency : `auto: ${concurrency}`})]${RESET}`);
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
        console.log(`Found ${BOLD}${specFiles.length}${RESET} specs in ${DIM}${resolvedDir}${RESET}`);
        console.log(`${DIM}[${mode}]${RESET}\n`);
        if (!parallel) {
          specFiles.forEach((f, i) => console.log(`  ${DIM}${i + 1}.${RESET} ${f}`));
          console.log('');
        }
        if (parallel && sequentialFirst > 0) {
          console.log(`Sequential-first: ${Math.min(sequentialFirst, specFiles.length)} spec(s) run before parallel phase\n`);
        }
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

// ── Watch ────────────────────────────────────────────────────

export interface WatchOptions {
  sessionId?: string;
  cwd?: string;
}

// ANSI color helpers for watch output
function colorWatchLine(line: string): string {
  // Extract the content after the timestamp prefix
  const match = line.match(/^\[([^\]]+)\]\s(.*)$/);
  if (!match) return line;

  const ts = match[1];
  const content = match[2];
  const shortTs = ts.substring(11, 19); // HH:MM:SS from ISO string

  // Session started
  if (content.startsWith('Session started')) {
    return `${DIM}${shortTs}${RESET} ${BOLD}${content}${RESET}`;
  }

  // Result line
  if (content.startsWith('Result:')) {
    return `${DIM}${shortTs}${RESET} ${BOLD}${content}${RESET}`;
  }

  // Verify lines
  if (content.startsWith('Verify:')) {
    if (content.includes('\u2713') || content.includes('passed')) {
      return `${DIM}${shortTs}${RESET} \x1b[32m${content}\x1b[0m`;
    }
    if (content.includes('\u2717') || content.includes('failed')) {
      return `${DIM}${shortTs}${RESET} \x1b[31m${content}\x1b[0m`;
    }
    return `${DIM}${shortTs}${RESET} ${content}`;
  }

  // Edit/Write — yellow filename
  if (content.startsWith('Editing ') || content.startsWith('Writing ')) {
    return `${DIM}${shortTs}${RESET} \x1b[33m${content}\x1b[0m`;
  }

  // Bash commands — cyan
  if (content.startsWith('$ ')) {
    return `${DIM}${shortTs}${RESET} ${CMD}${content}${RESET}`;
  }

  // Read/Grep/Glob — dim
  if (content.startsWith('Reading ') || content.startsWith('Grep:') || content.startsWith('Glob:')) {
    return `${DIM}${shortTs} ${content}${RESET}`;
  }

  // Text blocks — dim (agent reasoning)
  if (content.startsWith('Text: ')) {
    return `${DIM}${shortTs} ${content.substring(6)}${RESET}`;
  }

  // Error
  if (content.startsWith('Error:')) {
    return `${DIM}${shortTs}${RESET} \x1b[31m${content}\x1b[0m`;
  }

  // Default
  return `${DIM}${shortTs}${RESET} ${content}`;
}

export async function runWatch(options: WatchOptions): Promise<void> {
  const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd();
  let logPath: string;

  if (options.sessionId) {
    // Watch a specific session
    logPath = path.join(workingDir, '.forge', 'sessions', options.sessionId, 'stream.log');
  } else {
    // Watch latest session
    const latestPath = path.join(workingDir, '.forge', 'latest-session.json');
    try {
      const data = JSON.parse(await fs.readFile(latestPath, 'utf-8'));
      if (data.logPath) {
        logPath = data.logPath;
      } else if (data.sessionId) {
        logPath = path.join(workingDir, '.forge', 'sessions', data.sessionId, 'stream.log');
      } else {
        console.error('No session found. Start a run first: forge run "task"');
        process.exit(1);
      }
    } catch {
      console.error('No session found. Start a run first: forge run "task"');
      process.exit(1);
    }
  }

  // Wait for the log file to exist (may not be created yet if watching a new run)
  let waitAttempts = 0;
  const maxWait = 300; // 30 seconds at 100ms intervals
  while (waitAttempts < maxWait) {
    try {
      await fs.access(logPath);
      break;
    } catch {
      waitAttempts++;
      if (waitAttempts === 1) {
        console.log(`${DIM}Waiting for session log...${RESET}`);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  if (waitAttempts >= maxWait) {
    console.error(`Timed out waiting for log file: ${logPath}`);
    process.exit(1);
  }

  // Extract session ID from path for header
  const sessionId = options.sessionId || path.basename(path.dirname(logPath));
  console.log(`${DIM}Watching session ${sessionId} — Ctrl+C to detach${RESET}\n`);

  // Read existing content and tail for new lines
  let position = 0;
  let sessionComplete = false;

  async function readNewLines(): Promise<void> {
    try {
      const content = await fs.readFile(logPath, 'utf-8');
      if (content.length > position) {
        const newContent = content.substring(position);
        const lines = newContent.split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          console.log(colorWatchLine(line));

          // Check for session completion
          if (line.includes('Result:')) {
            sessionComplete = true;
          }
        }
        position = content.length;
      }
    } catch {
      // File may be briefly unavailable during writes
    }
  }

  // Initial read
  await readNewLines();

  if (sessionComplete) {
    console.log(`\n${DIM}Session complete.${RESET}`);
    return;
  }

  // Tail with fs.watch + periodic poll as fallback
  const pollInterval = setInterval(readNewLines, 100);

  let watcher: ReturnType<typeof import('fs').watch> | null = null;
  try {
    const fsSync = await import('fs');
    watcher = fsSync.watch(logPath, () => {
      readNewLines();
    });
  } catch {
    // fs.watch not available, rely on polling
  }

  // Wait for completion or SIGINT
  await new Promise<void>(resolve => {
    const checkComplete = setInterval(() => {
      if (sessionComplete) {
        clearInterval(checkComplete);
        resolve();
      }
    }, 200);

    process.on('SIGINT', () => {
      clearInterval(checkComplete);
      resolve();
    });
  });

  // Cleanup
  clearInterval(pollInterval);
  if (watcher) watcher.close();

  if (sessionComplete) {
    console.log(`\n${DIM}Session complete.${RESET}`);
  }
}

// ── Audit ───────────────────────────────────────────────────

// Internal exports for testing — not part of public API
export { isTransientError, formatElapsed, formatProgress, autoDetectConcurrency };

export async function runAudit(options: AuditOptions): Promise<void> {
  const { specDir, prompt, model, maxTurns, maxBudgetUsd, verbose = false, quiet = false, resume, fork } = options;
  const effectiveResume = fork || resume;
  const isFork = !!fork;

  if (!quiet) {
    showBanner('SHAPED BY PROMPTS ▲ TEMPERED BY FIRE.');
  }

  // Resolve working directory
  const workingDir = options.cwd ? (await fs.realpath(options.cwd)) : process.cwd();

  // Validate working directory
  try {
    const stat = await fs.stat(workingDir);
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${workingDir}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Directory not found: ${workingDir}`);
    throw err;
  }

  // Load config and merge with defaults (CLI flags override config)
  const config = await loadConfig(workingDir);
  const effectiveModel = model || config.model || 'opus';
  const effectiveMaxTurns = maxTurns ?? config.maxTurns ?? 250;
  const effectiveMaxBudgetUsd = maxBudgetUsd ?? config.maxBudgetUsd ?? 10.00;

  // Read all .md files from specDir
  const resolvedSpecDir = path.resolve(specDir);
  let specFiles: string[];
  try {
    const files = await fs.readdir(resolvedSpecDir);
    specFiles = files.filter(f => f.endsWith('.md')).sort();
  } catch {
    throw new Error(`Spec directory not found: ${resolvedSpecDir}`);
  }

  if (specFiles.length === 0) {
    throw new Error(`No .md files found in ${resolvedSpecDir}`);
  }

  // Concatenate spec contents with filename headers
  const specContents: string[] = [];
  for (const file of specFiles) {
    const content = await fs.readFile(path.join(resolvedSpecDir, file), 'utf-8');
    specContents.push(`### ${file}\n\n${content}`);
  }
  const allSpecContents = specContents.join('\n\n---\n\n');

  // Resolve output directory
  const outputDir = options.outputDir
    ? path.resolve(options.outputDir)
    : path.join(resolvedSpecDir, 'audit');

  // Warn if output dir is non-empty
  try {
    const existing = await fs.readdir(outputDir);
    if (existing.length > 0 && !quiet) {
      console.log(`\x1b[33m[forge]\x1b[0m Output directory is non-empty: ${outputDir}`);
      console.log(`${DIM}[forge]${RESET} Existing files may be overwritten. Use ${CMD}--output-dir${RESET} to write elsewhere.\n`);
    }
  } catch {
    // Directory doesn't exist yet — that's fine
  }

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  if (!quiet) {
    console.log(`${DIM}Specs:${RESET}      ${specFiles.length} file(s) from ${DIM}${resolvedSpecDir}${RESET}`);
    console.log(`${DIM}Output:${RESET}     ${DIM}${outputDir}${RESET}`);
    console.log(`${DIM}Working dir:${RESET} ${workingDir}\n`);
  }

  // Construct audit prompt
  const auditPrompt = `## Outcome

Audit the codebase against the specifications below. For any work that
remains incomplete, unimplemented, or incorrect, produce new spec files
in ${outputDir}/.

Each output spec must be:
- A self-contained .md file that Forge can execute independently
- Named descriptively (e.g., fix-auth-token-refresh.md)
- Focused on a single concern
- Written as an outcome, not a procedure

## Specifications

${allSpecContents}

${prompt ? `## Additional Context\n\n${prompt}\n` : ''}
## Acceptance Criteria

- Every spec reviewed against the current codebase
- All gaps, bugs, and incomplete work captured as new specs
- Each new spec is actionable and independently executable
- If fully implemented, produce no output specs
- Output specs written to: ${outputDir}/`;

  const startTime = new Date();

  if (!quiet && isFork && effectiveResume) {
    console.log(`${DIM}[forge]${RESET} Forking from: ${DIM}${effectiveResume}${RESET}`);
  }

  const qr = await runQuery({
    prompt: auditPrompt,
    workingDir,
    model: effectiveModel,
    maxTurns: effectiveMaxTurns,
    maxBudgetUsd: effectiveMaxBudgetUsd,
    verbose,
    quiet,
    silent: false,
    auditLogExtra: { type: 'audit' },
    sessionExtra: { type: 'audit', ...(isFork && { forkedFrom: fork }) },
    resume: effectiveResume,
    forkSession: isFork,
  });

  const endTime = new Date();
  const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

  const forgeResult: ForgeResult = {
    startedAt: startTime.toISOString(),
    completedAt: endTime.toISOString(),
    durationSeconds,
    status: 'success',
    costUsd: qr.costUsd,
    prompt: '(audit)',
    model: effectiveModel,
    cwd: workingDir,
    sessionId: qr.sessionId,
    forkedFrom: isFork ? fork : undefined,
    type: 'audit',
  };

  await saveResult(workingDir, forgeResult, qr.resultText);

  // Post-query: list generated spec files
  let outputSpecs: string[] = [];
  try {
    const files = await fs.readdir(outputDir);
    outputSpecs = files.filter(f => f.endsWith('.md')).sort();
  } catch {}

  if (!quiet) {
    console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
    console.log(`  Duration: ${BOLD}${durationSeconds.toFixed(1)}s${RESET}`);
    if (qr.costUsd !== undefined) {
      console.log(`  Cost:     ${BOLD}$${qr.costUsd.toFixed(4)}${RESET}`);
    }

    if (outputSpecs.length === 0) {
      console.log(`\n  \x1b[32mAll specs fully implemented — no remaining work.\x1b[0m`);
    } else {
      console.log(`\n  ${BOLD}${outputSpecs.length}${RESET} spec(s) generated in ${DIM}${outputDir}${RESET}:\n`);
      outputSpecs.forEach((f, i) => console.log(`    ${DIM}${i + 1}.${RESET} ${f}`));
      console.log(`\n  Next step:\n    ${CMD}forge run --spec-dir ${outputDir} -C ${workingDir} "implement remaining work"${RESET}`);
    }
    console.log('');
  }
}

// ── Review ──────────────────────────────────────────────────

export async function runReview(options: ReviewOptions): Promise<void> {
  const { diff, model, maxTurns, maxBudgetUsd, verbose = false, quiet = false, dryRun = false, output } = options;

  if (!quiet) {
    showBanner('SHAPED BY PROMPTS ▲ TEMPERED BY FIRE.');
  }

  // Resolve working directory
  const workingDir = options.cwd ? (await fs.realpath(options.cwd)) : process.cwd();

  // Validate working directory
  try {
    const stat = await fs.stat(workingDir);
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${workingDir}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Directory not found: ${workingDir}`);
    throw err;
  }

  // Check if it's a git repository
  try {
    await execAsync('git rev-parse --git-dir', { cwd: workingDir });
  } catch {
    throw new Error('Not a git repository');
  }

  // Load config and merge with defaults (CLI flags override config)
  const config = await loadConfig(workingDir);
  const effectiveModel = model || config.model || 'sonnet';
  const effectiveMaxTurns = maxTurns ?? config.maxTurns ?? 50;
  const effectiveMaxBudgetUsd = maxBudgetUsd ?? config.maxBudgetUsd ?? 10.00;

  // Determine diff range
  let diffRange = diff;
  if (!diffRange) {
    // Auto-detect main branch (main or master)
    try {
      await execAsync('git rev-parse --verify main', { cwd: workingDir });
      diffRange = 'main...HEAD';
    } catch {
      try {
        await execAsync('git rev-parse --verify master', { cwd: workingDir });
        diffRange = 'master...HEAD';
      } catch {
        // Check for detached HEAD
        try {
          const { stdout: headRef } = await execAsync('git symbolic-ref HEAD', { cwd: workingDir });
          if (!headRef.trim()) {
            throw new Error('Detached HEAD: specify a diff range (e.g., HEAD~10...HEAD) or checkout a branch');
          }
        } catch {
          throw new Error('Detached HEAD: specify a diff range (e.g., HEAD~10...HEAD) or checkout a branch');
        }
        throw new Error('Neither main nor master branch exists. Specify a diff range explicitly.');
      }
    }
  }

  // Generate git diff
  let diffOutput: string;
  try {
    const { stdout } = await execAsync(`git diff ${diffRange}`, { cwd: workingDir, maxBuffer: 10 * 1024 * 1024 });
    diffOutput = stdout;
  } catch (err) {
    throw new Error(`Failed to generate diff: ${err instanceof Error ? err.message : 'Unknown error'}`);
  }

  // Handle empty diff
  if (!diffOutput.trim()) {
    if (!quiet) {
      console.log('No changes to review.');
    }
    return;
  }

  // Truncate very large diffs to stay within context limits (~50KB)
  const MAX_DIFF_SIZE = 50 * 1024;
  let truncationNote = '';
  if (diffOutput.length > MAX_DIFF_SIZE) {
    diffOutput = diffOutput.substring(0, MAX_DIFF_SIZE);
    truncationNote = '\n\n**Note**: Diff was truncated to ~50KB. Some changes may not be reviewed.';
  }

  if (!quiet) {
    console.log(`${DIM}Diff:${RESET}        ${diffRange}`);
    console.log(`${DIM}Working dir:${RESET} ${workingDir}`);
    if (dryRun) {
      console.log(`${DIM}Mode:${RESET}        dry-run (report only, no fixes applied)`);
    }
    console.log('');
  }

  // Construct review prompt
  const reviewPrompt = `## Outcome

Review the code changes below for quality issues, bugs, and blindspots.
Categorize each finding by recommended action.

## Changes

\`\`\`diff
${diffOutput}
\`\`\`${truncationNote}

## Finding Categories

- **Fix Now**: Trivial effort, clear fix — apply the fix directly${dryRun ? ' (dry-run: describe fix only, do not apply)' : ''}
- **Needs Spec**: Important but requires planning — describe what spec should cover
- **Note**: Observation or suggestion, no action required

## Acceptance Criteria

- Every changed file reviewed
- Each finding references specific file and line
- Each finding has a category, description, and rationale
- Fix Now items are ${dryRun ? 'described' : 'applied'} inline
- Output format is a clean markdown list grouped by category`;

  const startTime = new Date();

  const qr = await runQuery({
    prompt: reviewPrompt,
    workingDir,
    model: effectiveModel,
    maxTurns: effectiveMaxTurns,
    maxBudgetUsd: effectiveMaxBudgetUsd,
    verbose,
    quiet,
    silent: false,
    auditLogExtra: { type: 'review' },
    sessionExtra: { type: 'review' },
  });

  const endTime = new Date();
  const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

  const forgeResult: ForgeResult = {
    startedAt: startTime.toISOString(),
    completedAt: endTime.toISOString(),
    durationSeconds,
    status: 'success',
    costUsd: qr.costUsd,
    prompt: `(review: ${diffRange})`,
    model: effectiveModel,
    cwd: workingDir,
    sessionId: qr.sessionId,
    type: 'run', // Using 'run' since review modifies code (Fix Now items)
  };

  await saveResult(workingDir, forgeResult, qr.resultText);

  // Write findings to file if requested
  if (output) {
    const outputPath = path.resolve(output);
    await fs.writeFile(outputPath, qr.resultText);
    if (!quiet) {
      console.log(`\n${DIM}[forge]${RESET} Findings written to: ${DIM}${outputPath}${RESET}`);
    }
  }

  if (!quiet) {
    console.log(`\n${DIM}${'─'.repeat(60)}${RESET}`);
    console.log(`  Duration: ${BOLD}${durationSeconds.toFixed(1)}s${RESET}`);
    if (qr.costUsd !== undefined) {
      console.log(`  Cost:     ${BOLD}$${qr.costUsd.toFixed(4)}${RESET}`);
    }
    if (qr.sessionId) {
      console.log(`  Session:  ${DIM}${qr.sessionId}${RESET}`);
    }
    console.log('');
  }
}
