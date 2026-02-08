#!/usr/bin/env node

import { program } from 'commander';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runForge, showStatus, runAudit } from './query.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

program
  .name('forge')
  .description('Outcome-driven development with agents')
  .version(pkg.version);

program
  .command('run')
  .description('Run a task with AI agents')
  .argument('<prompt>', 'The task to accomplish')
  .option('-s, --spec <path>', 'Path to spec file (.md)')
  .option('-S, --spec-dir <path>', 'Path to specs directory (runs each .md sequentially)')
  .option('-C, --cwd <path>', 'Working directory (target repo)')
  .option('-m, --model <model>', 'Model to use (opus, sonnet, or full model ID)', 'opus')
  .option('-t, --max-turns <n>', 'Maximum turns per spec (default: 250)', '250')
  .option('--plan-only', 'Only create tasks, do not implement')
  .option('--dry-run', 'Preview tasks and estimate cost without executing')
  .option('-v, --verbose', 'Show detailed output')
  .option('-q, --quiet', 'Suppress progress output (for CI)')
  .option('-r, --resume <session>', 'Resume a previous session')
  .option('-f, --fork <session>', 'Fork from a previous session')
  .option('-P, --parallel', 'Run specs in parallel (with --spec-dir)')
  .option('--concurrency <n>', 'Max concurrent specs in parallel mode (default: auto)')
  .option('--sequential-first <n>', 'Run first N specs sequentially before parallelizing')
  .option('--rerun-failed', 'Rerun only failed specs from latest batch')
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
    fork?: string;
    parallel?: boolean;
    concurrency?: string;
    sequentialFirst?: string;
    rerunFailed?: boolean;
  }) => {
    if (options.resume && options.fork) {
      console.error('Error: --resume and --fork are mutually exclusive. Use one or the other.');
      process.exit(1);
    }
    try {
      await runForge({
        prompt,
        specPath: options.spec,
        specDir: options.specDir,
        cwd: options.cwd,
        model: options.model,
        maxTurns: options.maxTurns ? parseInt(options.maxTurns, 10) : 250,
        planOnly: options.planOnly,
        dryRun: options.dryRun,
        verbose: options.verbose,
        quiet: options.quiet,
        resume: options.resume,
        fork: options.fork,
        parallel: options.parallel,
        concurrency: options.concurrency ? parseInt(options.concurrency, 10) : undefined,
        sequentialFirst: options.sequentialFirst ? parseInt(options.sequentialFirst, 10) : undefined,
        rerunFailed: options.rerunFailed,
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show results from recent runs')
  .option('-C, --cwd <path>', 'Working directory (target repo)')
  .option('-a, --all', 'Show all runs')
  .option('-n, --last <n>', 'Show last N runs (default: 1)')
  .action(async (options: { cwd?: string; all?: boolean; last?: string }) => {
    try {
      await showStatus({
        cwd: options.cwd,
        all: options.all,
        last: options.last ? parseInt(options.last, 10) : undefined,
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('audit')
  .description('Audit codebase against specs and produce new specs for remaining work')
  .argument('<spec-dir>', 'Directory of spec files to audit against')
  .argument('[prompt]', 'Additional context for the audit')
  .option('-o, --output-dir <path>', 'Output directory for generated specs (default: <spec-dir>/audit/)')
  .option('-C, --cwd <path>', 'Working directory (target repo)')
  .option('-m, --model <model>', 'Model to use (opus, sonnet, or full model ID)', 'opus')
  .option('-t, --max-turns <n>', 'Maximum turns (default: 250)', '250')
  .option('-v, --verbose', 'Show detailed output')
  .option('-q, --quiet', 'Suppress progress output')
  .action(async (specDir: string, prompt: string | undefined, options: {
    outputDir?: string;
    cwd?: string;
    model?: string;
    maxTurns?: string;
    verbose?: boolean;
    quiet?: boolean;
  }) => {
    try {
      await runAudit({
        specDir,
        outputDir: options.outputDir,
        prompt,
        cwd: options.cwd,
        model: options.model,
        maxTurns: options.maxTurns ? parseInt(options.maxTurns, 10) : 250,
        verbose: options.verbose,
        quiet: options.quiet,
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Quick alias: `forge "do something"` = `forge run "do something"`
const args = process.argv.slice(2);
if (args.length > 0 && !args[0].startsWith('-') && args[0] !== 'run' && args[0] !== 'status' && args[0] !== 'audit' && args[0] !== 'help' && args[0] !== '--help' && args[0] !== '-h' && args[0] !== '--version' && args[0] !== '-V') {
  process.argv.splice(2, 0, 'run');
}

// Handle SIGINT gracefully
process.on('SIGINT', () => {
  console.log('\nInterrupted.');
  try {
    const data = JSON.parse(readFileSync(join(process.cwd(), '.forge', 'latest-session.json'), 'utf-8'));
    if (data.sessionId) {
      console.log(`Session: ${data.sessionId}`);
      console.log(`Resume: \x1b[36mforge run --resume ${data.sessionId} "continue"\x1b[0m`);
      console.log(`Fork:   \x1b[36mforge run --fork ${data.sessionId} "try different approach"\x1b[0m`);
    }
  } catch {}
  process.exit(0);
});

program.parse();
