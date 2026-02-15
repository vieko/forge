/**
 * Options for running Forge.
 */
export interface ForgeOptions {
  /** The task prompt */
  prompt: string;
  /** Path to a spec file to read */
  specPath?: string;
  /** Path to a directory of spec files (runs each .md sequentially) */
  specDir?: string;
  /** Working directory (target repo) */
  cwd?: string;
  /** Model to use (shorthand like 'opus'/'sonnet' or full ID like 'claude-opus-4-6') */
  model?: string;
  /** Maximum turns per spec (default: 250) */
  maxTurns?: number;
  /** Maximum budget in USD (default: $50 run, $5 dry-run) */
  maxBudgetUsd?: number;
  /** Only create tasks, don't implement */
  planOnly?: boolean;
  /** Preview tasks and estimate cost without executing */
  dryRun?: boolean;
  /** Show detailed output */
  verbose?: boolean;
  /** Suppress progress output (for CI) */
  quiet?: boolean;
  /** Resume a previous session */
  resume?: string;
  /** Fork from a previous session (new session, same history) */
  fork?: string;
  /** Run specs in parallel (only with --spec-dir) */
  parallel?: boolean;
  /** Max concurrent specs when parallel (default: auto) */
  concurrency?: number;
  /** Run first N specs sequentially before parallelizing (with --parallel) */
  sequentialFirst?: number;
  /** Rerun only failed specs from the latest batch */
  rerunFailed?: boolean;
}

/**
 * Result from a Forge run, saved to .forge/results/
 */
export interface ForgeResult {
  /** ISO timestamp when the run started */
  startedAt: string;
  /** ISO timestamp when the run completed */
  completedAt: string;
  /** Duration in seconds */
  durationSeconds: number;
  /** Status of the run */
  status: 'success' | 'error_execution' | 'error_max_turns' | 'error_budget';
  /** Cost in USD (if available) */
  costUsd?: number;
  /** Spec file path (if provided) */
  specPath?: string;
  /** The prompt used */
  prompt: string;
  /** Model used */
  model: string;
  /** Working directory */
  cwd: string;
  /** SDK session ID (for resuming) */
  sessionId?: string;
  /** Session ID this was forked from */
  forkedFrom?: string;
  /** Error message (if failed) */
  error?: string;
  /** Batch run ID for grouping specs in the same run */
  runId?: string;
  /** Type of run */
  type?: 'run' | 'audit' | 'review';
}

/**
 * Options for running an audit.
 */
export interface AuditOptions {
  /** Path to a directory of spec files to audit against */
  specDir: string;
  /** Output directory for generated spec files (default: <specDir>/audit/) */
  outputDir?: string;
  /** Additional context prompt */
  prompt?: string;
  /** Working directory (target repo) */
  cwd?: string;
  /** Model to use (shorthand like 'opus'/'sonnet' or full ID) */
  model?: string;
  /** Maximum turns (default: 100) */
  maxTurns?: number;
  /** Maximum budget in USD (default: $10) */
  maxBudgetUsd?: number;
  /** Show detailed output */
  verbose?: boolean;
  /** Suppress progress output */
  quiet?: boolean;
  /** Resume a previous session */
  resume?: string;
  /** Fork from a previous session (new session, same history) */
  fork?: string;
}

// ── Spec Lifecycle Tracking ──────────────────────────────────

/** A single run record for a tracked spec. */
export interface SpecRun {
  runId: string;
  timestamp: string;         // ISO 8601
  resultPath: string;        // relative to workingDir, e.g. ".forge/results/2026-02-14T..."
  status: 'passed' | 'failed';
  costUsd?: number;
  durationSeconds: number;
}

/** A tracked spec entry in the manifest. */
export interface SpecEntry {
  spec: string;              // relative path (e.g. "auth/login.md") or identifier for piped specs
  status: 'pending' | 'running' | 'passed' | 'failed';
  runs: SpecRun[];
  source: 'file' | 'pipe' | `github:${string}` | `audit:${string}`;
  createdAt: string;         // ISO 8601
  updatedAt: string;         // ISO 8601
}

/** The .forge/specs.json manifest. */
export interface SpecManifest {
  version: 1;
  specs: SpecEntry[];
}

/**
 * Options for running a review.
 */
export interface ReviewOptions {
  /** Git diff range (default: main...HEAD) */
  diff?: string;
  /** Working directory (target repo) */
  cwd?: string;
  /** Model to use (shorthand like 'opus'/'sonnet' or full ID) */
  model?: string;
  /** Maximum turns (default: 50) */
  maxTurns?: number;
  /** Maximum budget in USD */
  maxBudgetUsd?: number;
  /** Show detailed output */
  verbose?: boolean;
  /** Suppress progress output */
  quiet?: boolean;
  /** Report findings without applying fixes */
  dryRun?: boolean;
  /** Write findings to file */
  output?: string;
}
