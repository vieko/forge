import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { agents } from './agents.js';
import type { ForgeOptions, ForgeResult } from './types.js';
import { promises as fs } from 'fs';
import path from 'path';

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
  const prefix = agent ? `[${agent}]` : '[forge]';
  return `${prefix} ${message}`;
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

export async function runForge(options: ForgeOptions): Promise<void> {
  const { prompt, specPath, cwd, model = 'opus', planOnly = false, dryRun = false, verbose = false, quiet = false, resume } = options;

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

  // Read spec content if provided
  let specContent: string | undefined;
  if (specPath) {
    try {
      specContent = await fs.readFile(specPath, 'utf-8');
    } catch {
      throw new Error(`Spec file not found: ${specPath}`);
    }
  }

  // Build the prompt
  let fullPrompt = prompt;
  if (specContent) {
    fullPrompt = `## Specification\n\n${specContent}\n\n## Additional Context\n\n${prompt}`;
  }

  // Configure agent workflow
  let workflowPrompt: string;
  if (dryRun) {
    workflowPrompt = `Use the planner agent to break down this work into tasks. Do NOT implement - this is a dry run for cost estimation.

After planning, output a structured summary in this exact format:

## Tasks

[List each task with number, subject, and brief description]

## Summary

- Total tasks: [count]
- Dependencies: [describe any task dependencies]

${fullPrompt}`;
  } else if (planOnly) {
    workflowPrompt = `Use the planner agent to break down this work into tasks. Do NOT implement - planning only.\n\n${fullPrompt}`;
  } else {
    workflowPrompt = `Complete this work using the following workflow:
1. Use planner agent to decompose into tasks
2. Use worker agent to implement each task
3. Use reviewer agent to verify quality

${fullPrompt}`;
  }

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

  // Retry configuration
  const maxRetries = 3;
  const baseDelayMs = 5000; // 5 seconds, doubles each retry

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      for await (const message of sdkQuery({
      prompt: workflowPrompt,
      options: {
        cwd: workingDir,
        model: modelName,
        tools: { type: 'preset', preset: 'claude_code' },
        allowedTools: [
          'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob',
          'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet',
          'Task'  // Required for subagents
        ],
        agents,
        permissionMode: 'default',
        maxTurns: dryRun ? 20 : 50,
        maxBudgetUsd: dryRun ? 5.00 : 20.00,
        ...(resume && { resume })
      }
    })) {
      // Handle different message types
      if (message.type === 'assistant' && !quiet) {
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            // Verbose mode: show all text
            if (verbose && block.type === 'text') {
              console.log(block.text);
            }
            // Normal mode: show tool usage for progress
            if (!verbose && block.type === 'tool_use') {
              const toolName = block.name;
              const input = block.input as Record<string, unknown>;

              // Detect agent spawning
              if (toolName === 'Task') {
                const agentType = input.subagent_type as string;
                if (agentType && agentType !== currentAgent) {
                  currentAgent = agentType;
                  console.log(formatProgress(currentAgent, 'Starting...'));
                }
              }
              // Show task operations
              else if (toolName === 'TaskCreate') {
                const subject = input.subject as string;
                if (subject) {
                  console.log(formatProgress(currentAgent, `Creating task: ${subject}`));
                }
              }
              else if (toolName === 'TaskUpdate') {
                const status = input.status as string;
                if (status === 'completed') {
                  console.log(formatProgress(currentAgent, 'Task completed'));
                }
              }
              // Show file operations
              else if (toolName === 'Edit' || toolName === 'Write') {
                const filePath = input.file_path as string;
                if (filePath) {
                  const fileName = filePath.split('/').pop();
                  console.log(formatProgress(currentAgent, `Editing ${fileName}`));
                }
              }
              else if (toolName === 'Bash') {
                const cmd = input.command as string;
                if (cmd) {
                  // Show first part of command
                  const shortCmd = cmd.length > 50 ? cmd.substring(0, 47) + '...' : cmd;
                  console.log(formatProgress(currentAgent, `Running: ${shortCmd}`));
                }
              }
            }
          }
        }
      }

      if (message.type === 'result') {
        const endTime = new Date();
        const durationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;

        if (message.subtype === 'success') {
          const resultText = message.result || '';

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
            cwd: workingDir
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
          }

          // Dry run: show cost estimates (even in quiet mode, this is the point)
          if (dryRun && !quiet) {
            // Extract task count from result (look for "Total tasks: N" pattern)
            const taskCountMatch = resultText.match(/Total tasks:\s*(\d+)/i);
            const taskCount = taskCountMatch ? parseInt(taskCountMatch[1], 10) : 0;

            // Cost estimation based on observed averages:
            // - Planning: actual cost from this run
            // - Execution: ~$1.50-2.50 per task (worker + reviewer overhead)
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
  }
}
