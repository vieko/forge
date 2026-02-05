import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { agents } from './agents.js';
import type { ForgeOptions } from './types.js';
import { promises as fs } from 'fs';

export async function runForge(options: ForgeOptions): Promise<void> {
  const { prompt, specPath, model = 'opus', planOnly = false, verbose = false } = options;

  // Validate spec file exists if provided
  if (specPath) {
    try {
      await fs.access(specPath);
    } catch {
      throw new Error(`Spec file not found: ${specPath}`);
    }
  }

  // Build the prompt
  let fullPrompt = prompt;
  if (specPath) {
    fullPrompt = `Read the spec at ${specPath} and implement it.\n\nAdditional context: ${prompt}`;
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

  // Run the query
  console.log('Starting Forge...\n');

  try {
    for await (const message of sdkQuery({
      prompt: workflowPrompt,
      options: {
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
        maxBudgetUsd: 20.00
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
        if (message.subtype === 'success') {
          console.log('\n---\nResult:\n');
          console.log(message.result);
          if (message.total_cost_usd !== undefined) {
            console.log(`\nCost: $${message.total_cost_usd.toFixed(4)}`);
          }
        } else if (message.subtype === 'error_during_execution') {
          console.error('\nExecution failed:', message.errors);
          process.exit(1);
        } else if (message.subtype === 'error_max_turns') {
          console.error('\nHit maximum turns limit');
          process.exit(1);
        } else if (message.subtype === 'error_max_budget_usd') {
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
