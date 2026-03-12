// ── Filesystem Pipeline State Provider ────────────────────────
//
// Implements StateProvider using the local filesystem.
// Active pipeline: .forge/pipeline.json
// Historical pipelines: .forge/pipelines/{id}.json
// All writes are atomic (tmp file -> rename) with file-based locking.

import type {
  Pipeline,
  PipelineOptions,
  StateProvider,
  Stage,
  Gate,
  GateKey,
  StageName,
} from './pipeline-types.js';
import { STAGE_ORDER, DEFAULT_GATES } from './pipeline-types.js';
import { promises as fs } from 'fs';
import path from 'path';
import { ensureForgeDir } from './utils.js';

// ── Constants ────────────────────────────────────────────────

const PIPELINE_FILE = 'pipeline.json';
const PIPELINE_LOCK = 'pipeline.json.lock';
const PIPELINES_DIR = 'pipelines';
const LOCK_STALE_MS = 30_000; // 30 seconds

// ── Paths ────────────────────────────────────────────────────

function pipelinePath(workingDir: string): string {
  return path.join(workingDir, '.forge', PIPELINE_FILE);
}

function lockFilePath(workingDir: string): string {
  return path.join(workingDir, '.forge', PIPELINE_LOCK);
}

function pipelinesDir(workingDir: string): string {
  return path.join(workingDir, '.forge', PIPELINES_DIR);
}

function pipelineFilePath(workingDir: string, id: string): string {
  return path.join(pipelinesDir(workingDir), `${id}.json`);
}

// ── File-based lock (same pattern as specs.ts) ───────────────

async function acquireLock(workingDir: string, maxRetries = 10): Promise<void> {
  const lp = lockFilePath(workingDir);
  await ensureForgeDir(workingDir);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // O_CREAT | O_EXCL: atomic create-if-not-exists
      const fd = await fs.open(lp, 'wx');
      await fd.writeFile(String(Date.now()));
      await fd.close();
      return; // Lock acquired
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      // Lock file exists -- check staleness
      try {
        const content = await fs.readFile(lp, 'utf-8');
        const lockTime = parseInt(content, 10);
        if (!isNaN(lockTime) && Date.now() - lockTime > LOCK_STALE_MS) {
          // Stale lock -- remove and retry
          await fs.unlink(lp).catch(() => {});
          continue;
        }
      } catch {
        // Can't read lock file -- remove and retry
        await fs.unlink(lp).catch(() => {});
        continue;
      }

      // Backoff: 50ms * 2^attempt (max ~25s total)
      const delay = 50 * Math.pow(2, Math.min(attempt, 8));
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw new Error('Could not acquire pipeline lock after retries');
}

async function releaseLock(workingDir: string): Promise<void> {
  await fs.unlink(lockFilePath(workingDir)).catch(() => {});
}

// ── Atomic write helpers ─────────────────────────────────────

/** Atomic write: write to tmp, then rename. */
async function atomicWrite(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, filePath);
}

/** Read and parse a JSON file. Returns null if file does not exist. */
async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

// ── Pipeline factory ─────────────────────────────────────────

/** Generate a short, sortable pipeline ID. */
function generatePipelineId(): string {
  return Date.now().toString(36);
}

/** Build the default gate configuration. */
function buildGates(overrides?: Partial<Record<GateKey, import('./pipeline-types.js').GateType>>): Record<GateKey, Gate> {
  const keys: GateKey[] = ['define -> run', 'run -> audit', 'audit -> proof', 'proof -> verify'];
  const gates = {} as Record<GateKey, Gate>;
  for (const key of keys) {
    gates[key] = {
      type: overrides?.[key] ?? DEFAULT_GATES[key],
      status: 'waiting',
    };
  }
  return gates;
}

/** Build the initial 5-stage array. */
function buildStages(fromStage?: StageName): Stage[] {
  const startIdx = fromStage ? STAGE_ORDER.indexOf(fromStage) : 0;
  return STAGE_ORDER.map((name, i): Stage => ({
    name,
    status: i < startIdx ? 'skipped' : 'pending',
    cost: 0,
    duration: 0,
    sessions: [],
    artifacts: {},
  }));
}

/** Create a new Pipeline object from options. */
function createPipelineObject(options: PipelineOptions): Pipeline {
  const now = new Date().toISOString();
  return {
    id: generatePipelineId(),
    goal: options.goal,
    status: 'pending',
    stages: buildStages(options.fromStage),
    gates: buildGates(options.gates),
    totalCost: 0,
    createdAt: now,
    updatedAt: now,
    // worktreePath and branch are populated after worktree creation in runPipeline
  };
}

// ── Locked pipeline update ───────────────────────────────────

/**
 * Atomically update the active pipeline with file locking.
 * Acquires lock, runs the updater, writes back.
 */
async function withPipelineLock(
  workingDir: string,
  updater: () => void | Promise<void>,
): Promise<void> {
  await acquireLock(workingDir);
  try {
    await updater();
  } finally {
    await releaseLock(workingDir);
  }
}

// ── FileSystemStateProvider ──────────────────────────────────

export class FileSystemStateProvider implements StateProvider {
  private workingDir: string;

  constructor(workingDir?: string) {
    this.workingDir = workingDir ?? process.cwd();
  }

  async createPipeline(options: PipelineOptions): Promise<Pipeline> {
    const pipeline = createPipelineObject(options);

    await withPipelineLock(this.workingDir, async () => {
      // Write as active pipeline
      await atomicWrite(pipelinePath(this.workingDir), pipeline);
      // Write to historical pipelines
      await atomicWrite(pipelineFilePath(this.workingDir, pipeline.id), pipeline);
    });

    return pipeline;
  }

  async loadPipeline(id: string): Promise<Pipeline | null> {
    return readJson<Pipeline>(pipelineFilePath(this.workingDir, id));
  }

  async savePipeline(pipeline: Pipeline): Promise<void> {
    await withPipelineLock(this.workingDir, async () => {
      // Update active pipeline
      await atomicWrite(pipelinePath(this.workingDir), pipeline);
      // Copy to historical pipelines
      await atomicWrite(pipelineFilePath(this.workingDir, pipeline.id), pipeline);
    });
  }

  async loadActivePipeline(): Promise<Pipeline | null> {
    return readJson<Pipeline>(pipelinePath(this.workingDir));
  }

  async listPipelines(): Promise<Pipeline[]> {
    const dir = pipelinesDir(this.workingDir);
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      return [];
    }

    const pipelines: Pipeline[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const pipeline = await readJson<Pipeline>(path.join(dir, file));
      if (pipeline) pipelines.push(pipeline);
    }

    // Sort by createdAt descending (most recent first)
    pipelines.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return pipelines;
  }
}
