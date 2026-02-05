import { EventEmitter } from 'eventemitter3';
import { AgentManager } from './agent-manager.js';
import { TaskQueue } from './queue.js';
import {
  Task,
  TaskDefinition,
  TaskPriority,
  AgentConfig,
  AgentInstance,
  AgentRole,
} from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';
import { loadConfig } from './config.js';
import { MessageHandler } from './message-handler.js';

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
  private lastTaskStates: Map<string, string> = new Map();

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

  private setupMessageHandlers() {
    // Get message handler from local adapter
    const localAdapter = this.agentManager.adapters.get('local');
    if (!localAdapter || !('getMessageHandler' in localAdapter)) {
      this.logger.warn('Local adapter does not support message handling');
      return;
    }

    const messageHandler = (localAdapter as any).getMessageHandler() as MessageHandler;

    // Register request handlers
    messageHandler.registerRequestHandler('request:query-agents', async (agentId, payload) => {
      const agents = this.agentManager.getAvailableAgents(
        payload.role as AgentRole | undefined,
        payload.capabilities as string[] | undefined,
        payload.tags as string[] | undefined
      );

      return {
        agents: agents.map((a) => ({
          id: a.id,
          role: a.role,
          status: a.status,
          capabilities: a.config.capabilities,
          currentTask: a.currentTask,
        })),
      };
    });

    messageHandler.registerRequestHandler('request:query-tasks', async (agentId, payload) => {
      const status = payload.status as string | undefined;
      const tasks = status ? await this.taskQueue.getTasks(status as any) : [];

      const limit = (payload.limit as number) || 100;
      const filteredTasks = tasks.slice(0, limit);

      return {
        tasks: filteredTasks.map((t) => ({
          id: t.id,
          name: t.name,
          type: t.type,
          status: t.status,
          requiredRole: t.requiredRole,
          requiredCapabilities: t.requiredCapabilities,
          dependencies: t.dependencies,
          priority: t.priority,
        })),
      };
    });

    messageHandler.registerRequestHandler('request:submit-task', async (agentId, payload) => {
      const taskDef: TaskDefinition = {
        type: payload.type as string,
        name: payload.name as string,
        description: payload.description as string,
        payload: (payload.payload as Record<string, unknown>) || {},
        requiredRole: payload.requiredRole as AgentRole | undefined,
        requiredCapabilities: payload.requiredCapabilities as string[] | undefined,
        dependencies: payload.dependencies as string[] | undefined,
        priority: payload.priority as TaskPriority | undefined,
        tags: payload.tags as string[] | undefined,
      };

      const task = await this.taskQueue.submit(taskDef);

      return {
        task: {
          id: task.id,
          name: task.name,
          status: task.status,
          createdAt: task.createdAt.toISOString(),
        },
      };
    });

    messageHandler.registerRequestHandler('request:get-task', async (agentId, payload) => {
      const taskId = payload.taskId as string;
      const task = await this.taskQueue.getTask(taskId);

      if (!task) {
        throw new Error(`Task not found: ${taskId}`);
      }

      return {
        task: {
          id: task.id,
          name: task.name,
          type: task.type,
          status: task.status,
          result: task.result,
          agentId: task.agentId,
          createdAt: task.createdAt.toISOString(),
          startedAt: task.startedAt?.toISOString(),
          completedAt: task.completedAt?.toISOString(),
        },
      };
    });

    this.logger.info('Message handlers registered');
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Orchestrator is already running');
    }

    this.logger.info('Starting orchestrator');
    this.running = true;

    // Initialize task queue
    await this.taskQueue.initialize();
    this.logger.info('Task queue initialized');

    // Setup message handlers for agent communication
    this.setupMessageHandlers();

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

  private async hasUnsatisfiedDependencies(task: Task): Promise<boolean> {
    if (!task.dependencies || task.dependencies.length === 0) {
      return false;
    }

    // Check if all dependency tasks are completed
    for (const depId of task.dependencies) {
      const depTask = await this.taskQueue.getTask(depId);

      if (!depTask) {
        this.logger.warn(
          { taskId: task.id, dependencyId: depId },
          'Dependency task not found'
        );
        return true; // Block if dependency doesn't exist
      }

      if (depTask.status !== 'completed') {
        this.logger.debug(
          { taskId: task.id, dependencyId: depId, dependencyStatus: depTask.status },
          'Task blocked by uncompleted dependency'
        );
        return true; // Block if dependency not completed
      }
    }

    return false; // All dependencies satisfied
  }

  private async assignPendingTasks() {
    try {
      // Check for pending tasks to assign
      const pendingTasks = await this.taskQueue.getTasks('queued');
      this.logger.debug({ taskCount: pendingTasks.length }, 'Polling for pending tasks');

      for (const task of pendingTasks) {
        // Check if task has unsatisfied dependencies
        if (await this.hasUnsatisfiedDependencies(task)) {
          continue;
        }

        // Get agents filtered by role and capabilities
        const availableAgents = this.agentManager.getAvailableAgents(
          task.requiredRole,
          task.requiredCapabilities,
          task.tags
        );

        if (availableAgents.length === 0) {
          this.logger.debug(
            { taskId: task.id, requiredRole: task.requiredRole },
            'No available agents for task'
          );
          continue;
        }

        // Assign to first available agent
        const agent = availableAgents[0];

        try {
          await this.assignTaskToAgent(task, agent);
        } catch (error) {
          this.logger.error(
            { taskId: task.id, agentId: agent.id, error },
            'Failed to assign task to agent'
          );
        }
      }

      // Check for completed/failed tasks
      await this.checkTaskStatusChanges();
    } catch (error) {
      this.logger.error({ error }, 'Error in task polling');
    }
  }

  private async checkTaskStatusChanges() {
    try {
      // Check all active tasks for status changes
      const activeTasks = await this.taskQueue.getTasks('running');

      for (const task of activeTasks) {
        const lastStatus = this.lastTaskStates.get(task.id);
        const currentStatus = task.status;

        // Detect status change
        if (lastStatus && lastStatus !== currentStatus) {
          if (currentStatus === 'completed') {
            this.logger.info({ taskId: task.id }, 'Task completed by agent');
            await this.handleTaskCompletion(task, true);
          } else if (currentStatus === 'failed') {
            this.logger.warn({ taskId: task.id }, 'Task failed by agent');
            await this.handleTaskCompletion(task, false);
          }
        }

        this.lastTaskStates.set(task.id, currentStatus);
      }
    } catch (error) {
      this.logger.error({ error }, 'Error checking task status changes');
    }
  }

  private async assignTaskToAgent(task: Task, agent: AgentInstance) {
    this.logger.info({ taskId: task.id, agentId: agent.id }, 'Assigning task to agent');

    // Update task status to assigned
    await this.taskQueue.updateTaskStatus(task.id, 'assigned', agent.id);

    // Mark agent as busy
    await this.agentManager.assignTask(agent.id, task.id);

    // Notify agent via stdin
    const adapter = this.agentManager.adapters.get(agent.runtime);
    if (adapter) {
      await adapter.executeTask(agent.id, {
        taskId: task.id,
        type: task.type,
        name: task.name,
      });
    }

    // Track task state
    this.lastTaskStates.set(task.id, 'assigned');
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
