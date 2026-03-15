// ── Pipeline Orchestration Core Loop ─────────────────────────
//
// Drives a pipeline through its stages sequentially: define -> run ->
// audit -> proof -> verify. Checks gates between stages, delegates
// execution to existing forge functions via ExecutionProvider, passes
// artifacts between stages, accumulates costs, and persists state
// after every transition.

import type {
  Pipeline,
  PipelineOptions,
  StageName,
  Stage,
  GateKey,
  GateType,
  StateProvider,
  EventProvider,
  ExecutionProvider,
  StageResult,
} from './pipeline-types.js';
import { STAGE_ORDER, DEFAULT_GATES } from './pipeline-types.js';
import { runDefine as realRunDefine } from './define.js';
import { runForge as realRunForge } from './parallel.js';
import { runAudit as realRunAudit } from './audit.js';
import { runProof as realRunProof } from './proof.js';
import { runVerify as realRunVerify } from './proof-runner.js';
import { resolveWorkingDir, ForgeError, sleep, createWorktree, commitWorktree, cleanupWorktree } from './utils.js';
import { isInterrupted } from './abort.js';
import { getConfig } from './config.js';
import { resolveSetupCommands, resolveTeardownCommands, runWorkspaceHooks } from './workspace.js';
import { getDb } from './db.js';
import { promises as fs } from 'fs';
import path from 'path';
import type { ProofManifest } from './types.js';

// ── Constants ────────────────────────────────────────────────

// ── No-op Providers ──────────────────────────────────────────

/** No-op event provider used when none is supplied. */
const noopEventProvider: EventProvider = {
  publish: async () => {},
  subscribe: () => () => {},
};

// ── Internal Helpers ─────────────────────────────────────────

/** Snapshot session IDs in .forge/sessions/ directory. */
async function snapshotSessionIds(cwd: string): Promise<Set<string>> {
  try {
    const sessionsDir = path.join(cwd, '.forge', 'sessions');
    const entries = await fs.readdir(sessionsDir);
    return new Set(entries);
  } catch {
    return new Set();
  }
}

/** Build a gate key string from two consecutive stage names. */
function makeGateKey(from: StageName, to: StageName): GateKey {
  return `${from} -> ${to}` as GateKey;
}

/** Find a stage by name in the pipeline. Throws if not found. */
function findStage(pipeline: Pipeline, name: StageName): Stage {
  const stage = pipeline.stages.find(s => s.name === name);
  if (!stage) throw new Error(`Stage not found: ${name}`);
  return stage;
}

/**
 * Find the index of the first stage that needs work.
 * Stages that are 'completed' or 'skipped' are treated as done.
 * Stages that are 'failed', 'running', 'pending', or 'cancelled'
 * are considered actionable (for resume scenarios).
 */
function findFirstActionableIndex(pipeline: Pipeline): number {
  for (let i = 0; i < STAGE_ORDER.length; i++) {
    const stage = findStage(pipeline, STAGE_ORDER[i]);
    if (stage.status !== 'completed' && stage.status !== 'skipped') {
      return i;
    }
  }
  return STAGE_ORDER.length;
}

/**
 * Cancel a pipeline due to interrupt. Marks the given stage as
 * 'cancelled' (if it is currently 'running' or 'pending'), marks
 * all subsequent pending stages as 'skipped', and sets the pipeline
 * status to 'cancelled'.
 */
function cancelPipeline(pipeline: Pipeline, currentStageName: StageName): void {
  const now = new Date().toISOString();
  const currentIdx = STAGE_ORDER.indexOf(currentStageName);

  for (let i = currentIdx; i < STAGE_ORDER.length; i++) {
    const stage = findStage(pipeline, STAGE_ORDER[i]);
    if (stage.status === 'running') {
      stage.status = 'cancelled';
      stage.completedAt = now;
      if (stage.startedAt) {
        stage.duration =
          (new Date(now).getTime() - new Date(stage.startedAt).getTime()) / 1000;
      }
    } else if (stage.status === 'pending') {
      stage.status = 'skipped';
    }
  }

  pipeline.status = 'cancelled';
  pipeline.updatedAt = now;
}

/**
 * Propagate artifacts from all completed/skipped previous stages
 * into the current stage. Only copies keys not already present on
 * the current stage (explicit seeding takes priority).
 */
function propagateArtifacts(pipeline: Pipeline, currentStage: StageName): void {
  const currentIdx = STAGE_ORDER.indexOf(currentStage);
  const stage = findStage(pipeline, currentStage);

  for (let i = 0; i < currentIdx; i++) {
    const prev = findStage(pipeline, STAGE_ORDER[i]);
    if (prev.status === 'completed' || prev.status === 'skipped') {
      for (const [key, value] of Object.entries(prev.artifacts)) {
        if (!(key in stage.artifacts)) {
          stage.artifacts[key] = value;
        }
      }
    }
  }
}

/**
 * Query the runs table for total cost of runs created after `sinceMs`.
 * Falls back to 0 if the database is unavailable.
 */
function extractCostFromRuns(cwd: string, sinceMs: number): number {
  const db = getDb(cwd);
  if (!db) return 0;

  const sinceIso = new Date(sinceMs).toISOString();
  const row = db.query(
    'SELECT COALESCE(SUM(costUsd), 0) as totalCost FROM runs WHERE createdAt >= ?',
  ).get(sinceIso) as { totalCost: number } | null;

  return row?.totalCost ?? 0;
}

/** List .md files in a directory, sorted alphabetically. */
async function scanMdFiles(dir: string): Promise<string[]> {
  try {
    const files = await fs.readdir(dir);
    return files.filter(f => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

// ── Default Execution Provider ───────────────────────────────

/**
 * Creates an ExecutionProvider that wraps the existing forge
 * functions (runDefine, runForge, runAudit, runProof, runVerify)
 * without modifying them. Extracts cost from the DB runs table and
 * artifacts from the filesystem after each call.
 */
export function createDefaultExecutionProvider(): ExecutionProvider {
  return {
    async runDefine(pipeline, options): Promise<StageResult> {
      const cwd = await resolveWorkingDir(options.cwd);
      const outputDir = options.specDir
        ? path.resolve(cwd, options.specDir)
        : path.join(cwd, 'specs');

      const before = Date.now();

      await realRunDefine({
        prompt: pipeline.goal,
        outputDir,
        cwd,
        persistDir: options.persistDir,
        model: options.model,
        quiet: options.quiet,
        verbose: options.verbose,
      });

      const persistBase = options.persistDir || cwd;
      const cost = extractCostFromRuns(persistBase, before);
      const specs = await scanMdFiles(outputDir);

      return {
        cost,
        artifacts: {
          specDir: outputDir,
          specCount: String(specs.length),
        },
      };
    },

    async runForge(pipeline, options): Promise<StageResult> {
      const cwd = await resolveWorkingDir(options.cwd);
      const persistBase = options.persistDir || cwd;
      const stage = findStage(pipeline, 'run');
      const specDir = stage.artifacts.specDir || options.specDir;
      if (!specDir) {
        throw new Error(
          'run stage requires specDir artifact (from define stage or --spec-dir)',
        );
      }
      const resolvedSpecDir = path.resolve(cwd, specDir);

      const before = Date.now();

      await realRunForge({
        prompt: 'implement specifications',
        specDir: resolvedSpecDir,
        cwd,
        persistDir: persistBase !== cwd ? persistBase : undefined,
        model: options.model,
        quiet: options.quiet,
        verbose: options.verbose,
      });

      const cost = extractCostFromRuns(persistBase, before);

      return {
        cost,
        artifacts: { specDir: resolvedSpecDir },
      };
    },

    async runAudit(pipeline, options): Promise<StageResult> {
      const cwd = await resolveWorkingDir(options.cwd);
      const persistBase = options.persistDir || cwd;
      const stage = findStage(pipeline, 'audit');
      const specDir = stage.artifacts.specDir || options.specDir;
      if (!specDir) {
        throw new Error('audit stage requires specDir artifact');
      }
      const resolvedSpecDir = path.resolve(cwd, specDir);

      const before = Date.now();

      // Use --fix behavior by default for convergence loop
      await realRunAudit({
        specDir: resolvedSpecDir,
        cwd,
        persistDir: options.persistDir,
        model: options.model,
        quiet: options.quiet,
        verbose: options.verbose,
        fix: true,
      });

      const cost = extractCostFromRuns(persistBase, before);

      // Check for remediation specs produced by the audit fix loop
      const remediationDir = path.join(resolvedSpecDir, 'remediation');
      const remediationSpecs = await scanMdFiles(remediationDir);
      const hasRemediation = remediationSpecs.length > 0;

      return {
        cost,
        artifacts: {
          specDir: resolvedSpecDir,
          ...(hasRemediation && {
            hasRemediation: 'true',
            remediationDir,
          }),
        },
      };
    },

    async runProof(pipeline, options): Promise<StageResult> {
      const cwd = await resolveWorkingDir(options.cwd);
      const persistBase = options.persistDir || cwd;
      const stage = findStage(pipeline, 'proof');
      const specDir = stage.artifacts.specDir || options.specDir;
      if (!specDir) {
        throw new Error('proof stage requires specDir artifact');
      }
      const resolvedSpecDir = path.resolve(cwd, specDir);
      const proofDir = path.join(persistBase, '.forge', 'proofs', pipeline.id);

      const before = Date.now();

      await realRunProof({
        specPaths: [resolvedSpecDir],
        outputDir: proofDir,
        cwd,
        persistDir: options.persistDir,
        model: options.model,
        quiet: options.quiet,
        verbose: options.verbose,
      });

      const cost = extractCostFromRuns(persistBase, before);

      // Read manifest to get accurate proof count
      let proofCount = 0;
      try {
        const manifestRaw = await fs.readFile(path.join(proofDir, 'manifest.json'), 'utf-8');
        const manifest: ProofManifest = JSON.parse(manifestRaw);
        proofCount = manifest.entries.length;
      } catch {
        // No manifest — agent may have failed to write it
      }

      return {
        cost,
        artifacts: {
          proofDir,
          proofCount: String(proofCount),
        },
      };
    },

    async runVerify(pipeline, options): Promise<StageResult> {
      const cwd = await resolveWorkingDir(options.cwd);
      const persistBase = options.persistDir || cwd;
      const stage = findStage(pipeline, 'verify');
      const proofDir = stage.artifacts.proofDir;
      if (!proofDir) {
        throw new Error(
          'verify stage requires proofDir artifact (from proof stage)',
        );
      }

      const before = Date.now();

      await realRunVerify({
        proofDir,
        cwd,
        persistDir: options.persistDir,
        model: options.model,
        quiet: options.quiet,
      });

      const cost = extractCostFromRuns(persistBase, before);

      return {
        cost,
        artifacts: { proofDir },
      };
    },
  };
}

// ── Stage Executor ───────────────────────────────────────────

/** Dispatch to the correct execution provider method for a given stage. */
async function executeStage(
  executor: ExecutionProvider,
  stageName: StageName,
  pipeline: Pipeline,
  options: PipelineOptions,
): Promise<StageResult> {
  switch (stageName) {
    case 'define':
      return executor.runDefine(pipeline, options);
    case 'run':
      return executor.runForge(pipeline, options);
    case 'audit':
      return executor.runAudit(pipeline, options);
    case 'proof':
      return executor.runProof(pipeline, options);
    case 'verify':
      return executor.runVerify(pipeline, options);
  }
}

// ── Gate Polling ────────────────────────────────────────────

/** How often (ms) to check for gate resolution while paused. */
const GATE_POLL_INTERVAL_MS = 2_000;

/**
 * Poll the state file until a gate is resolved (approved or skipped)
 * or the pipeline is interrupted/cancelled. Returns true if the gate
 * was resolved, false if interrupted.
 */
async function pollForGateResolution(
  pipelineId: string,
  gateKey: GateKey,
  stateProvider: StateProvider,
): Promise<boolean> {
  while (true) {
    if (isInterrupted()) return false;
    await sleep(GATE_POLL_INTERVAL_MS);
    if (isInterrupted()) return false;

    const current = await stateProvider.loadPipeline(pipelineId);
    if (!current) return false;

    const gate = current.gates[gateKey];
    if (gate.status === 'approved' || gate.status === 'skipped') {
      return true;
    }

    // Pipeline was cancelled externally (e.g. TUI cancel action)
    if (current.status === 'cancelled') return false;
  }
}

// ── Core Orchestration Loop ──────────────────────────────────

/**
 * Run a pipeline through its stages sequentially. Checks gates
 * between stages, delegates execution via the ExecutionProvider,
 * and persists state after every transition.
 *
 * Returns the pipeline in its final state after either:
 * - All stages complete (status: 'completed')
 * - A gate pauses execution (status: 'paused_at_gate')
 * - A stage fails (status: 'failed')
 *
 * To resume after a gate pause, call advanceGate() then runPipeline()
 * again with options.resume set to the pipeline ID.
 */
export async function runPipeline(
  options: PipelineOptions,
  stateProvider: StateProvider,
  eventProvider?: EventProvider,
  executionProvider?: ExecutionProvider,
): Promise<Pipeline> {
  const events = eventProvider ?? noopEventProvider;
  const executor = executionProvider ?? createDefaultExecutionProvider();

  // ── Load or create pipeline ────────────────────────────────
  let pipeline: Pipeline;
  if (options.resume) {
    const loaded = await stateProvider.loadPipeline(options.resume);
    if (!loaded) {
      throw new ForgeError(
        `Cannot resume pipeline: no pipeline found with ID "${options.resume}". ` +
        `Check available pipelines with "forge pipeline" or start a new one.`,
      );
    }
    pipeline = loaded;
  } else {
    pipeline = await stateProvider.createPipeline(options);
  }

  // ── Record process PID for stale pipeline detection ────────
  pipeline.pid = process.pid;
  pipeline.updatedAt = new Date().toISOString();
  await stateProvider.savePipeline(pipeline);

  // ── Apply user gate overrides ──────────────────────────────
  if (options.gates) {
    for (const [key, type] of Object.entries(options.gates)) {
      const gate = pipeline.gates[key as GateKey];
      if (gate && type) {
        gate.type = type;
      }
    }
    pipeline.updatedAt = new Date().toISOString();
    await stateProvider.savePipeline(pipeline);
  }

  // ── Worktree setup ─────────────────────────────────────────
  // Every pipeline runs in a dedicated git worktree for isolation.
  // The original repo's .forge/ directory receives all persistence
  // writes (sessions, results, manifest) via persistDir.
  const originalCwd = await resolveWorkingDir(options.cwd);

  if (!options.resume) {
    // New pipeline: create a fresh worktree
    const branch = `forge-${pipeline.id}`;
    let worktreePath: string;
    try {
      worktreePath = await createWorktree(originalCwd, branch);
    } catch (err) {
      // Worktree creation failed — mark pipeline as failed and bail
      const errorMsg = err instanceof Error ? err.message : String(err);
      pipeline.status = 'failed';
      pipeline.updatedAt = new Date().toISOString();
      await stateProvider.savePipeline(pipeline);

      await events.publish({
        type: 'pipeline_failed',
        pipelineId: pipeline.id,
        timestamp: new Date().toISOString(),
        stage: 'define',
        error: `Worktree creation failed: ${errorMsg}`,
      });

      return pipeline;
    }

    // Store worktree info in pipeline record
    pipeline.worktreePath = worktreePath;
    pipeline.branch = branch;
    pipeline.updatedAt = new Date().toISOString();
    await stateProvider.savePipeline(pipeline);

    if (!options.quiet) {
      console.log(`\x1b[2m[forge]\x1b[0m Worktree: ${worktreePath} (branch: ${branch})`);
    }

    // ── Run workspace setup hooks ─────────────────────────────
    const config = getConfig(originalCwd);
    const setupCommands = await resolveSetupCommands(worktreePath, config);

    if (setupCommands.length > 0) {
      if (!options.quiet) {
        console.log(`\x1b[2m[forge]\x1b[0m Running workspace setup (${setupCommands.length} command${setupCommands.length > 1 ? 's' : ''})...`);
      }

      const setupResult = await runWorkspaceHooks(
        setupCommands,
        worktreePath,
        config.setupTimeout,
        options.quiet,
      );

      if (!setupResult.success) {
        // Setup failed -- mark pipeline and first stage as failed, then clean up worktree
        const errorMsg = `Workspace setup failed: ${setupResult.failedCommand}\n${setupResult.output}`;
        pipeline.status = 'failed';
        pipeline.stages[0].status = 'failed';
        pipeline.updatedAt = new Date().toISOString();
        await stateProvider.savePipeline(pipeline);

        await events.publish({
          type: 'pipeline_failed',
          pipelineId: pipeline.id,
          timestamp: new Date().toISOString(),
          stage: 'define',
          error: errorMsg,
        });

        // Best-effort worktree cleanup after setup failure
        try {
          await cleanupWorktree(worktreePath, originalCwd);
        } catch {
          // Best effort
        }

        return pipeline;
      }

      if (!options.quiet) {
        console.log(`\x1b[2m[forge]\x1b[0m Workspace setup complete`);
      }

      // Persist setup output for debugging (truncate to 10KB)
      const MAX_HOOK_OUTPUT = 10 * 1024;
      const setupOutput = setupResult.output.length > MAX_HOOK_OUTPUT
        ? setupResult.output.slice(0, MAX_HOOK_OUTPUT) + '\n... (truncated)'
        : setupResult.output;

      await events.publish({
        type: 'workspace_setup',
        pipelineId: pipeline.id,
        timestamp: new Date().toISOString(),
        output: setupOutput,
      });
    }
  } else if (pipeline.worktreePath) {
    // Resuming: verify the worktree still exists
    try {
      await fs.access(pipeline.worktreePath);
    } catch {
      // Worktree was cleaned up — recreate it
      const branch = pipeline.branch || `forge-${pipeline.id}`;
      try {
        const worktreePath = await createWorktree(originalCwd, branch);
        pipeline.worktreePath = worktreePath;
        pipeline.branch = branch;
        pipeline.updatedAt = new Date().toISOString();
        await stateProvider.savePipeline(pipeline);

        // Run workspace setup hooks in the recreated worktree
        const config = getConfig(originalCwd);
        const setupCommands = await resolveSetupCommands(worktreePath, config);

        if (setupCommands.length > 0) {
          if (!options.quiet) {
            console.log(`\x1b[2m[forge]\x1b[0m Running workspace setup (${setupCommands.length} command${setupCommands.length > 1 ? 's' : ''})...`);
          }

          const setupResult = await runWorkspaceHooks(
            setupCommands,
            worktreePath,
            config.setupTimeout,
            options.quiet,
          );

          if (!setupResult.success) {
            const errorMsg = `Workspace setup failed on resume: ${setupResult.failedCommand}\n${setupResult.output}`;
            pipeline.status = 'failed';
            pipeline.stages[0].status = 'failed';
            pipeline.updatedAt = new Date().toISOString();
            await stateProvider.savePipeline(pipeline);

            await events.publish({
              type: 'pipeline_failed',
              pipelineId: pipeline.id,
              timestamp: new Date().toISOString(),
              stage: 'define',
              error: errorMsg,
            });

            // Best-effort worktree cleanup after setup failure
            try {
              await cleanupWorktree(worktreePath, originalCwd);
            } catch {
              // Best effort
            }

            return pipeline;
          }

          if (!options.quiet) {
            console.log(`\x1b[2m[forge]\x1b[0m Workspace setup complete`);
          }

          // Persist setup output for debugging (truncate to 10KB)
          const MAX_HOOK_OUTPUT = 10 * 1024;
          const setupOutput = setupResult.output.length > MAX_HOOK_OUTPUT
            ? setupResult.output.slice(0, MAX_HOOK_OUTPUT) + '\n... (truncated)'
            : setupResult.output;

          await events.publish({
            type: 'workspace_setup',
            pipelineId: pipeline.id,
            timestamp: new Date().toISOString(),
            output: setupOutput,
          });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        pipeline.status = 'failed';
        pipeline.updatedAt = new Date().toISOString();
        await stateProvider.savePipeline(pipeline);

        await events.publish({
          type: 'pipeline_failed',
          pipelineId: pipeline.id,
          timestamp: new Date().toISOString(),
          stage: 'define',
          error: `Worktree recreation failed on resume: ${errorMsg}`,
        });

        return pipeline;
      }
    }
  }

  // Override options to route execution through the worktree
  // and persist .forge/ writes to the original repo
  if (pipeline.worktreePath) {
    options = {
      ...options,
      cwd: pipeline.worktreePath,
      persistDir: originalCwd,
    };
  }

  // ── Determine starting index ───────────────────────────────
  const fromIndex = options.fromStage
    ? STAGE_ORDER.indexOf(options.fromStage)
    : findFirstActionableIndex(pipeline);

  // ── Mark earlier stages as skipped (for --from) ────────────
  if (options.fromStage) {
    for (let i = 0; i < fromIndex; i++) {
      const stage = findStage(pipeline, STAGE_ORDER[i]);
      if (stage.status === 'pending') {
        stage.status = 'skipped';
      }
    }
  }

  // ── Seed artifacts from --spec-dir ─────────────────────────
  if (options.specDir) {
    const cwd = await resolveWorkingDir(options.cwd);
    const resolvedSpecDir = path.resolve(cwd, options.specDir);

    const defineStage = findStage(pipeline, 'define');
    if (defineStage.status === 'pending') {
      defineStage.status = 'skipped';
    }

    const runStage = findStage(pipeline, 'run');
    runStage.artifacts.specDir = resolvedSpecDir;
  }

  // ── Set pipeline to running ────────────────────────────────
  pipeline.status = 'running';
  pipeline.updatedAt = new Date().toISOString();
  await stateProvider.savePipeline(pipeline);

  // ── Execute stages (wrapped in try/finally for worktree cleanup) ──
  try {
  for (let i = fromIndex; i < STAGE_ORDER.length; i++) {
    const stageName = STAGE_ORDER[i];
    let stage = findStage(pipeline, stageName);

    // Skip completed/skipped stages (resume scenario)
    if (stage.status === 'completed' || stage.status === 'skipped') {
      continue;
    }

    // ── Check for interrupt before starting next stage ───────
    if (isInterrupted()) {
      cancelPipeline(pipeline, stageName);
      await stateProvider.savePipeline(pipeline);

      await events.publish({
        type: 'pipeline_cancelled',
        pipelineId: pipeline.id,
        timestamp: new Date().toISOString(),
        stage: stageName,
      });

      return pipeline;
    }

    // ── Check inter-stage gate ─────────────────────────────
    if (i > 0) {
      const prevName = STAGE_ORDER[i - 1];
      const key = makeGateKey(prevName, stageName);
      const gate = pipeline.gates[key];

      if (gate && (gate.type === 'confirm' || gate.type === 'review')) {
        if (gate.status !== 'approved' && gate.status !== 'skipped') {
          // Non-auto gate not yet resolved -- pause and poll
          gate.status = 'waiting';
          pipeline.status = 'paused_at_gate';
          pipeline.updatedAt = new Date().toISOString();
          await stateProvider.savePipeline(pipeline);

          await events.publish({
            type: 'gate_pause',
            pipelineId: pipeline.id,
            timestamp: new Date().toISOString(),
            gate: key,
            gateType: gate.type,
          });

          // ── Poll for gate resolution (single-writer model) ──
          // The pipeline process stays alive and polls the state
          // file for gate changes made by TUI or MCP. This avoids
          // needing external processes to spawn --resume.
          const resolved = await pollForGateResolution(
            pipeline.id, key, stateProvider,
          );

          if (!resolved) {
            // Interrupted while waiting — cancel
            cancelPipeline(pipeline, stageName);
            await stateProvider.savePipeline(pipeline);
            await events.publish({
              type: 'pipeline_cancelled',
              pipelineId: pipeline.id,
              timestamp: new Date().toISOString(),
              stage: stageName,
            });
            return pipeline;
          }

          // Reload full pipeline state (TUI/MCP may have mutated other fields)
          const reloaded = await stateProvider.loadPipeline(pipeline.id);
          if (!reloaded) {
            throw new ForgeError(`Pipeline ${pipeline.id} disappeared during gate wait`);
          }
          pipeline = reloaded;

          // If gate was skipped, also skip the target stage
          const resolvedGate = pipeline.gates[key];
          if (resolvedGate.status === 'skipped') {
            const stage = findStage(pipeline, stageName);
            stage.status = 'skipped';
            pipeline.updatedAt = new Date().toISOString();
            await stateProvider.savePipeline(pipeline);
            continue; // Move to next stage
          }

          // Gate approved — mark pipeline running and re-derive stage
          // (pipeline was reloaded from disk, old stage ref is stale)
          stage = findStage(pipeline, stageName);
          pipeline.status = 'running';
          pipeline.updatedAt = new Date().toISOString();
          await stateProvider.savePipeline(pipeline);
        }
      }
      // auto gate: advance immediately (no action needed)
    }

    // ── Propagate artifacts from previous stages ───────────
    propagateArtifacts(pipeline, stageName);

    // ── Mark stage as running ──────────────────────────────
    stage.status = 'running';
    stage.startedAt = new Date().toISOString();
    pipeline.updatedAt = new Date().toISOString();
    await stateProvider.savePipeline(pipeline);

    await events.publish({
      type: 'stage_start',
      pipelineId: pipeline.id,
      timestamp: new Date().toISOString(),
      stage: stageName,
    });

    // ── Execute the stage ──────────────────────────────────
    const cwd = await resolveWorkingDir(options.cwd);
    const persistBase = options.persistDir || cwd;
    const sessionsBefore = await snapshotSessionIds(persistBase);

    try {
      const result = await executeStage(executor, stageName, pipeline, options);

      // Capture new session IDs created during this stage
      const sessionsAfter = await snapshotSessionIds(persistBase);
      for (const sid of sessionsAfter) {
        if (!sessionsBefore.has(sid)) stage.sessions.push(sid);
      }

      // Update stage with results
      stage.status = 'completed';
      stage.cost = result.cost;
      stage.artifacts = { ...stage.artifacts, ...result.artifacts };
      stage.completedAt = new Date().toISOString();
      stage.duration =
        (new Date(stage.completedAt).getTime() -
          new Date(stage.startedAt!).getTime()) /
        1000;

      // Accumulate pipeline cost
      pipeline.totalCost += result.cost;
      pipeline.updatedAt = new Date().toISOString();
      await stateProvider.savePipeline(pipeline);

      await events.publish({
        type: 'stage_complete',
        pipelineId: pipeline.id,
        timestamp: new Date().toISOString(),
        stage: stageName,
        cost: result.cost,
        duration: stage.duration,
        artifacts: result.artifacts,
      });

      // Dynamic gate: audit with unresolved remediation forces confirm
      // gate before proof, even if user overrode to auto. This prevents
      // running proof on a codebase with known remaining gaps.
      if (
        stageName === 'audit' &&
        result.artifacts.hasRemediation === 'true'
      ) {
        const auditProveKey = makeGateKey('audit', 'proof');
        pipeline.gates[auditProveKey].type = 'confirm';
        pipeline.updatedAt = new Date().toISOString();
        await stateProvider.savePipeline(pipeline);
      }
    } catch (err) {
      // ── Interrupt during execution → cancel ────────────
      if (isInterrupted()) {
        cancelPipeline(pipeline, stageName);
        await stateProvider.savePipeline(pipeline);

        await events.publish({
          type: 'pipeline_cancelled',
          pipelineId: pipeline.id,
          timestamp: new Date().toISOString(),
          stage: stageName,
        });

        return pipeline;
      }

      // ── Stage failure ──────────────────────────────────
      const errorMsg = err instanceof Error ? err.message : String(err);

      stage.status = 'failed';
      stage.error = errorMsg;
      stage.completedAt = new Date().toISOString();
      if (stage.startedAt) {
        stage.duration =
          (new Date(stage.completedAt).getTime() -
            new Date(stage.startedAt).getTime()) /
          1000;
      }

      pipeline.status = 'failed';
      pipeline.updatedAt = new Date().toISOString();
      await stateProvider.savePipeline(pipeline);

      await events.publish({
        type: 'stage_failed',
        pipelineId: pipeline.id,
        timestamp: new Date().toISOString(),
        stage: stageName,
        error: errorMsg,
      });

      await events.publish({
        type: 'pipeline_failed',
        pipelineId: pipeline.id,
        timestamp: new Date().toISOString(),
        stage: stageName,
        error: errorMsg,
      });

      return pipeline;
    }
  }

  // ── All stages completed ───────────────────────────────────
  const now = new Date().toISOString();
  pipeline.status = 'completed';
  pipeline.completedAt = now;
  pipeline.updatedAt = now;
  await stateProvider.savePipeline(pipeline);

  const totalDuration =
    (new Date(now).getTime() - new Date(pipeline.createdAt).getTime()) / 1000;

  await events.publish({
    type: 'pipeline_complete',
    pipelineId: pipeline.id,
    timestamp: now,
    totalCost: pipeline.totalCost,
    totalDuration,
  });

  return pipeline;

  } finally {
    // ── Worktree cleanup ─────────────────────────────────────
    // Always clean up the worktree when the pipeline reaches a
    // terminal state (completed, failed, cancelled). For pipelines
    // paused at a gate, the worktree is preserved for the resume.
    if (pipeline.worktreePath && pipeline.branch) {
      const isTerminal = pipeline.status === 'completed' ||
        pipeline.status === 'failed' || pipeline.status === 'cancelled';

      if (isTerminal) {
        // Commit changes on success before cleanup
        if (pipeline.status === 'completed') {
          try {
            const committed = await commitWorktree(pipeline.worktreePath, pipeline.branch);
            if (!options.quiet && committed) {
              console.log(`\x1b[2m[forge]\x1b[0m Committed changes to branch \x1b[1m${pipeline.branch}\x1b[0m`);
            }
          } catch {
            // Best effort — don't fail the pipeline on commit error
          }
        }

        // Run teardown hooks before removing the worktree
        try {
          const teardownConfig = getConfig(originalCwd);
          const teardownCommands = resolveTeardownCommands(teardownConfig);

          if (teardownCommands.length > 0) {
            if (!options.quiet) {
              console.log(`\x1b[2m[forge]\x1b[0m Running workspace teardown (${teardownCommands.length} command${teardownCommands.length > 1 ? 's' : ''})...`);
            }

            const teardownResult = await runWorkspaceHooks(
              teardownCommands,
              pipeline.worktreePath,
              teardownConfig.setupTimeout,
              options.quiet,
            );

            // Persist teardown output for debugging (truncate to 10KB)
            const MAX_TEARDOWN_OUTPUT = 10 * 1024;
            const teardownOutput = teardownResult.output.length > MAX_TEARDOWN_OUTPUT
              ? teardownResult.output.slice(0, MAX_TEARDOWN_OUTPUT) + '\n... (truncated)'
              : teardownResult.output;

            await events.publish({
              type: 'workspace_teardown',
              pipelineId: pipeline.id,
              timestamp: new Date().toISOString(),
              output: teardownOutput,
            });

            if (!teardownResult.success && !options.quiet) {
              console.log(`\x1b[2m[forge]\x1b[0m Teardown warning: ${teardownResult.failedCommand}`);
            }
          }
        } catch {
          // Best effort — don't fail the pipeline on teardown error
        }

        // Clean up the worktree
        try {
          await cleanupWorktree(pipeline.worktreePath, originalCwd);
          if (!options.quiet) {
            console.log(`\x1b[2m[forge]\x1b[0m Cleaned up worktree for branch \x1b[1m${pipeline.branch}\x1b[0m`);
          }
        } catch {
          // Best effort — don't throw during cleanup
        }
      }
    }
  }
}

// ── Gate Advancement ─────────────────────────────────────────

/**
 * Approve a waiting gate, allowing the pipeline to advance past it.
 * Call this after runPipeline() returns with status 'paused_at_gate',
 * then call runPipeline() again with options.resume to continue.
 */
export async function advanceGate(
  pipeline: Pipeline,
  gate: GateKey,
  stateProvider: StateProvider,
  eventProvider?: EventProvider,
): Promise<void> {
  const events = eventProvider ?? noopEventProvider;
  const gateObj = pipeline.gates[gate];

  if (!gateObj) throw new Error(`Gate not found: ${gate}`);
  if (gateObj.status !== 'waiting') {
    throw new Error(
      `Gate ${gate} is not waiting (current status: ${gateObj.status})`,
    );
  }

  gateObj.status = 'approved';
  gateObj.approvedAt = new Date().toISOString();

  // Reset pipeline status so runPipeline can continue
  if (pipeline.status === 'paused_at_gate') {
    pipeline.status = 'running';
  }

  pipeline.updatedAt = new Date().toISOString();
  await stateProvider.savePipeline(pipeline);

  await events.publish({
    type: 'gate_advance',
    pipelineId: pipeline.id,
    timestamp: new Date().toISOString(),
    gate,
    resolution: 'approved',
  });
}

/**
 * Skip a waiting gate without approval. The pipeline advances but
 * the gate is marked as 'skipped' rather than 'approved'.
 */
export async function skipGate(
  pipeline: Pipeline,
  gate: GateKey,
  stateProvider: StateProvider,
  eventProvider?: EventProvider,
): Promise<void> {
  const events = eventProvider ?? noopEventProvider;
  const gateObj = pipeline.gates[gate];

  if (!gateObj) throw new Error(`Gate not found: ${gate}`);
  if (gateObj.status !== 'waiting') {
    throw new Error(
      `Gate ${gate} is not waiting (current status: ${gateObj.status})`,
    );
  }

  gateObj.status = 'skipped';
  gateObj.approvedAt = new Date().toISOString();

  if (pipeline.status === 'paused_at_gate') {
    pipeline.status = 'running';
  }

  pipeline.updatedAt = new Date().toISOString();
  await stateProvider.savePipeline(pipeline);

  await events.publish({
    type: 'gate_advance',
    pipelineId: pipeline.id,
    timestamp: new Date().toISOString(),
    gate,
    resolution: 'skipped',
  });
}

