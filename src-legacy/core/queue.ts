import { promises as fs } from 'fs';
import { join } from 'path';
import { Task, TaskDefinition, TaskStatus } from '../types/index.js';
import { loadConfig } from './config.js';
import { createChildLogger } from '../utils/logger.js';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'eventemitter3';
import { homedir } from 'os';

export interface TaskQueueEvents {
  'task:created': (task: Task) => void;
  'task:queued': (task: Task) => void;
  'task:ready': (task: Task) => void;
  'task:assigned': (task: Task, agentId: string) => void;
  'task:started': (task: Task) => void;
  'task:progress': (task: Task, progress: number) => void;
  'task:completed': (task: Task) => void;
  'task:failed': (task: Task, error: Error) => void;
  'task:cancelled': (task: Task) => void;
  'task:retrying': (task: Task, attempt: number) => void;
}

/**
 * Pure file-based task queue using Claude Code task format
 * Tasks are stored as JSON files in ~/.claude/tasks/<taskListId>/
 */
export class TaskQueue extends EventEmitter<TaskQueueEvents> {
  private taskDir: string;
  private taskListId: string;
  private logger = createChildLogger({ component: 'task-queue' });

  constructor() {
    super();
    const config = loadConfig();
    this.taskListId = config.runtimes.local.taskListId;
    this.taskDir = join(homedir(), '.claude', 'tasks', this.taskListId);
  }

  async initialize(): Promise<void> {
    // Ensure task directory exists
    await fs.mkdir(this.taskDir, { recursive: true });
    this.logger.info({ taskDir: this.taskDir }, 'Task queue initialized');
  }

  async submit(definition: TaskDefinition): Promise<Task> {
    const taskId = definition.id || randomUUID();

    const task: Task = {
      ...definition,
      id: taskId,
      status: 'pending',
      createdAt: new Date(),
      attempts: 0,
      checkpoints: [],
    };

    this.logger.info({ taskId, type: task.type }, 'Submitting task');

    // Write task file in Claude Code format
    const claudeTask = this.toClaudeTask(task);
    await this.writeTaskFile(taskId, claudeTask);

    task.status = 'queued';
    this.emit('task:created', task);
    this.emit('task:queued', task);

    return task;
  }

  async getTask(taskId: string): Promise<Task | null> {
    try {
      const claudeTask = await this.readTaskFile(taskId);
      return this.fromClaudeTask(taskId, claudeTask);
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async getTasks(status?: TaskStatus): Promise<Task[]> {
    const files = await fs.readdir(this.taskDir);
    const taskFiles = files.filter(
      (f) => f.startsWith('forge-') && f.endsWith('.json')
    );

    const tasks: Task[] = [];
    for (const file of taskFiles) {
      const taskId = file.replace('forge-', '').replace('.json', '');
      try {
        const task = await this.getTask(taskId);
        if (task && (!status || task.status === status)) {
          tasks.push(task);
        }
      } catch (error) {
        this.logger.warn({ file, error }, 'Failed to read task file');
      }
    }

    // Sort by priority (1 = highest) and createdAt
    return tasks.sort((a, b) => {
      if (a.priority !== b.priority) {
        return (a.priority || 5) - (b.priority || 5);
      }
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
  }

  async cancelTask(taskId: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    task.status = 'cancelled';
    const claudeTask = this.toClaudeTask(task);
    claudeTask.status = 'deleted'; // Claude Code convention
    await this.writeTaskFile(taskId, claudeTask);

    this.emit('task:cancelled', task);
  }

  async completeTask(taskId: string, result?: any): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    task.status = 'completed';
    task.completedAt = new Date();
    task.result = result;

    const claudeTask = this.toClaudeTask(task);
    claudeTask.status = 'completed';
    await this.writeTaskFile(taskId, claudeTask);

    this.emit('task:completed', task);
  }

  async failTask(taskId: string, error: string): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    task.status = 'failed';
    task.lastError = error;
    task.attempts += 1;

    const claudeTask = this.toClaudeTask(task);
    claudeTask.status = 'deleted'; // Failed tasks marked as deleted
    await this.writeTaskFile(taskId, claudeTask);

    this.emit('task:failed', task, new Error(error));
  }

  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    agentId?: string
  ): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }

    task.status = status;
    if (agentId) {
      task.agentId = agentId;
    }
    if (status === 'running' && !task.startedAt) {
      task.startedAt = new Date();
    }

    const claudeTask = this.toClaudeTask(task);
    await this.writeTaskFile(taskId, claudeTask);

    if (status === 'assigned' && agentId) {
      this.emit('task:assigned', task, agentId);
    }
  }

  async getQueueStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    total: number;
  }> {
    const allTasks = await this.getTasks();

    const waiting = allTasks.filter(
      (t) => t.status === 'pending' || t.status === 'queued'
    ).length;
    const active = allTasks.filter(
      (t) => t.status === 'assigned' || t.status === 'running'
    ).length;
    const completed = allTasks.filter((t) => t.status === 'completed').length;
    const failed = allTasks.filter((t) => t.status === 'failed').length;

    return {
      waiting,
      active,
      completed,
      failed,
      total: allTasks.length,
    };
  }

  async cleanup(): Promise<void> {
    this.logger.info('Task queue cleanup complete');
  }

  /**
   * Convert Forge task to Claude Code task format
   */
  private toClaudeTask(task: Task): any {
    return {
      id: `forge-${task.id}`,
      subject: task.name,
      description: this.formatDescription(task),
      activeForm: this.toActiveForm(task.name),
      status: this.toClaudeStatus(task.status),
      owner: task.agentId || null,
      metadata: {
        forgeTaskId: task.id,
        forgeAgentId: task.agentId,
        forgeTaskType: task.type,
        priority: task.priority,
        requiredRole: task.requiredRole,
        requiredCapabilities: task.requiredCapabilities,
        dependencies: task.dependencies,
        createdAt: task.createdAt.toISOString(),
        startedAt: task.startedAt?.toISOString(),
        completedAt: task.completedAt?.toISOString(),
        attempts: task.attempts,
        lastError: task.lastError,
      },
    };
  }

  /**
   * Convert Claude Code task to Forge task format
   */
  private fromClaudeTask(taskId: string, claudeTask: any): Task {
    const metadata = claudeTask.metadata || {};
    return {
      id: taskId,
      type: metadata.forgeTaskType || 'unknown',
      name: claudeTask.subject || 'Unnamed task',
      description: claudeTask.description,
      payload: {}, // Encoded in description
      status: this.fromClaudeStatus(claudeTask.status),
      agentId: metadata.forgeAgentId || claudeTask.owner,
      priority: metadata.priority,
      requiredRole: metadata.requiredRole,
      requiredCapabilities: metadata.requiredCapabilities,
      dependencies: metadata.dependencies,
      createdAt: metadata.createdAt
        ? new Date(metadata.createdAt)
        : new Date(),
      startedAt: metadata.startedAt
        ? new Date(metadata.startedAt)
        : undefined,
      completedAt: metadata.completedAt
        ? new Date(metadata.completedAt)
        : undefined,
      attempts: metadata.attempts || 0,
      lastError: metadata.lastError,
      checkpoints: [],
    };
  }

  private toClaudeStatus(status: TaskStatus): string {
    switch (status) {
      case 'pending':
      case 'queued':
        return 'pending';
      case 'assigned':
      case 'running':
        return 'in_progress';
      case 'completed':
        return 'completed';
      case 'failed':
      case 'cancelled':
        return 'deleted';
      default:
        return 'pending';
    }
  }

  private fromClaudeStatus(status: string): TaskStatus {
    switch (status) {
      case 'pending':
        return 'queued';
      case 'in_progress':
        return 'running';
      case 'completed':
        return 'completed';
      case 'deleted':
        return 'failed';
      default:
        return 'pending';
    }
  }

  private toActiveForm(subject: string): string {
    // Simple heuristic: "Fix bug" → "Fixing bug"
    const words = subject.split(' ');
    if (words.length > 0) {
      const verb = words[0].toLowerCase();
      if (verb.endsWith('e')) {
        words[0] = verb.slice(0, -1) + 'ing';
      } else {
        words[0] = verb + 'ing';
      }
      words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
    }
    return words.join(' ');
  }

  private formatDescription(task: Task): string {
    let desc = `## Task Details\n\n`;
    desc += `**Type:** ${task.type}\n`;
    desc += `**Priority:** ${task.priority || 'default'}\n\n`;

    if (task.description) {
      desc += `## Description\n\n${task.description}\n\n`;
    }

    if (task.requiredRole) {
      desc += `**Required Role:** ${task.requiredRole}\n`;
    }

    if (task.requiredCapabilities && task.requiredCapabilities.length > 0) {
      desc += `**Required Capabilities:** ${task.requiredCapabilities.join(', ')}\n`;
    }

    if (Object.keys(task.payload).length > 0) {
      desc += `\n## Payload\n\n\`\`\`json\n${JSON.stringify(task.payload, null, 2)}\n\`\`\`\n`;
    }

    return desc;
  }

  private async writeTaskFile(taskId: string, claudeTask: any): Promise<void> {
    const filePath = join(this.taskDir, `forge-${taskId}.json`);
    await fs.writeFile(filePath, JSON.stringify(claudeTask, null, 2));
  }

  private async readTaskFile(taskId: string): Promise<any> {
    const filePath = join(this.taskDir, `forge-${taskId}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  }
}
