import { query as sdkQuery, type HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { ForgeResult } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { ForgeError, isTransientError, sleep, saveResult } from './utils.js';
import { DIM, RESET, CMD, AGENT_VERBS, createInlineSpinner, formatProgress } from './display.js';

// What callers pass to runQuery()
export interface QueryConfig {
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
export interface QueryResult {
  resultText: string;
  costUsd?: number;
  sessionId?: string;
  durationSeconds: number;
  numTurns?: number;
  logPath?: string;
}

// Append a timestamped line to a stream log file (fire-and-forget)
export function streamLogAppend(logPath: string, message: string): void {
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

export async function runQuery(config: QueryConfig): Promise<QueryResult> {
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
  let textDeltaBuffer = ''; // Accumulate text deltas for batched logging

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
  let forgeDirCreated = false;
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
      if (!forgeDirCreated) {
        await fs.mkdir(path.join(workingDir, '.forge'), { recursive: true });
        forgeDirCreated = true;
      }
      await fs.appendFile(auditPath, JSON.stringify(entry) + '\n');
    } catch {
      // Never crash on audit failures
    }
    return {};
  };

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

          if (event.type === 'content_block_start') {
            if (event.content_block.type === 'tool_use') {
              currentToolName = event.content_block.name;
              toolInputJson = '';
            } else if (event.content_block.type === 'text') {
              textDeltaBuffer = ''; // Reset buffer for new text block
            }
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              if (progressMode === 'verbose') {
                process.stdout.write(event.delta.text);
              }
              // Accumulate text deltas (logged at content_block_stop)
              textDeltaBuffer += event.delta.text;
            } else if (event.delta.type === 'input_json_delta') {
              toolInputJson += event.delta.partial_json;
            }
          } else if (event.type === 'content_block_stop') {
            // Flush accumulated text delta buffer to stream log
            if (textDeltaBuffer) {
              const log = streamLog.current;
              if (log) {
                log.write(`[${new Date().toISOString()}] Text: ${textDeltaBuffer.replace(/\n/g, '\\n')}`);
              }
              textDeltaBuffer = '';
            }

            if (!currentToolName) continue; // No tool to process
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
                    toolCount++;
                    const verb = AGENT_VERBS[toolCount % AGENT_VERBS.length];
                    agentSpinner.update(`${CMD}${verb}...${RESET}  ${description || ''}`);
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
