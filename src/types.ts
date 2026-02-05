/**
 * Agent definition for subagents.
 * Maps to @anthropic-ai/claude-agent-sdk's AgentDefinition.
 */
export interface AgentDefinition {
  /** Natural language description of when to use this agent */
  description: string;
  /** The agent's system prompt */
  prompt: string;
  /** Array of allowed tool names */
  tools: string[];
  /** Model to use for this agent */
  model: 'opus' | 'sonnet' | 'haiku' | 'inherit';
}

/**
 * Options for running Forge.
 */
export interface ForgeOptions {
  /** The task prompt */
  prompt: string;
  /** Path to a spec file to read */
  specPath?: string;
  /** Working directory (target repo) */
  cwd?: string;
  /** Model to use (opus or sonnet) */
  model?: 'opus' | 'sonnet';
  /** Only create tasks, don't implement */
  planOnly?: boolean;
  /** Show detailed output */
  verbose?: boolean;
  /** Resume a previous session */
  resume?: string;
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
  /** Error message (if failed) */
  error?: string;
}
