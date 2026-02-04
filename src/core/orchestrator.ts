import { EventEmitter } from 'eventemitter3';
import { AgentManager } from './agent-manager.js';
import { TaskQueue } from './queue.js';
import { Task, TaskDefinition, AgentConfig, AgentInstance } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';
import { loadConfig } from './config.js';

export interface OrchestratorEvents {
  'orchestrator:started': () => void;
  'orchestrator:stopped': () => void;
  'orchestrator:error': (error: Error) => void;
}

export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  private agentManager: AgentManager;
  private taskQueue: TaskQueue;
  private running = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private logger = createChildLogger({ component: 'orchestrator' });
  private config = loadConfig();

  constructor() {
    super();
    this.agentManager = new AgentManager();
    this.taskQueue = new TaskQueue();
    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    // Forward agent events
    this.agentManager.on('agent:spawned', (agent) => {
      this.logger.info({ agentId: agent.id }, 'Agent spawned');
    });

    this.agentManager.on('agent:terminated', (agent) => {
      this.logger.info({ agentId: agent.id }, 'Agent terminated');
    });

    this.agentManager.on('agent:crashed', (agent, error) => {
      this.logger.error({ agentId: agent.id, error }, 'Agent crashed');
      void this.handleAgentCrash(agent, error);
    });

    this.agentManager.on('agent:unhealthy', (agent) => {
      this.logger.warn({ agentId: agent.id }, 'Agent unhealthy');
      void this.handleUnhealthyAgent(agent);
    });

    // Forward task events
    this.taskQueue.on('task:created', (task) => {
      this.logger.info({ taskId: task.id }, 'Task created');
    });

    this.taskQueue.on('task:completed', (task) => {
      this.logger.info({ taskId: task.id }, 'Task completed');
      void this.handleTaskCompletion(task, true);
    });

    this.taskQueue.on('task:failed', (task, error) => {
      this.logger.error({ taskId: task.id, error }, 'Task failed');
      void this.handleTaskCompletion(task, false);
    });
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Orchestrator is already running');
    }

    this.logger.info('Starting orchestrator');
    this.running = true;

    // Start health checks
    await this.agentManager.startHealthChecks();

    // Start task polling
    this.startTaskPolling();

    this.emit('orchestrator:started');
    this.logger.info('Orchestrator started');
  }

  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.logger.info('Stopping orchestrator');
    this.running = false;

    // Stop task polling
    this.stopTaskPolling();

    // Stop health checks
    this.agentManager.stopHealthChecks();

    // Clean up agents
    await this.agentManager.cleanup();

    // Clean up queue
    await this.taskQueue.cleanup();

    this.emit('orchestrator:stopped');
    this.logger.info('Orchestrator stopped');
  }

  async submitTask(definition: TaskDefinition): Promise<Task> {
    if (!this.running) {
      throw new Error('Orchestrator is not running');
    }

    return await this.taskQueue.submit(definition);
  }

  async getTask(taskId: string): Promise<Task | null> {
    return await this.taskQueue.getTask(taskId);
  }

  async cancelTask(taskId: string): Promise<void> {
    return await this.taskQueue.cancelTask(taskId);
  }

  async spawnAgent(config: AgentConfig): Promise<AgentInstance> {
    return await this.agentManager.spawn(config);
  }

  async terminateAgent(agentId: string, force = false): Promise<void> {
    return await this.agentManager.terminate(agentId, force);
  }

  getAgent(agentId: string): AgentInstance | undefined {
    return this.agentManager.getAgent(agentId);
  }

  getAllAgents(): AgentInstance[] {
    return this.agentManager.getAllAgents();
  }

  async getQueueStats() {
    return await this.taskQueue.getQueueStats();
  }

  private startTaskPolling() {
    // Poll for pending tasks and assign to available agents
    this.pollInterval = setInterval(
      () => void this.assignPendingTasks(),
      1000 // Poll every second
    );
  }

  private stopTaskPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async assignPendingTasks() {
    try {
      const pendingTasks = await this.taskQueue.getTasks('queued');
      if (pendingTasks.length === 0) {
        return;
      }

      const availableAgents = this.agentManager.getAvailableAgents();
      if (availableAgents.length === 0) {
        return;
      }

      // Assign tasks to agents
      const assignments = Math.min(pendingTasks.length, availableAgents.length);

      for (let i = 0; i < assignments; i++) {
        const task = pendingTasks[i];
        const agent = availableAgents[i];

        try {
          await this.assignTaskToAgent(task, agent);
        } catch (error) {
          this.logger.error(
            { taskId: task.id, agentId: agent.id, error },
            'Failed to assign task to agent'
          );
        }
      }
    } catch (error) {
      this.logger.error({ error }, 'Error in task polling');
    }
  }

  private async assignTaskToAgent(task: Task, agent: AgentInstance) {
    this.logger.info({ taskId: task.id, agentId: agent.id }, 'Assigning task to agent');

    await this.agentManager.assignTask(agent.id, task.id);

    // TODO: Execute task on agent via runtime adapter
    // For now, this is a placeholder
    // await runtimeAdapter.executeTask(agent.id, task.payload);
  }

  private async handleTaskCompletion(task: Task, success: boolean) {
    if (!task.agentId) {
      return;
    }

    try {
      await this.agentManager.completeTask(task.agentId, success);
    } catch (error) {
      this.logger.error(
        { taskId: task.id, agentId: task.agentId, error },
        'Error handling task completion'
      );
    }
  }

  private async handleAgentCrash(agent: AgentInstance, error: Error) {
    // If agent had a task, requeue it
    if (agent.currentTask) {
      this.logger.info(
        { agentId: agent.id, taskId: agent.currentTask },
        'Requeuing task from crashed agent'
      );

      // Task will be automatically retried by BullMQ
    }

    // Terminate crashed agent
    try {
      await this.agentManager.terminate(agent.id, true);
    } catch (err) {
      this.logger.error({ agentId: agent.id, error: err }, 'Error terminating crashed agent');
    }
  }

  private async handleUnhealthyAgent(agent: AgentInstance) {
    // Attempt recovery
    this.logger.info({ agentId: agent.id }, 'Attempting to recover unhealthy agent');

    // Simple recovery: terminate and let the system spawn a new agent if needed
    try {
      await this.agentManager.terminate(agent.id, true);
    } catch (error) {
      this.logger.error({ agentId: agent.id, error }, 'Error terminating unhealthy agent');
    }
  }
}
