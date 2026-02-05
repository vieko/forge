import { AgentConfig, AgentInstance, HealthStatus, LogEntry } from '../types/index.js';

export interface IRuntimeAdapter {
  /**
   * Spawn a new agent instance
   */
  spawn(config: AgentConfig): Promise<AgentInstance>;

  /**
   * Terminate an agent instance
   */
  terminate(agentId: string, force?: boolean): Promise<void>;

  /**
   * Check agent health
   */
  healthCheck(agentId: string): Promise<HealthStatus>;

  /**
   * Get agent logs
   */
  getLogs(
    agentId: string,
    options?: { since?: Date; tail?: number; follow?: boolean }
  ): AsyncIterable<LogEntry>;

  /**
   * Execute a task on an agent
   */
  executeTask(agentId: string, taskPayload: Record<string, unknown>): Promise<void>;

  /**
   * Get agent resource usage
   */
  getResourceUsage(agentId: string): Promise<{
    cpu: number;
    memory: number;
    networkRx: number;
    networkTx: number;
  }>;

  /**
   * Pause/resume agent
   */
  pause(agentId: string): Promise<void>;
  resume(agentId: string): Promise<void>;

  /**
   * Clean up resources
   */
  cleanup(): Promise<void>;
}

export abstract class BaseRuntimeAdapter implements IRuntimeAdapter {
  protected agents: Map<string, AgentInstance> = new Map();

  abstract spawn(config: AgentConfig): Promise<AgentInstance>;
  abstract terminate(agentId: string, force?: boolean): Promise<void>;
  abstract healthCheck(agentId: string): Promise<HealthStatus>;
  abstract getLogs(
    agentId: string,
    options?: { since?: Date; tail?: number; follow?: boolean }
  ): AsyncIterable<LogEntry>;
  abstract executeTask(agentId: string, taskPayload: Record<string, unknown>): Promise<void>;
  abstract getResourceUsage(agentId: string): Promise<{
    cpu: number;
    memory: number;
    networkRx: number;
    networkTx: number;
  }>;
  abstract pause(agentId: string): Promise<void>;
  abstract resume(agentId: string): Promise<void>;

  async cleanup(): Promise<void> {
    const terminatePromises = Array.from(this.agents.keys()).map((id) =>
      this.terminate(id, true).catch((err) =>
        console.error(`Failed to terminate agent ${id}:`, err)
      )
    );
    await Promise.all(terminatePromises);
    this.agents.clear();
  }

  protected getAgent(agentId: string): AgentInstance {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    return agent;
  }
}
