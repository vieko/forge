// ── SQLite Pipeline State Provider ─────────────────────────────
//
// Implements StateProvider using SQLite tables (pipelines, stages, gates).
// Uses the shared database from db.ts with migration version 3.
// FileSystemStateProvider remains available as fallback when DB is null.

import type { Database } from 'bun:sqlite';
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

// ── Row types (DB column shapes) ──────────────────────────────

interface PipelineRow {
  id: string;
  goal: string;
  status: string;
  branch: string | null;
  worktree_path: string | null;
  total_cost: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface StageRow {
  pipeline_id: string;
  name: string;
  status: string;
  cost: number;
  duration: number;
  sessions: string; // JSON array
  artifacts: string; // JSON object
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
}

interface GateRow {
  pipeline_id: string;
  from_stage: string;
  to_stage: string;
  type: string;
  status: string;
  approved_at: string | null;
}

// ── Pipeline ID generator ────────────────────────────────────

function generatePipelineId(): string {
  return Date.now().toString(36);
}

// ── Gate key helpers ─────────────────────────────────────────

const GATE_KEYS: GateKey[] = [
  'define -> run',
  'run -> audit',
  'audit -> proof',
  'proof -> verify',
];

/** Parse a GateKey into [fromStage, toStage]. */
function parseGateKey(key: GateKey): [string, string] {
  const parts = key.split(' -> ');
  return [parts[0], parts[1]];
}

/** Build a GateKey from from/to stage names. */
function toGateKey(from: string, to: string): GateKey {
  return `${from} -> ${to}` as GateKey;
}

// ── Row-to-object mappers ────────────────────────────────────

function rowToStage(row: StageRow): Stage {
  const stage: Stage = {
    name: row.name as StageName,
    status: row.status as Stage['status'],
    cost: row.cost,
    duration: row.duration,
    sessions: JSON.parse(row.sessions) as string[],
    artifacts: JSON.parse(row.artifacts) as Record<string, string>,
  };
  if (row.started_at) stage.startedAt = row.started_at;
  if (row.completed_at) stage.completedAt = row.completed_at;
  if (row.error) stage.error = row.error;
  return stage;
}

function rowToGate(row: GateRow): Gate {
  const gate: Gate = {
    type: row.type as Gate['type'],
    status: row.status as Gate['status'],
  };
  if (row.approved_at) gate.approvedAt = row.approved_at;
  return gate;
}

function rowsToPipeline(
  pipelineRow: PipelineRow,
  stageRows: StageRow[],
  gateRows: GateRow[],
): Pipeline {
  // Build stages in canonical order
  const stageMap = new Map<string, StageRow>();
  for (const row of stageRows) {
    stageMap.set(row.name, row);
  }
  const stages: Stage[] = STAGE_ORDER.map((name) => {
    const row = stageMap.get(name);
    if (row) return rowToStage(row);
    // Fallback: stage not in DB (should not happen, but defensive)
    return {
      name,
      status: 'pending' as const,
      cost: 0,
      duration: 0,
      sessions: [],
      artifacts: {},
    };
  });

  // Build gates record
  const gates = {} as Record<GateKey, Gate>;
  const gateMap = new Map<string, GateRow>();
  for (const row of gateRows) {
    gateMap.set(`${row.from_stage} -> ${row.to_stage}`, row);
  }
  for (const key of GATE_KEYS) {
    const row = gateMap.get(key);
    if (row) {
      gates[key] = rowToGate(row);
    } else {
      // Fallback: gate not in DB
      gates[key] = { type: DEFAULT_GATES[key], status: 'waiting' };
    }
  }

  const pipeline: Pipeline = {
    id: pipelineRow.id,
    goal: pipelineRow.goal,
    status: pipelineRow.status as Pipeline['status'],
    stages,
    gates,
    totalCost: pipelineRow.total_cost,
    createdAt: pipelineRow.created_at,
    updatedAt: pipelineRow.updated_at,
  };
  if (pipelineRow.completed_at) pipeline.completedAt = pipelineRow.completed_at;

  return pipeline;
}

// ── SqliteStateProvider ──────────────────────────────────────

export class SqliteStateProvider implements StateProvider {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async createPipeline(options: PipelineOptions): Promise<Pipeline> {
    const now = new Date().toISOString();
    const id = generatePipelineId();

    const pipeline: Pipeline = {
      id,
      goal: options.goal,
      status: 'pending',
      stages: this.buildStages(options.fromStage),
      gates: this.buildGates(options.gates),
      totalCost: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.db.transaction(() => {
      // Insert pipeline row
      this.db.run(
        `INSERT INTO pipelines (id, goal, status, total_cost, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, pipeline.goal, pipeline.status, 0, now, now],
      );

      // Insert stage rows
      for (const stage of pipeline.stages) {
        this.db.run(
          `INSERT INTO stages (pipeline_id, name, status, cost, duration, sessions, artifacts, started_at, completed_at, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            stage.name,
            stage.status,
            stage.cost,
            stage.duration,
            JSON.stringify(stage.sessions),
            JSON.stringify(stage.artifacts),
            stage.startedAt ?? null,
            stage.completedAt ?? null,
            stage.error ?? null,
          ],
        );
      }

      // Insert gate rows
      for (const key of GATE_KEYS) {
        const [from, to] = parseGateKey(key);
        const gate = pipeline.gates[key];
        this.db.run(
          `INSERT INTO gates (pipeline_id, from_stage, to_stage, type, status, approved_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, from, to, gate.type, gate.status, gate.approvedAt ?? null],
        );
      }
    })();

    return pipeline;
  }

  async loadPipeline(id: string): Promise<Pipeline | null> {
    const pipelineRow = this.db
      .query('SELECT * FROM pipelines WHERE id = ?')
      .get(id) as PipelineRow | null;

    if (!pipelineRow) return null;

    const stageRows = this.db
      .query('SELECT * FROM stages WHERE pipeline_id = ?')
      .all(id) as StageRow[];

    const gateRows = this.db
      .query('SELECT * FROM gates WHERE pipeline_id = ?')
      .all(id) as GateRow[];

    return rowsToPipeline(pipelineRow, stageRows, gateRows);
  }

  async savePipeline(pipeline: Pipeline): Promise<void> {
    this.db.transaction(() => {
      // Extract optional fields that may be added by future specs (worktree-pipelines)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ext = pipeline as any;
      const branch: string | null = ext.branch ?? null;
      const worktreePath: string | null = ext.worktreePath ?? null;

      // Upsert pipeline row
      this.db.run(
        `INSERT OR REPLACE INTO pipelines (id, goal, status, branch, worktree_path, total_cost, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          pipeline.id,
          pipeline.goal,
          pipeline.status,
          branch,
          worktreePath,
          pipeline.totalCost,
          pipeline.createdAt,
          pipeline.updatedAt,
          pipeline.completedAt ?? null,
        ],
      );

      // Upsert stage rows
      for (const stage of pipeline.stages) {
        this.db.run(
          `INSERT OR REPLACE INTO stages (pipeline_id, name, status, cost, duration, sessions, artifacts, started_at, completed_at, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            pipeline.id,
            stage.name,
            stage.status,
            stage.cost,
            stage.duration,
            JSON.stringify(stage.sessions),
            JSON.stringify(stage.artifacts),
            stage.startedAt ?? null,
            stage.completedAt ?? null,
            stage.error ?? null,
          ],
        );
      }

      // Upsert gate rows
      for (const key of GATE_KEYS) {
        const [from, to] = parseGateKey(key);
        const gate = pipeline.gates[key];
        this.db.run(
          `INSERT OR REPLACE INTO gates (pipeline_id, from_stage, to_stage, type, status, approved_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            pipeline.id,
            from,
            to,
            gate.type,
            gate.status,
            gate.approvedAt ?? null,
          ],
        );
      }
    })();
  }

  async loadActivePipeline(): Promise<Pipeline | null> {
    // Active = non-terminal status, most recently updated
    const pipelineRow = this.db
      .query(
        `SELECT * FROM pipelines
         WHERE status NOT IN ('completed', 'failed', 'cancelled')
         ORDER BY updated_at DESC
         LIMIT 1`,
      )
      .get() as PipelineRow | null;

    if (!pipelineRow) return null;

    return this.loadPipeline(pipelineRow.id);
  }

  async listPipelines(): Promise<Pipeline[]> {
    const pipelineRows = this.db
      .query('SELECT * FROM pipelines ORDER BY created_at DESC')
      .all() as PipelineRow[];

    const pipelines: Pipeline[] = [];
    for (const row of pipelineRows) {
      const pipeline = await this.loadPipeline(row.id);
      if (pipeline) pipelines.push(pipeline);
    }

    return pipelines;
  }

  // ── Private helpers ─────────────────────────────────────────

  private buildStages(fromStage?: StageName): Stage[] {
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

  private buildGates(
    overrides?: Partial<Record<GateKey, import('./pipeline-types.js').GateType>>,
  ): Record<GateKey, Gate> {
    const gates = {} as Record<GateKey, Gate>;
    for (const key of GATE_KEYS) {
      gates[key] = {
        type: overrides?.[key] ?? DEFAULT_GATES[key],
        status: 'waiting',
      };
    }
    return gates;
  }
}
