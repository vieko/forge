import { EventEmitter } from 'eventemitter3';
import { AgentConfig, AgentInstance, AgentStatus, RuntimeType } from '../types/index.js';
import { IRuntimeAdapter } from '../runtime/adapter.js';
import { LocalProcessAdapter } from '../runtime/local.js';
import { createChildLogger } from '../utils/logger.js';
import { loadConfig } from './config.js';

export interface AgentManagerEvents {
  'agent:spawned': (agent: AgentInstance) => void;
  'agent:terminated': (agent: AgentInstance) => void;
  'agent:status-changed': (agent: AgentInstance, oldStatus: AgentStatus) => void;
  'agent:unhealthy': (agent: AgentInstance) => void;
  'agent:crashed': (agent: AgentInstance, error: Error) => void;
}

export class AgentManager extends EventEmitter<AgentManagerEvents> {
  private agents: Map<string, AgentInstance> = new Map();
  public adapters: Map<RuntimeType, IRuntimeAdapter> = new Map();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private logger = createChildLogger({ component: 'agent-manager' });
  private config = loadConfig();

  constructor() {
    super();
    this.initializeAdapters();
  }

  private initializeAdapters() {
    // Initialize Local adapter
    this.adapters.set('local', new LocalProcessAdapter());

    // TODO: Initialize Docker adapter
    // this.adapters.set('docker', new DockerAdapter());

    // TODO: Initialize Vercel adapter
    // this.adapters.set('vercel', new VercelSandboxAdapter());
  }

  async spawn(config: AgentConfig): Promise<AgentInstance> {
    // Check concurrent agent limit
    const activeAgents = Array.from(this.agents.values()).filter(
      (a) => a.status !== 'stopped' && a.status !== 'crashed'
    );

    if (activeAgents.length >= this.config.orchestrator.maxConcurrentAgents) {
      throw new Error(
        `Maximum concurrent agents (${this.config.orchestrator.maxConcurrentAgents}) reached`
      );
    }

    const runtime = config.runtime || this.config.orchestrator.defaultRuntime;
    const adapter = this.adapters.get(runtime);

    if (!adapter) {
      throw new Error(`Runtime adapter for ${runtime} not available`);
    }

    this.logger.info({ runtime }, 'Spawning agent');

    try {
      const agent = await adapter.spawn(config);
      this.agents.set(agent.id, agent);
      this.emit('agent:spawned', agent);

      this.logger.info({ agentId: agent.id }, 'Agent spawned successfully');
      return agent;
    } catch (error) {
      this.logger.error({ runtime, error }, 'Failed to spawn agent');
      throw error;
    }
  }

  async terminate(agentId: string, force = false): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const adapter = this.adapters.get(agent.runtime);
    if (!adapter) {
      throw new Error(`Runtime adapter for ${agent.runtime} not available`);
    }

    this.logger.info({ agentId, force }, 'Terminating agent');

    try {
      await adapter.terminate(agentId, force);
      agent.status = 'stopped';
      this.emit('agent:terminated', agent);

      this.logger.info({ agentId }, 'Agent terminated');
    } catch (error) {
      this.logger.error({ agentId, error }, 'Failed to terminate agent');
      throw error;
    }
  }

  async terminateAll(force = false): Promise<void> {
    const agentIds = Array.from(this.agents.keys());
    await Promise.all(
      agentIds.map((id) =>
        this.terminate(id, force).catch((err) =>
          this.logger.error({ agentId: id, error: err }, 'Failed to terminate agent')
        )
      )
    );
  }

  getAgent(agentId: string): AgentInstance | undefined {
    return this.agents.get(agentId);
  }

  getAllAgents(): AgentInstance[] {
    return Array.from(this.agents.values());
  }

  getAgentsByStatus(status: AgentStatus): AgentInstance[] {
    return this.getAllAgents().filter((a) => a.status === status);
  }

  getAvailableAgents(tags?: string[]): AgentInstance[] {
    return this.getAllAgents().filter((agent) => {
      if (agent.status !== 'idle') {
        return false;
      }

      if (tags && tags.length > 0) {
        const agentTags = agent.config.tags || [];
        return tags.every((tag) => agentTags.includes(tag));
      }

      return true;
    });
  }

  async assignTask(agentId: string, taskId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    if (agent.status !== 'idle') {
      throw new Error(`Agent ${agentId} is not idle (status: ${agent.status})`);
    }

    const oldStatus = agent.status;
    agent.status = 'busy';
    agent.currentTask = taskId;

    this.emit('agent:status-changed', agent, oldStatus);
    this.logger.info({ agentId, taskId }, 'Task assigned to agent');
  }

  async completeTask(agentId: string, success: boolean): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    if (success) {
      agent.stats.tasksCompleted++;
    } else {
      agent.stats.tasksFailed++;
    }

    const oldStatus = agent.status;
    agent.status = 'idle';
    agent.currentTask = undefined;

    this.emit('agent:status-changed', agent, oldStatus);
    this.logger.info({ agentId, success }, 'Task completed on agent');
  }

  async startHealthChecks(): Promise<void> {
    if (this.healthCheckInterval) {
      return; // Already running
    }

    const interval = this.config.orchestrator.healthCheckInterval;
    this.logger.info({ interval }, 'Starting health checks');

    this.healthCheckInterval = setInterval(() => this.performHealthChecks(), interval);

    // Perform initial health check
    await this.performHealthChecks();
  }

  stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
      this.logger.info('Health checks stopped');
    }
  }

  private async performHealthChecks(): Promise<void> {
    const agents = this.getAllAgents().filter(
      (a) => a.status !== 'stopped' && a.status !== 'crashed'
    );

    await Promise.all(agents.map((agent) => this.checkAgentHealth(agent)));
  }

  private async checkAgentHealth(agent: AgentInstance): Promise<void> {
    const adapter = this.adapters.get(agent.runtime);
    if (!adapter) {
      return;
    }

    try {
      const health = await adapter.healthCheck(agent.id);
      agent.lastHealthCheck = health.timestamp;

      if (!health.healthy) {
        const oldStatus = agent.status;
        agent.status = 'unhealthy';

        this.emit('agent:status-changed', agent, oldStatus);
        this.emit('agent:unhealthy', agent);

        this.logger.warn({ agentId: agent.id, health }, 'Agent unhealthy');
      }
    } catch (error) {
      this.logger.error({ agentId: agent.id, error }, 'Health check failed');

      const oldStatus = agent.status;
      agent.status = 'crashed';

      this.emit('agent:status-changed', agent, oldStatus);
      this.emit('agent:crashed', agent, error as Error);
    }
  }

  async cleanup(): Promise<void> {
    this.stopHealthChecks();
    await this.terminateAll(true);

    for (const adapter of this.adapters.values()) {
      await adapter.cleanup();
    }

    this.agents.clear();
    this.logger.info('Agent manager cleaned up');
  }
}
