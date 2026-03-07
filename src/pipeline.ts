// ── Pipeline Orchestration Core Loop ─────────────────────────
//
// Drives a pipeline through its stages sequentially: define -> run ->
// audit -> prove -> verify. Checks gates between stages, delegates
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
import { runProve as realRunProve } from './prove.js';
import { runVerify as realRunVerify } from './proof-runner.js';
import { resolveWorkingDir, ForgeError } from './utils.js';
import { isInterrupted } from './abort.js';
import { promises as fs } from 'fs';
import path from 'path';
import type { ForgeResult } from './types.js';

// ── Constants ────────────────────────────────────────────────

// ── No-op Providers ──────────────────────────────────────────

/** No-op event provider used when none is supplied. */
const noopEventProvider: EventProvider = {
  publish: async () => {},
  subscribe: () => () => {},
};

// ── Internal Helpers ─────────────────────────────────────────

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
 * Scan .forge/results/ for result summaries created after `sinceMs`
 * and return the total cost. Uses file modification time for filtering.
 */
async function extractCostFromResults(cwd: string, sinceMs: number): Promise<number> {
  const resultsBase = path.join(cwd, '.forge', 'results');
  let dirs: string[];
  try {
    dirs = await fs.readdir(resultsBase);
  } catch {
    return 0;
  }

  let total = 0;
  for (const dir of dirs) {
    try {
      const summaryPath = path.join(resultsBase, dir, 'summary.json');
      const stat = await fs.stat(summaryPath);
      if (stat.mtimeMs < sinceMs) continue;
      const summary: ForgeResult = JSON.parse(
        await fs.readFile(summaryPath, 'utf-8'),
      );
      if (summary.costUsd) total += summary.costUsd;
    } catch {
      continue;
    }
  }
  return total;
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
 * functions (runDefine, runForge, runAudit, runProve, runVerify)
 * without modifying them. Extracts cost from .forge/results/ and
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
        model: options.model,
        quiet: options.quiet,
        verbose: options.verbose,
      });

      const cost = await extractCostFromResults(cwd, before);
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
        model: options.model,
        quiet: options.quiet,
        verbose: options.verbose,
      });

      const cost = await extractCostFromResults(cwd, before);

      return {
        cost,
        artifacts: { specDir: resolvedSpecDir },
      };
    },

    async runAudit(pipeline, options): Promise<StageResult> {
      const cwd = await resolveWorkingDir(options.cwd);
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
        model: options.model,
        quiet: options.quiet,
        verbose: options.verbose,
        fix: true,
      });

      const cost = await extractCostFromResults(cwd, before);

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

    async runProve(pipeline, options): Promise<StageResult> {
      const cwd = await resolveWorkingDir(options.cwd);
      const stage = findStage(pipeline, 'prove');
      const specDir = stage.artifacts.specDir || options.specDir;
      if (!specDir) {
        throw new Error('prove stage requires specDir artifact');
      }
      const resolvedSpecDir = path.resolve(cwd, specDir);
      const proofDir = path.join(cwd, '.forge', 'proofs');

      const before = Date.now();

      await realRunProve({
        specPath: resolvedSpecDir,
        outputDir: proofDir,
        cwd,
        model: options.model,
        quiet: options.quiet,
        verbose: options.verbose,
      });

      const cost = await extractCostFromResults(cwd, before);
      const proofs = await scanMdFiles(proofDir);

      return {
        cost,
        artifacts: {
          proofDir,
          proofCount: String(proofs.length),
        },
      };
    },

    async runVerify(pipeline, options): Promise<StageResult> {
      const cwd = await resolveWorkingDir(options.cwd);
      const stage = findStage(pipeline, 'verify');
      const proofDir = stage.artifacts.proofDir;
      if (!proofDir) {
        throw new Error(
          'verify stage requires proofDir artifact (from prove stage)',
        );
      }

      const before = Date.now();

      await realRunVerify({
        proofDir,
        cwd,
        model: options.model,
        quiet: options.quiet,
      });

      const cost = await extractCostFromResults(cwd, before);

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
    case 'prove':
      return executor.runProve(pipeline, options);
    case 'verify':
      return executor.runVerify(pipeline, options);
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

  // ── Execute stages ─────────────────────────────────────────
  for (let i = fromIndex; i < STAGE_ORDER.length; i++) {
    const stageName = STAGE_ORDER[i];
    const stage = findStage(pipeline, stageName);

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
        if (gate.status !== 'approved') {
          // Non-auto gate not yet approved -- pause the pipeline
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

          return pipeline;
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
    try {
      const result = await executeStage(executor, stageName, pipeline, options);

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
      // gate before prove, even if user overrode to auto. This prevents
      // running prove on a codebase with known remaining gaps.
      if (
        stageName === 'audit' &&
        result.artifacts.hasRemediation === 'true'
      ) {
        const auditProveKey = makeGateKey('audit', 'prove');
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

