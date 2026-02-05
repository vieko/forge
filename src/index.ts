#!/usr/bin/env node

import { program } from 'commander';
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
  .option('-m, --model <model>', 'Model to use (opus, sonnet)', 'opus')
  .option('--plan-only', 'Only create tasks, do not implement')
  .option('-v, --verbose', 'Show detailed output')
  .action(async (prompt: string, options: {
    spec?: string;
    model?: string;
    planOnly?: boolean;
    verbose?: boolean;
  }) => {
    try {
      await runForge({
        prompt,
        specPath: options.spec,
        model: options.model as 'opus' | 'sonnet',
        planOnly: options.planOnly,
        verbose: options.verbose
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
  console.log('\nInterrupted. Tasks created so far are saved in TaskList.');
  process.exit(0);
});

program.parse();
