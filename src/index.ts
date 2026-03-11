#!/usr/bin/env node

import { program } from 'commander';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { runForge } from './parallel.js';
import { showStatus } from './status.js';
import { runAudit } from './audit.js';
import { runReview } from './review.js';
import { runWatch } from './watch.js';
import { showSpecs } from './specs.js';
import { runDefine } from './define.js';
import { runProof } from './proof.js';
import { runVerify } from './proof-runner.js';
import { showStats } from './stats.js';
import { runPipeline } from './pipeline.js';
import { FileSystemStateProvider } from './pipeline-state.js';
import { showPipelineStatus } from './pipeline-status.js';
import { STAGE_ORDER } from './pipeline-types.js';
import type { StageName, GateKey, GateType } from './pipeline-types.js';
import { triggerAbort, isInterrupted } from './abort.js';
import { showBanner } from './display.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

// ── CLI Validators ───────────────────────────────────────────

function validateBudget(value?: string): void {
  if (value !== undefined) {
    const budget = parseFloat(value);
    if (isNaN(budget) || budget <= 0) {
      console.error('Error: --max-budget must be a positive number.');
      process.exit(1);
    }
  }
}

function validateSession(resume?: string, fork?: string): void {
  if (resume && fork) {
    console.error('Error: --resume and --fork are mutually exclusive. Use one or the other.');
    process.exit(1);
  }
}

function parseBudget(value?: string): number | undefined {
  return value ? parseFloat(value) : undefined;
}

function parseTurns(value: string | undefined, fallback: number): number {
  return value ? parseInt(value, 10) : fallback;
}

// Block SDK-invoking commands when running inside Claude Code.
// Claude Code sets CLAUDECODE=1 in the env of every Bash subprocess.
// The Agent SDK can't nest inside an active session.
function guardNestedSession(): void {
  if (process.env.CLAUDECODE !== '1') return;
  if (process.env.FORGE_ALLOW_NESTED === '1') return;

  // Reconstruct the command with proper quoting for args containing spaces
  const cmd = process.argv.slice(2).map(a => a.includes(' ') ? `"${a}"` : a).join(' ');
  console.error(`forge: Cannot run inside Claude Code (nested SDK).`);
  console.error(`\nRun in a separate terminal:\n`);
  console.error(`  forge ${cmd}\n`);
  process.exit(1);
}

// ── Commands ─────────────────────────────────────────────────

program
  .name('forge')
  .description('A verification boundary for autonomous agents')
  .version(pkg.version);

program
  .command('run')
  .description('Run a task with AI agents')
  .argument('<prompt>', 'The task to accomplish')
  .option('-s, --spec <path>', 'Path to spec file (.md)')
  .option('-S, --spec-dir <path>', 'Path to specs directory (runs each .md in parallel)')
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
  .option('--sequential', 'Run specs sequentially instead of parallel (default: parallel)')
  .option('--concurrency <n>', 'Max concurrent specs in parallel mode (default: auto)')
  .option('--sequential-first <n>', 'Run first N specs sequentially before parallelizing')
  .option('--rerun-failed', 'Rerun only failed specs from latest batch')
  .option('--pending', 'Run only pending specs from the manifest')
  .option('-F, --force', 'Re-run all specs including already passed')
  .option('-B, --branch <name>', 'Run in an isolated git worktree on the named branch')
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
    sequential?: boolean;
    concurrency?: string;
    sequentialFirst?: string;
    rerunFailed?: boolean;
    pending?: boolean;
    force?: boolean;
    branch?: string;
    watch?: boolean;
  }) => {
    guardNestedSession();
    validateSession(options.resume, options.fork);
    validateBudget(options.maxBudget);

    // --watch: open a tmux pane with live session logs
    if (options.watch) {
      if (process.env.TMUX) {
        const watchCwd = options.cwd ? ` -C ${options.cwd}` : '';
        const { exec: execCb } = await import('child_process');
        const child = execCb(`tmux split-window -h "forge watch${watchCwd}"`, (err) => {
          if (err && !options.quiet) {
            console.error('\x1b[2m[forge]\x1b[0m Could not open tmux watch pane:', err.message);
          }
        });
        child.unref();
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
        maxTurns: parseTurns(options.maxTurns, 250),
        maxBudgetUsd: parseBudget(options.maxBudget),
        planOnly: options.planOnly,
        dryRun: options.dryRun,
        verbose: options.verbose,
        quiet: options.quiet,
        resume: options.resume,
        fork: options.fork,
        sequential: options.sequential,
        concurrency: options.concurrency ? parseInt(options.concurrency, 10) : undefined,
        sequentialFirst: options.sequentialFirst ? parseInt(options.sequentialFirst, 10) : undefined,
        rerunFailed: options.rerunFailed,
        pendingOnly: options.pending,
        force: options.force,
        branch: options.branch,
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
  .argument('<spec-path>', 'Spec file or directory to audit against')
  .argument('[prompt]', 'Additional context for the audit')
  .option('-o, --output-dir <path>', 'Output directory for generated specs (default: <spec-dir>/audit/)')
  .option('-C, --cwd <path>', 'Working directory (target repo)')
  .option('-m, --model <model>', 'Model to use (opus, sonnet, or full model ID)', 'opus')
  .option('-t, --max-turns <n>', 'Maximum turns (default: 250)', '250')
  .option('-b, --max-budget <usd>', 'Maximum budget in USD')
  .option('--fix', 'Run audit-fix convergence loop until clean or max rounds')
  .option('--fix-rounds <n>', 'Maximum audit-fix rounds (default: 3)')
  .option('-v, --verbose', 'Show detailed output')
  .option('-q, --quiet', 'Suppress progress output')
  .option('-r, --resume <session>', 'Resume a previous session')
  .option('-f, --fork <session>', 'Fork from a previous session')
  .option('-w, --watch', 'Open a tmux pane with live session logs')
  .action(async (specDir: string, prompt: string | undefined, options: {
    outputDir?: string;
    cwd?: string;
    model?: string;
    maxTurns?: string;
    maxBudget?: string;
    fix?: boolean;
    fixRounds?: string;
    verbose?: boolean;
    quiet?: boolean;
    resume?: string;
    fork?: string;
    watch?: boolean;
  }) => {
    guardNestedSession();
    validateSession(options.resume, options.fork);
    validateBudget(options.maxBudget);

    if (options.watch) {
      if (process.env.TMUX) {
        const watchCwd = options.cwd ? ` -C ${options.cwd}` : '';
        const { exec: execCb } = await import('child_process');
        const child = execCb(`tmux split-window -h "forge watch${watchCwd}"`, (err) => {
          if (err && !options.quiet) {
            console.error('\x1b[2m[forge]\x1b[0m Could not open tmux watch pane:', err.message);
          }
        });
        child.unref();
      } else if (!options.quiet) {
        console.log("\x1b[2m[forge]\x1b[0m Tip: Run '\x1b[36mforge watch\x1b[0m' in another terminal for live logs");
        console.log("\x1b[2m[forge]\x1b[0m (or use --watch inside tmux for auto-split)\n");
      }
    }

    try {
      await runAudit({
        specDir,
        outputDir: options.outputDir,
        prompt,
        cwd: options.cwd,
        model: options.model,
        maxTurns: parseTurns(options.maxTurns, 250),
        maxBudgetUsd: parseBudget(options.maxBudget),
        verbose: options.verbose,
        quiet: options.quiet,
        resume: options.resume,
        fork: options.fork,
        fix: options.fix,
        fixRounds: options.fixRounds ? parseInt(options.fixRounds, 10) : undefined,
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('define')
  .description('Analyze codebase and generate outcome spec files from a description')
  .argument('<prompt>', 'High-level description of what to build')
  .option('-o, --output-dir <path>', 'Output directory for generated specs (default: specs/)')
  .option('-C, --cwd <path>', 'Working directory (target repo)')
  .option('-m, --model <model>', 'Model to use (opus, sonnet, or full model ID)', 'sonnet')
  .option('-t, --max-turns <n>', 'Maximum turns (default: 100)', '100')
  .option('-b, --max-budget <usd>', 'Maximum budget in USD')
  .option('-v, --verbose', 'Show detailed output')
  .option('-q, --quiet', 'Suppress progress output')
  .option('-r, --resume <session>', 'Resume a previous session')
  .option('-f, --fork <session>', 'Fork from a previous session')
  .action(async (prompt: string, options: {
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
    guardNestedSession();
    validateSession(options.resume, options.fork);
    validateBudget(options.maxBudget);
    try {
      await runDefine({
        prompt,
        outputDir: options.outputDir,
        cwd: options.cwd,
        model: options.model,
        maxTurns: parseTurns(options.maxTurns, 100),
        maxBudgetUsd: parseBudget(options.maxBudget),
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
    guardNestedSession();
    validateBudget(options.maxBudget);
    try {
      await runReview({
        diff,
        cwd: options.cwd,
        model: options.model,
        maxTurns: parseTurns(options.maxTurns, 50),
        maxBudgetUsd: parseBudget(options.maxBudget),
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

const proofAction = async (specPaths: string[], options: {
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
    guardNestedSession();
    validateSession(options.resume, options.fork);
    validateBudget(options.maxBudget);
    try {
      await runProof({
        specPaths,
        outputDir: options.outputDir,
        cwd: options.cwd,
        model: options.model,
        maxTurns: parseTurns(options.maxTurns, 100),
        maxBudgetUsd: parseBudget(options.maxBudget),
        verbose: options.verbose,
        quiet: options.quiet,
        resume: options.resume,
        fork: options.fork,
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  };

const proofOpts = (cmd: ReturnType<typeof program.command>) => cmd
  .argument('<spec-paths...>', 'Spec file(s) or directory to generate proof for')
  .option('-o, --output-dir <path>', 'Output directory for proof files (default: .forge/proofs/)')
  .option('-C, --cwd <path>', 'Working directory (target repo)')
  .option('-m, --model <model>', 'Model to use (opus, sonnet, or full model ID)', 'sonnet')
  .option('-t, --max-turns <n>', 'Maximum turns (default: 100)', '100')
  .option('-b, --max-budget <usd>', 'Maximum budget in USD')
  .option('-v, --verbose', 'Show detailed output')
  .option('-q, --quiet', 'Suppress progress output')
  .option('-r, --resume <session>', 'Resume a previous session')
  .option('-f, --fork <session>', 'Fork from a previous session');

proofOpts(program.command('proof').description('Generate a structured test protocol (proof) from implemented specs'))
  .action(proofAction);

proofOpts(program.command('prove', { hidden: true }).description('(deprecated alias for proof)'))
  .action(proofAction);

program
  .command('verify')
  .description('Execute proof test protocols and create a PR')
  .argument('<proof-dir>', 'Directory of proof files to verify')
  .option('-o, --output-dir <path>', 'Output directory for verification results')
  .option('-C, --cwd <path>', 'Working directory (target repo)')
  .option('-m, --model <model>', 'Model to use (opus, sonnet, or full model ID)')
  .option('-q, --quiet', 'Suppress progress output')
  .option('--dry-run', 'Preview what would be verified and what PR would look like')
  .option('-t, --max-turns <n>', 'Maximum turns (default: 100)', '100')
  .option('-b, --max-budget <usd>', 'Maximum budget in USD')
  .action(async (proofDir: string, options: {
    outputDir?: string;
    cwd?: string;
    model?: string;
    maxTurns?: string;
    maxBudget?: string;
    quiet?: boolean;
    dryRun?: boolean;
  }) => {
    guardNestedSession();
    try {
      await runVerify({
        proofDir,
        outputDir: options.outputDir,
        cwd: options.cwd,
        model: options.model,
        maxTurns: options.maxTurns ? parseInt(options.maxTurns, 10) : undefined,
        maxBudgetUsd: options.maxBudget ? parseFloat(options.maxBudget) : undefined,
        quiet: options.quiet,
        dryRun: options.dryRun,
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
  .option('--reconcile', 'Backfill manifest from .forge/results/ history')
  .option('--prune', 'Remove orphaned entries (file missing) from manifest')
  .option('--add [path]', 'Register untracked specs, or specific path/glob')
  .option('--resolve <spec>', 'Mark a pending/failed spec as passed without running')
  .option('--unresolve <spec>', 'Reset a spec back to pending (clears run history)')
  .option('--check', 'Triage pending specs: auto-resolve already-implemented ones')
  .option('--summary', 'Show directory-level summary instead of individual specs')
  .action(async (options: {
    cwd?: string;
    pending?: boolean;
    failed?: boolean;
    passed?: boolean;
    orphaned?: boolean;
    untracked?: boolean;
    reconcile?: boolean;
    prune?: boolean;
    add?: string | boolean;
    resolve?: string;
    unresolve?: string;
    check?: boolean;
    summary?: boolean;
  }) => {
    if (options.check) guardNestedSession();
    try {
      await showSpecs({
        cwd: options.cwd,
        pending: options.pending,
        failed: options.failed,
        passed: options.passed,
        orphaned: options.orphaned,
        untracked: options.untracked,
        reconcile: options.reconcile,
        prune: options.prune,
        add: options.add,
        resolve: options.resolve,
        unresolve: options.unresolve,
        check: options.check,
        summary: options.summary,
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('stats')
  .description('Show aggregated run statistics')
  .option('-C, --cwd <path>', 'Working directory (target repo)')
  .option('--since <date>', 'Only include runs after this ISO date')
  .option('--by-spec', 'Show per-spec breakdown from manifest')
  .option('--by-model', 'Show per-model breakdown')
  .action(async (options: {
    cwd?: string;
    since?: string;
    bySpec?: boolean;
    byModel?: boolean;
  }) => {
    try {
      await showStats({
        cwd: options.cwd,
        since: options.since,
        bySpec: options.bySpec,
        byModel: options.byModel,
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command('tui')
  .description('Interactive sessions viewer')
  .option('-C, --cwd <path>', 'Working directory (target repo)')
  .action(async (options: { cwd?: string }) => {
    // OpenTUI requires Bun (imports .scm files that Node can't handle)
    const isBun = typeof globalThis.Bun !== 'undefined';
    if (!isBun) {
      const { execFileSync } = await import('child_process');
      const args = ['run', join(__dirname, '..', 'src', 'index.ts'), 'tui'];
      if (options.cwd) args.push('-C', options.cwd);
      try {
        execFileSync('bun', args, { stdio: 'inherit' });
      } catch (e: unknown) {
        const code = (e as { status?: number }).status;
        process.exit(code ?? 1);
      }
      return;
    }
    try {
      const { runTui } = await import('./tui.js');
      await runTui({ cwd: options.cwd });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// ── Pipeline Command ─────────────────────────────────────────

const pipelineCmd = program
  .command('pipeline')
  .description('Run a full pipeline: define -> run -> audit -> proof -> verify')
  .argument('[goal]', 'High-level goal describing what to build')
  .option('--from <stage>', 'Start from a specific stage (define, run, audit, proof, verify)')
  .option('-S, --spec-dir <path>', 'Skip define and seed with the given spec directory')
  .option('--gate-all <type>', 'Set all gates to this type (auto, confirm, review)')
  .option('--gates <spec>', 'Per-stage gate overrides (e.g. define:auto,run:auto,audit:confirm,proof:confirm)')
  .option('--resume <id>', 'Resume a paused or incomplete pipeline')
  .option('-C, --cwd <path>', 'Working directory (target repo)')
  .option('-m, --model <model>', 'Model to use (opus, sonnet, or full model ID)', 'opus')
  .option('-t, --max-turns <n>', 'Maximum turns per stage (default: 250)', '250')
  .option('-b, --max-budget <usd>', 'Maximum budget in USD')
  .option('-v, --verbose', 'Show detailed output')
  .option('-q, --quiet', 'Suppress progress output')
  .option('-w, --watch', 'Open a tmux pane with live session logs')
  .action(async (goal: string | undefined, options: {
    from?: string;
    specDir?: string;
    gateAll?: string;
    gates?: string;
    resume?: string;
    cwd?: string;
    model?: string;
    maxTurns?: string;
    maxBudget?: string;
    verbose?: boolean;
    quiet?: boolean;
    watch?: boolean;
  }) => {
    guardNestedSession();
    validateBudget(options.maxBudget);
    if (!options.quiet) showBanner();

    // Must provide either a goal or --resume
    if (!goal && !options.resume) {
      console.error('Error: Provide a goal or use --resume <id> to continue an existing pipeline.');
      process.exit(1);
    }

    // Validate --from
    const validStages: StageName[] = [...STAGE_ORDER];
    let fromStage: StageName | undefined;
    if (options.from) {
      if (!validStages.includes(options.from as StageName)) {
        program.error(
          `Invalid stage "${options.from}". Must be one of: ${validStages.join(', ')}`,
        );
      }
      fromStage = options.from as StageName;
    }

    // Validate --gate-all
    const validGateTypes = ['auto', 'confirm', 'review'];
    if (options.gateAll && !validGateTypes.includes(options.gateAll)) {
      program.error(
        `Invalid gate type "${options.gateAll}". Must be one of: ${validGateTypes.join(', ')}`,
      );
    }

    // Build gates from --gate-all and --gates
    let gates: Partial<Record<GateKey, GateType>> | undefined;
    if (options.gateAll) {
      const type = options.gateAll as GateType;
      gates = {
        'define -> run': type,
        'run -> audit': type,
        'audit -> proof': type,
        'proof -> verify': type,
      };
    }

    // Parse --gates (comma-separated stage:type pairs)
    if (options.gates) {
      if (!gates) gates = {};
      const validGateStages = ['define', 'run', 'audit', 'proof'];
      const gateKeyMap: Record<string, GateKey> = {
        'define': 'define -> run',
        'run': 'run -> audit',
        'audit': 'audit -> proof',
        'proof': 'proof -> verify',
      };

      const tokens = options.gates.split(',');
      for (const token of tokens) {
        const parts = token.trim().split(':');
        if (parts.length !== 2) {
          program.error(
            `Invalid --gates token "${token}". Expected format: stage:type (e.g. audit:confirm)`,
          );
        }
        const [stage, type] = parts;
        if (!validGateStages.includes(stage)) {
          program.error(
            `Invalid gate stage "${stage}". Must be one of: ${validGateStages.join(', ')}`,
          );
        }
        if (!validGateTypes.includes(type)) {
          program.error(
            `Invalid gate type "${type}". Must be one of: ${validGateTypes.join(', ')}`,
          );
        }
        gates[gateKeyMap[stage]] = type as GateType;
      }
    }

    // --watch: open a tmux pane with live session logs
    if (options.watch) {
      if (process.env.TMUX) {
        const watchCwd = options.cwd ? ` -C ${options.cwd}` : '';
        const { exec: execCb } = await import('child_process');
        const child = execCb(`tmux split-window -h "forge watch${watchCwd}"`, (err) => {
          if (err && !options.quiet) {
            console.error('\x1b[2m[forge]\x1b[0m Could not open tmux watch pane:', err.message);
          }
        });
        child.unref();
      } else if (!options.quiet) {
        console.log("\x1b[2m[forge]\x1b[0m Tip: Run '\x1b[36mforge watch\x1b[0m' in another terminal for live logs");
        console.log("\x1b[2m[forge]\x1b[0m (or use --watch inside tmux for auto-split)\n");
      }
    }

    try {
      const workingDir = options.cwd ? resolve(options.cwd) : process.cwd();
      const stateProvider = new FileSystemStateProvider(workingDir);

      await runPipeline(
        {
          goal: goal || '',
          gates,
          fromStage,
          specDir: options.specDir,
          cwd: options.cwd,
          model: options.model,
          resume: options.resume,
          verbose: options.verbose,
          quiet: options.quiet,
        },
        stateProvider,
      );
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

pipelineCmd
  .command('status')
  .description('Show pipeline state')
  .argument('[id]', 'Pipeline ID (default: active pipeline)')
  .option('-C, --cwd <path>', 'Working directory (target repo)')
  .action(async (id: string | undefined, options: { cwd?: string }) => {
    try {
      await showPipelineStatus({
        cwd: options.cwd,
        id,
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Quick alias: `forge "do something"` = `forge run "do something"`
// Also handles `forge --spec-dir ... "prompt"` → `forge run --spec-dir ... "prompt"`
const COMMANDS = new Set(['run', 'status', 'audit', 'define', 'review', 'proof', 'prove', 'verify', 'watch', 'specs', 'stats', 'tui', 'pipeline', 'help']);
const RUN_FLAGS = new Set(['--spec', '--spec-dir', '--rerun-failed', '--pending', '--sequential', '--plan-only', '--dry-run', '--sequential-first', '--branch']);
const args = process.argv.slice(2);
if (args.length > 0 && !COMMANDS.has(args[0])) {
  if (!args[0].startsWith('-') || RUN_FLAGS.has(args[0])) {
    process.argv.splice(2, 0, 'run');
  }
}

// ── Extra Positional Arg Detection ──────────────────────────

function detectExtraSpecArgs(): void {
  const args = process.argv.slice(2);
  const runIndex = args.indexOf('run');
  if (runIndex === -1) return;

  // Flags for the run command that consume the next arg as a value
  const flagsWithValues = new Set([
    '-s', '--spec', '-S', '--spec-dir', '-C', '--cwd', '-m', '--model',
    '-t', '--max-turns', '-b', '--max-budget', '-r', '--resume', '-f', '--fork',
    '--concurrency', '--sequential-first', '-B', '--branch',
  ]);

  const positionalArgs: string[] = [];
  let i = runIndex + 1;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') {
      break;
    } else if (arg.startsWith('-')) {
      // Handle --flag=value and -f=value
      const flagName = arg.split('=')[0];
      if (flagsWithValues.has(flagName)) {
        i += arg.includes('=') ? 1 : 2;
      } else {
        i += 1;
      }
    } else {
      positionalArgs.push(arg);
      i++;
    }
  }

  if (positionalArgs.length <= 1) return;

  const extraArgs = positionalArgs.slice(1);
  const specLikeExtras = extraArgs.filter(a => a.endsWith('.md') || existsSync(a));
  if (specLikeExtras.length === 0) return;

  // Include the first arg in the list if it also looks like a spec
  const allSpecLike = positionalArgs.filter(a => a.endsWith('.md') || existsSync(a));
  console.error(`Error: Multiple spec files detected as positional args (${allSpecLike.join(', ')}).`);
  console.error('Use --spec-dir <dir> for batch runs, or --spec <file> for a single spec.');
  process.exit(1);
}

// Run detection after shorthand alias injection, before Commander parses
detectExtraSpecArgs();

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

// Handle SIGINT gracefully — two-phase shutdown
// First Ctrl-C: abort running SDK queries, skip pending specs
// Second Ctrl-C: force exit immediately
process.on('SIGINT', () => {
  if (!isInterrupted()) {
    triggerAbort();
    console.log('\nInterrupted. Stopping...');
    try {
      const targetCwd = getTargetCwd();
      const data = JSON.parse(readFileSync(join(targetCwd, '.forge', 'latest-session.json'), 'utf-8'));
      if (data.sessionId) {
        console.log(`Session: ${data.sessionId}`);
        console.log(`Resume:  \x1b[36mforge run --resume ${data.sessionId} "continue"\x1b[0m`);
      }
    } catch {}
    console.log('Press Ctrl-C again to force exit.');
  } else {
    console.log('\nForce exit.');
    process.exit(1);
  }
});

program.parse();
