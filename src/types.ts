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
  /** Model to use (opus or sonnet) */
  model?: 'opus' | 'sonnet';
  /** Only create tasks, don't implement */
  planOnly?: boolean;
  /** Show detailed output */
  verbose?: boolean;
}
