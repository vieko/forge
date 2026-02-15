#!/usr/bin/env node

import { program } from 'commander';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runForge } from './parallel.js';
import { showStatus } from './status.js';
import { runAudit } from './audit.js';
import { runReview } from './review.js';
import { runWatch } from './watch.js';
import { showSpecs } from './specs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

program
  .name('forge')
  .description('A verification boundary for autonomous agents')
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
  .option('-b, --max-budget <usd>', 'Maximum budget in USD')
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
  .option('-w, --watch', 'Open a tmux pane with live session logs')
  .action(async (prompt: string, options: {
    spec?: string;
    specDir?: string;
    cwd?: string;
    model?: string;
    maxTurns?: string;
    maxBudget?: string;
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
    watch?: boolean;
  }) => {
    if (options.resume && options.fork) {
      console.error('Error: --resume and --fork are mutually exclusive. Use one or the other.');
      process.exit(1);
    }
    if (options.maxBudget !== undefined) {
      const budget = parseFloat(options.maxBudget);
      if (isNaN(budget) || budget <= 0) {
        console.error('Error: --max-budget must be a positive number.');
        process.exit(1);
      }
    }
    // --watch: open a tmux pane with live session logs
    if (options.watch) {
      if (process.env.TMUX) {
        const watchCwd = options.cwd ? ` -C ${options.cwd}` : '';
        const { exec: execCb } = await import('child_process');
        execCb(`tmux split-window -h "forge watch${watchCwd}"`, (err) => {
          if (err && !options.quiet) {
            console.error('\x1b[2m[forge]\x1b[0m Could not open tmux watch pane:', err.message);
          }
        });
      } else if (!options.quiet) {
        console.log("\x1b[2m[forge]\x1b[0m Tip: Run '\x1b[36mforge watch\x1b[0m' in another terminal for live logs");
        console.log("\x1b[2m[forge]\x1b[0m (or use --watch inside tmux for auto-split)\n");
      }
    }

    try {
      await runForge({
        prompt,
        specPath: options.spec,
        specDir: options.specDir,
        cwd: options.cwd,
        model: options.model,
        maxTurns: options.maxTurns ? parseInt(options.maxTurns, 10) : 250,
        maxBudgetUsd: options.maxBudget ? parseFloat(options.maxBudget) : undefined,
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
  .option('-b, --max-budget <usd>', 'Maximum budget in USD')
  .option('-v, --verbose', 'Show detailed output')
  .option('-q, --quiet', 'Suppress progress output')
  .option('-r, --resume <session>', 'Resume a previous session')
  .option('-f, --fork <session>', 'Fork from a previous session')
  .action(async (specDir: string, prompt: string | undefined, options: {
    outputDir?: string;
    cwd?: string;
    model?: string;
    maxTurns?: string;
    maxBudget?: string;
    verbose?: boolean;
    quiet?: boolean;
    resume?: string;
    fork?: string;
  }) => {
    if (options.resume && options.fork) {
      console.error('Error: --resume and --fork are mutually exclusive. Use one or the other.');
      process.exit(1);
    }
    if (options.maxBudget !== undefined) {
      const budget = parseFloat(options.maxBudget);
      if (isNaN(budget) || budget <= 0) {
        console.error('Error: --max-budget must be a positive number.');
        process.exit(1);
      }
    }
    try {
      await runAudit({
        specDir,
        outputDir: options.outputDir,
        prompt,
        cwd: options.cwd,
        model: options.model,
        maxTurns: options.maxTurns ? parseInt(options.maxTurns, 10) : 250,
        maxBudgetUsd: options.maxBudget ? parseFloat(options.maxBudget) : undefined,
        verbose: options.verbose,
        quiet: options.quiet,
        resume: options.resume,
        fork: options.fork,
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('review')
  .description('Review recent changes for quality issues')
  .argument('[diff]', 'Git diff range (default: main...HEAD)')
  .option('-C, --cwd <path>', 'Working directory (target repo)')
  .option('-m, --model <model>', 'Model to use (opus, sonnet, or full model ID)', 'sonnet')
  .option('-t, --max-turns <n>', 'Maximum turns (default: 50)', '50')
  .option('-b, --max-budget <usd>', 'Maximum budget in USD')
  .option('-v, --verbose', 'Show detailed output')
  .option('-q, --quiet', 'Suppress progress output')
  .option('--dry-run', 'Report findings without applying fixes')
  .option('-o, --output <path>', 'Write findings to file')
  .action(async (diff: string | undefined, options: {
    cwd?: string;
    model?: string;
    maxTurns?: string;
    maxBudget?: string;
    verbose?: boolean;
    quiet?: boolean;
    dryRun?: boolean;
    output?: string;
  }) => {
    if (options.maxBudget !== undefined) {
      const budget = parseFloat(options.maxBudget);
      if (isNaN(budget) || budget <= 0) {
        console.error('Error: --max-budget must be a positive number.');
        process.exit(1);
      }
    }
    try {
      await runReview({
        diff,
        cwd: options.cwd,
        model: options.model,
        maxTurns: options.maxTurns ? parseInt(options.maxTurns, 10) : 50,
        maxBudgetUsd: options.maxBudget ? parseFloat(options.maxBudget) : undefined,
        verbose: options.verbose,
        quiet: options.quiet,
        dryRun: options.dryRun,
        output: options.output,
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('watch')
  .description('Watch live session logs')
  .argument('[session-id]', 'Session ID to watch (default: latest)')
  .option('-C, --cwd <path>', 'Working directory (target repo)')
  .action(async (sessionId: string | undefined, options: { cwd?: string }) => {
    try {
      await runWatch({
        sessionId,
        cwd: options.cwd,
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('specs')
  .description('List tracked specs with lifecycle status')
  .option('-C, --cwd <path>', 'Working directory (target repo)')
  .option('--pending', 'Show only pending specs')
  .option('--failed', 'Show only failed specs')
  .option('--passed', 'Show only passed specs')
  .option('--orphaned', 'Show specs in manifest but missing from filesystem')
  .option('--untracked', 'Show .md files in spec dirs not in manifest')
  .action(async (options: {
    cwd?: string;
    pending?: boolean;
    failed?: boolean;
    passed?: boolean;
    orphaned?: boolean;
    untracked?: boolean;
  }) => {
    try {
      await showSpecs({
        cwd: options.cwd,
        pending: options.pending,
        failed: options.failed,
        passed: options.passed,
        orphaned: options.orphaned,
        untracked: options.untracked,
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Quick alias: `forge "do something"` = `forge run "do something"`
const COMMANDS = new Set(['run', 'status', 'audit', 'review', 'watch', 'specs', 'help']);
const args = process.argv.slice(2);
if (args.length > 0 && !args[0].startsWith('-') && !COMMANDS.has(args[0])) {
  process.argv.splice(2, 0, 'run');
}

// Parse -C/--cwd early for SIGINT handler (before commander parses)
function getTargetCwd(): string {
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-C' || args[i] === '--cwd') {
      return args[i + 1] || process.cwd();
    }
    if (args[i].startsWith('-C=')) {
      return args[i].slice(3);
    }
    if (args[i].startsWith('--cwd=')) {
      return args[i].slice(6);
    }
  }
  return process.cwd();
}

// Handle SIGINT gracefully
process.on('SIGINT', () => {
  console.log('\nInterrupted.');
  try {
    const targetCwd = getTargetCwd();
    const data = JSON.parse(readFileSync(join(targetCwd, '.forge', 'latest-session.json'), 'utf-8'));
    if (data.sessionId) {
      console.log(`Session: ${data.sessionId}`);
      console.log(`Resume: \x1b[36mforge run --resume ${data.sessionId} "continue"\x1b[0m`);
      console.log(`Fork:   \x1b[36mforge run --fork ${data.sessionId} "try different approach"\x1b[0m`);
    }
  } catch {}
  process.exit(0);
});

program.parse();
