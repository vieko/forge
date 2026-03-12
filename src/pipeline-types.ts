// ── Pipeline Orchestration Types ─────────────────────────────
//
// Shared vocabulary for the pipeline system. Pure type definitions
// with no runtime imports. Provider interfaces are abstract so
// filesystem, Postgres, and Redis implementations can all satisfy them.

// ── Stage Names ──────────────────────────────────────────────

/** The five pipeline stages, in execution order. */
export type StageName = 'define' | 'run' | 'audit' | 'proof' | 'verify';

/** All stage names in canonical execution order. */
export const STAGE_ORDER: readonly StageName[] = ['define', 'run', 'audit', 'proof', 'verify'] as const;

// ── Status Enums ─────────────────────────────────────────────

/** Pipeline-level status. */
export type PipelineStatus =
  | 'pending'
  | 'running'
  | 'paused_at_gate'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Stage-level status. */
export type StageStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

/** Gate type determines how the pipeline advances between stages. */
export type GateType = 'auto' | 'confirm' | 'review';

/** Gate resolution status. */
export type GateStatus = 'waiting' | 'approved' | 'skipped';

// ── Core Types ───────────────────────────────────────────────

/**
 * A gate controls the transition between two pipeline stages.
 * Gates can auto-advance, require user confirmation, or pause
 * for manual review of artifacts before proceeding.
 */
export interface Gate {
  /** How the gate is resolved */
  type: GateType;
  /** Current resolution status */
  status: GateStatus;
  /** ISO 8601 timestamp when the gate was approved or skipped */
  approvedAt?: string;
}

/**
 * A single stage in the pipeline execution.
 * Each stage maps to a forge command (define, run, audit, proof, verify).
 */
export interface Stage {
  /** Which pipeline stage this represents */
  name: StageName;
  /** Current execution status */
  status: StageStatus;
  /** Cost in USD accumulated during this stage */
  cost: number;
  /** Duration in seconds */
  duration: number;
  /** SDK session IDs created during this stage */
  sessions: string[];
  /** Key-value map for inter-stage artifact handoff (e.g. specDir, proofDir) */
  artifacts: Record<string, string>;
  /** ISO 8601 timestamp when the stage started */
  startedAt?: string;
  /** ISO 8601 timestamp when the stage completed */
  completedAt?: string;
  /** Error message if the stage failed */
  error?: string;
}

/**
 * A gate transition key identifies the boundary between two stages.
 * Format: "source -> target" (e.g. "define -> run").
 */
export type GateKey =
  | 'define -> run'
  | 'run -> audit'
  | 'audit -> proof'
  | 'proof -> verify';

/**
 * A full pipeline tracks the end-to-end execution of the forge workflow.
 */
export interface Pipeline {
  /** Unique pipeline identifier */
  id: string;
  /** The user's high-level goal for this pipeline */
  goal: string;
  /** Current pipeline status */
  status: PipelineStatus;
  /** Ordered stages (always 5, one per StageName) */
  stages: Stage[];
  /** Gate configuration for each stage transition */
  gates: Record<GateKey, Gate>;
  /** Total cost in USD across all stages */
  totalCost: number;
  /** ISO 8601 timestamp when the pipeline was created */
  createdAt: string;
  /** ISO 8601 timestamp of the last status change */
  updatedAt: string;
  /** ISO 8601 timestamp when the pipeline completed (success or failure) */
  completedAt?: string;
}

// ── Pipeline Events (discriminated union) ────────────────────

/** Base fields shared by all pipeline events. */
interface PipelineEventBase {
  /** Unique pipeline this event belongs to */
  pipelineId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/** Emitted when a stage begins execution. */
export interface StageStartEvent extends PipelineEventBase {
  type: 'stage_start';
  stage: StageName;
}

/** Emitted when a stage finishes successfully. */
export interface StageCompleteEvent extends PipelineEventBase {
  type: 'stage_complete';
  stage: StageName;
  cost: number;
  duration: number;
  artifacts: Record<string, string>;
}

/** Emitted when a stage fails. */
export interface StageFailedEvent extends PipelineEventBase {
  type: 'stage_failed';
  stage: StageName;
  error: string;
}

/** Emitted when the pipeline pauses at a gate between stages. */
export interface GatePauseEvent extends PipelineEventBase {
  type: 'gate_pause';
  gate: GateKey;
  gateType: GateType;
}

/** Emitted when a gate is approved or skipped, advancing the pipeline. */
export interface GateAdvanceEvent extends PipelineEventBase {
  type: 'gate_advance';
  gate: GateKey;
  resolution: 'approved' | 'skipped';
}

/** Emitted when the entire pipeline completes successfully. */
export interface PipelineCompleteEvent extends PipelineEventBase {
  type: 'pipeline_complete';
  totalCost: number;
  totalDuration: number;
}

/** Emitted when the pipeline fails (unrecoverable stage failure). */
export interface PipelineFailedEvent extends PipelineEventBase {
  type: 'pipeline_failed';
  stage: StageName;
  error: string;
}

/** Emitted when the pipeline is cancelled by the user. */
export interface PipelineCancelledEvent extends PipelineEventBase {
  type: 'pipeline_cancelled';
  stage?: StageName;
}

/** Discriminated union of all pipeline event types. */
export type PipelineEvent =
  | StageStartEvent
  | StageCompleteEvent
  | StageFailedEvent
  | GatePauseEvent
  | GateAdvanceEvent
  | PipelineCompleteEvent
  | PipelineFailedEvent
  | PipelineCancelledEvent;

// ── User-Facing Options ──────────────────────────────────────

/**
 * Configuration provided by the user when starting or resuming a pipeline.
 */
export interface PipelineOptions {
  /** High-level goal describing what to build */
  goal: string;
  /** Gate configuration per transition (defaults to 'auto' if omitted) */
  gates?: Partial<Record<GateKey, GateType>>;
  /** Start from a specific stage (skip earlier stages) */
  fromStage?: StageName;
  /** Directory for spec files (input/output) */
  specDir?: string;
  /** Working directory (target repo) */
  cwd?: string;
  /** Directory for .forge/ persistence (session logs, results, manifest). Defaults to cwd. Used to route writes to the original repo when running in a worktree. */
  persistDir?: string;
  /** Model to use */
  model?: string;
  /** Resume an existing pipeline by ID */
  resume?: string;
  /** Show detailed output */
  verbose?: boolean;
  /** Suppress progress output */
  quiet?: boolean;
}

// ── Gate Defaults ────────────────────────────────────────────

/** Default gate types for each stage transition. */
export const DEFAULT_GATES: Record<GateKey, GateType> = {
  'define -> run': 'auto',
  'run -> audit': 'auto',
  'audit -> proof': 'confirm',
  'proof -> verify': 'auto',
};

// ── Provider Interfaces ──────────────────────────────────────
//
// Abstract interfaces so filesystem, Postgres, and Redis
// implementations can all satisfy them. Implementations live
// in separate files (e.g. fs-state-provider.ts).

/**
 * Persistence layer for pipeline state.
 * Implementations: filesystem (.forge/pipelines/), Postgres, etc.
 */
export interface StateProvider {
  /** Create a new pipeline and persist it. Returns the created pipeline. */
  createPipeline(options: PipelineOptions): Promise<Pipeline>;
  /** Load a pipeline by ID. Returns null if not found. */
  loadPipeline(id: string): Promise<Pipeline | null>;
  /** Persist the current pipeline state (full replace). */
  savePipeline(pipeline: Pipeline): Promise<void>;
  /** Load the most recent active (non-terminal) pipeline. Returns null if none. */
  loadActivePipeline(): Promise<Pipeline | null>;
  /** List all pipelines, most recent first. */
  listPipelines(): Promise<Pipeline[]>;
}

/**
 * Pub/sub layer for pipeline events.
 * Implementations: in-process EventEmitter, Redis pub/sub, etc.
 */
export interface EventProvider {
  /** Publish a pipeline event. */
  publish(event: PipelineEvent): Promise<void>;
  /** Subscribe to pipeline events. Returns an unsubscribe function. */
  subscribe(handler: (event: PipelineEvent) => void | Promise<void>): () => void;
}

/** Artifacts produced by a stage execution. */
export interface StageResult {
  /** Cost in USD for this stage */
  cost: number;
  /** Key-value artifacts for inter-stage handoff */
  artifacts: Record<string, string>;
}

/**
 * Execution layer that runs each pipeline stage.
 * Wraps the existing forge commands (define, run, audit, proof, verify).
 */
export interface ExecutionProvider {
  /** Run `forge define` -- generate specs from the goal. */
  runDefine(pipeline: Pipeline, options: PipelineOptions): Promise<StageResult>;
  /** Run `forge run` -- execute specs. */
  runForge(pipeline: Pipeline, options: PipelineOptions): Promise<StageResult>;
  /** Run `forge audit` -- audit codebase against specs. */
  runAudit(pipeline: Pipeline, options: PipelineOptions): Promise<StageResult>;
  /** Run `forge proof` -- generate test protocols from specs. */
  runProof(pipeline: Pipeline, options: PipelineOptions): Promise<StageResult>;
  /** Run `forge verify` -- execute proofs and create PR. */
  runVerify(pipeline: Pipeline, options: PipelineOptions): Promise<StageResult>;
}
