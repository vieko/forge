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
  /** Model to use for plan-only runs (e.g. 'sonnet' for cheaper planning) */
  planModel?: string;
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
  /** Run specs sequentially instead of parallel (default: parallel) */
  sequential?: boolean;
  /** Max concurrent specs when parallel (default: auto) */
  concurrency?: number;
  /** Run first N specs sequentially before parallelizing the rest */
  sequentialFirst?: number;
  /** Rerun only failed specs from the latest batch */
  rerunFailed?: boolean;
  /** Run only pending specs from the manifest */
  pendingOnly?: boolean;
  /** Force re-run of passed specs (skip manifest filtering) */
  force?: boolean;
  /** Run in an isolated git worktree on the named branch */
  branch?: string;
  /** Directory for .forge/ persistence (session logs, results, manifest). Defaults to cwd. Used to route writes to the original repo when running in a worktree. */
  persistDir?: string;
  /** Callback fired when a spec completes in a batch run. Used by the executor for per-spec logging. */
  _onSpecResult?: (spec: string, status: 'success' | 'failed') => void;
  /** Skip CLI task tracking (used by executor which tracks its own tasks). */
  _skipTaskTracking?: boolean;
}

/**
 * Result from a Forge run, persisted to the SQLite runs table.
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
  type?: 'run' | 'audit' | 'review' | 'define' | 'proof' | 'verify';
  /** Agent turns used */
  numTurns?: number;
  /** Total tool invocations */
  toolCalls?: number;
  /** Count per tool type (e.g. { Bash: 12, Read: 8, Edit: 4 }) */
  toolBreakdown?: Record<string, number>;
  /** How many verification cycles ran (0 if passed first time) */
  verifyAttempts?: number;
  /** Transient error retries needed */
  retryAttempts?: number;
  /** Path to stream.log for this session */
  logPath?: string;
  /** Gap tracking data from audit-fix loop (only present for audit --fix results) */
  gapTracking?: GapTrackingEntry[];
}

// ── Audit-Fix Gap Tracking ───────────────────────────────────

/** Action taken on a gap in a specific round. */
export type GapRoundAction = 'found' | 'found_and_fixed';

/** Status of a fix attempt for a gap in a specific round. */
export type GapFixStatus = 'success' | 'error_verification' | 'error_execution' | null;

/** Per-round record for a tracked gap. */
export interface GapRoundRecord {
  round: number;
  action: GapRoundAction;
  fixStatus: GapFixStatus;
}

/** Overall resolution status of a gap across all rounds. */
export type GapResolution = 'resolved' | 'resolved_multi' | 'unresolved';

/** A single tracked gap across the audit-fix loop. */
export interface GapTrackingEntry {
  /** Base gap name (stripped of r{N}- prefix) */
  name: string;
  /** Overall resolution status */
  status: GapResolution;
  /** Per-round history */
  rounds: GapRoundRecord[];
  /** First sentence from the Outcome section of the remediation spec (for unresolved gaps) */
  description?: string;
  /** Path to the latest remediation spec file (for unresolved gaps) */
  latestSpecPath?: string;
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
  /** Directory for .forge/ persistence (session logs, results, manifest). Defaults to cwd. Used to route writes to the original repo when running in a worktree. */
  persistDir?: string;
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
  /** Run audit-fix convergence loop: audit, run remediation, re-audit until clean */
  fix?: boolean;
  /** Maximum number of audit-fix rounds (default: 3) */
  fixRounds?: number;
}

/**
 * Options for running define (spec generation from description).
 */
export interface DefineOptions {
  /** High-level description of what to build */
  prompt: string;
  /** Output directory for generated spec files (default: specs/) */
  outputDir?: string;
  /** Working directory (target repo) */
  cwd?: string;
  /** Directory for .forge/ persistence (session logs, results, manifest). Defaults to cwd. Used to route writes to the original repo when running in a worktree. */
  persistDir?: string;
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

/**
 * Options for generating a test protocol (proof) from implemented specs.
 */
export interface ProofOptions {
  /** Spec file(s) or directory to generate proof for */
  specPaths: string[];
  /** Output directory for generated proof files (default: .forge/proofs/) */
  outputDir?: string;
  /** Additional context prompt */
  prompt?: string;
  /** Working directory (target repo) */
  cwd?: string;
  /** Directory for .forge/ persistence (session logs, results, manifest). Defaults to cwd. Used to route writes to the original repo when running in a worktree. */
  persistDir?: string;
  /** Model to use (shorthand like 'opus'/'sonnet' or full ID) */
  model?: string;
  /** Maximum turns (default: 100) */
  maxTurns?: number;
  /** Maximum budget in USD (default: $5) */
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

/**
 * Options for running verification against proof files.
 */
export interface VerifyOptions {
  /** Path to a directory of proof files to verify */
  proofDir: string;
  /** Output directory for verification results (default: .forge/verify/) */
  outputDir?: string;
  /** Additional context prompt */
  prompt?: string;
  /** Working directory (target repo) */
  cwd?: string;
  /** Directory for .forge/ persistence (session logs, results, manifest). Defaults to cwd. Used to route writes to the original repo when running in a worktree. */
  persistDir?: string;
  /** Model to use (shorthand like 'opus'/'sonnet' or full ID) */
  model?: string;
  /** Maximum turns (default: 100) */
  maxTurns?: number;
  /** Maximum budget in USD (default: $5) */
  maxBudgetUsd?: number;
  /** Suppress progress output */
  quiet?: boolean;
  /** Preview tasks and estimate cost without executing */
  dryRun?: boolean;
}

/**
 * Result from verifying a single test file (from proof manifest).
 */
export interface VerifyResult {
  /** Relative path to the test file that was executed */
  testFile: string;
  /** Overall verification status */
  status: 'pass' | 'fail' | 'skipped';
  /** Exit code from the test runner (0 = pass) */
  exitCode: number;
  /** stderr output from the test runner (empty string on success) */
  stderr: string;
  /** Duration in seconds */
  durationSeconds?: number;
}

// ── Proof Manifest ───────────────────────────────────────────

/** A single entry in the proof manifest mapping a spec to its generated test file. */
export interface ProofManifestEntry {
  /** Relative path to the source spec file (e.g. "auth/login.md") */
  specFile: string;
  /** Category of the generated test: unit or integration */
  category: 'unit' | 'integration';
  /** Relative path to the generated test file (e.g. "unit/auth-login.test.ts") */
  testFile: string;
  /** Brief description of what the test covers */
  description: string;
}

/** Manifest written by `forge proof` mapping specs to generated test files. */
export interface ProofManifest {
  /** ISO 8601 timestamp when the proof was generated */
  generatedAt: string;
  /** Path to the spec directory that was processed */
  specDir: string;
  /** List of generated test file entries */
  entries: ProofManifestEntry[];
  /** Number of manual verification steps in manual.md */
  manualCheckCount: number;
}

// ── Spec Lifecycle Tracking ──────────────────────────────────

/** A single run record for a tracked spec. */
export interface SpecRun {
  runId: string;
  timestamp: string;         // ISO 8601
  resultPath?: string;       // deprecated: was filesystem results path, now unused (DB is sole store)
  status: 'passed' | 'failed';
  costUsd?: number;
  durationSeconds: number;
  /** Agent turns used */
  numTurns?: number;
  /** How many verification cycles ran */
  verifyAttempts?: number;
}

/** A tracked spec entry in the manifest. */
export interface SpecEntry {
  spec: string;              // relative path (e.g. "auth/login.md") or identifier for piped specs
  status: 'pending' | 'running' | 'passed' | 'failed';
  runs: SpecRun[];
  source: 'file' | 'pipe' | `github:${string}` | `audit:${string}` | `define:${string}`;
  createdAt: string;         // ISO 8601
  updatedAt: string;         // ISO 8601
}

/** The .forge/specs.json manifest. */
export interface SpecManifest {
  version: 1;
  specs: SpecEntry[];
}

// ── Monorepo Scoped Verification ─────────────────────────────

/** Monorepo tooling type. */
export type MonorepoType = 'pnpm' | 'turbo' | 'nx';

/** Monorepo context for scoped verification and build command rewriting. */
export interface MonorepoContext {
  /** Which monorepo tool was detected */
  type: MonorepoType;
  /** Mapping of workspace directory (relative to root) to package name */
  packages: Map<string, string>;
  /** Package names relevant to the current spec */
  affected: string[];
}

// ── Structured Session Event Log ─────────────────────────────

/** Base fields shared by all session events. */
interface SessionEventBase {
  /** ISO 8601 timestamp */
  timestamp: string;
}

/** Written at session start with metadata. */
export interface SessionStartEvent extends SessionEventBase {
  type: 'session_start';
  sessionId: string;
  model: string;
  commandType?: string;
  specPath?: string;
  prompt: string;
}

/** Captures accumulated extended thinking block content. */
export interface ThinkingDeltaEvent extends SessionEventBase {
  type: 'thinking_delta';
  content: string;
}

/** Captures accumulated text block content. */
export interface TextDeltaEvent extends SessionEventBase {
  type: 'text_delta';
  content: string;
}

/** Captures tool call with full input object. */
export interface ToolCallStartEvent extends SessionEventBase {
  type: 'tool_call_start';
  toolName: string;
  toolUseId?: string;
  input: Record<string, unknown>;
}

/** Captures tool call result output. */
export interface ToolCallResultEvent extends SessionEventBase {
  type: 'tool_call_result';
  toolName: string;
  toolUseId?: string;
  output: string;
}

/** Written at session end with summary metrics. */
export interface SessionEndEvent extends SessionEventBase {
  type: 'session_end';
  numTurns?: number;
  costUsd?: number;
  durationSeconds: number;
  status: 'success' | 'error_max_turns' | 'error_budget' | 'error_execution';
}

/** Discriminated union of all session event types. */
export type SessionEvent =
  | SessionStartEvent
  | ThinkingDeltaEvent
  | TextDeltaEvent
  | ToolCallStartEvent
  | ToolCallResultEvent
  | SessionEndEvent;

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

// ── Local Configuration ──────────────────────────────────────

// Re-export from config module for convenience
export type { ForgeLocalConfig } from './config.js';
