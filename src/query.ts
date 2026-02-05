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

export async function runForge(options: ForgeOptions): Promise<void> {
  const { prompt, specPath, cwd, model = 'opus', planOnly = false, verbose = false, resume } = options;

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
  const workflowPrompt = planOnly
    ? `Use the planner agent to break down this work into tasks. Do NOT implement - planning only.\n\n${fullPrompt}`
    : `Complete this work using the following workflow:
1. Use planner agent to decompose into tasks
2. Use worker agent to implement each task
3. Use reviewer agent to verify quality

${fullPrompt}`;

  // SDK accepts shorthand model names
  const modelName = model;

  // Track timing
  const startTime = new Date();

  // Run the query
  if (cwd) {
    console.log(`Working directory: ${workingDir}`);
  }
  console.log('Starting Forge...\n');

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
        maxTurns: 50,
        maxBudgetUsd: 20.00,
        ...(resume && { resume })
      }
    })) {
      // Handle different message types
      if (verbose && message.type === 'assistant') {
        // Show assistant messages in verbose mode
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              console.log(block.text);
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
  } catch (error) {
    if (error instanceof Error && error.message.includes('not installed')) {
      console.error('Agent SDK not properly installed. Run: bun install @anthropic-ai/claude-agent-sdk');
      process.exit(1);
    }
    throw error;
  }
}
