#!/usr/bin/env node

import { program } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';
import { runForge } from './query.js';

program
  .name('forge')
  .description('AI task orchestrator built on Anthropic Agent SDK')
  .version('2.0.0');

program
  .command('run')
  .description('Run a task with AI agents')
  .argument('<prompt>', 'The task to accomplish')
  .option('-s, --spec <path>', 'Path to spec file (.md)')
  .option('-S, --spec-dir <path>', 'Path to specs directory (runs each .md sequentially)')
  .option('-C, --cwd <path>', 'Working directory (target repo)')
  .option('-m, --model <model>', 'Model to use (opus, sonnet, or full model ID)', 'opus')
  .option('-t, --max-turns <n>', 'Maximum turns per spec (default: 100)', '100')
  .option('--plan-only', 'Only create tasks, do not implement')
  .option('--dry-run', 'Preview tasks and estimate cost without executing')
  .option('-v, --verbose', 'Show detailed output')
  .option('-q, --quiet', 'Suppress progress output (for CI)')
  .option('-r, --resume <session>', 'Resume a previous session')
  .action(async (prompt: string, options: {
    spec?: string;
    specDir?: string;
    cwd?: string;
    model?: string;
    maxTurns?: string;
    planOnly?: boolean;
    dryRun?: boolean;
    verbose?: boolean;
    quiet?: boolean;
    resume?: string;
  }) => {
    try {
      await runForge({
        prompt,
        specPath: options.spec,
        specDir: options.specDir,
        cwd: options.cwd,
        model: options.model,
        maxTurns: options.maxTurns ? parseInt(options.maxTurns, 10) : 100,
        planOnly: options.planOnly,
        dryRun: options.dryRun,
        verbose: options.verbose,
        quiet: options.quiet,
        resume: options.resume
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Quick alias: `forge "do something"` = `forge run "do something"`
const args = process.argv.slice(2);
if (args.length > 0 && !args[0].startsWith('-') && args[0] !== 'run' && args[0] !== 'help' && args[0] !== '--help' && args[0] !== '-h' && args[0] !== '--version' && args[0] !== '-V') {
  process.argv.splice(2, 0, 'run');
}

// Handle SIGINT gracefully
process.on('SIGINT', () => {
  console.log('\nInterrupted.');
  try {
    const data = JSON.parse(readFileSync(join(process.cwd(), '.forge', 'latest-session.json'), 'utf-8'));
    if (data.sessionId) {
      console.log(`Session: ${data.sessionId}`);
      console.log(`Resume: forge run --resume ${data.sessionId} "continue"`);
    }
  } catch {}
  process.exit(0);
});

program.parse();
