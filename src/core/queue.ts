import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { Task, TaskDefinition, TaskStatus, TaskResult } from '../types/index.js';
import { loadConfig } from './config.js';
import { createChildLogger } from '../utils/logger.js';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'eventemitter3';

export interface TaskQueueEvents {
  'task:created': (task: Task) => void;
  'task:queued': (task: Task) => void;
  'task:assigned': (task: Task, agentId: string) => void;
  'task:started': (task: Task) => void;
  'task:progress': (task: Task, progress: number) => void;
  'task:completed': (task: Task) => void;
  'task:failed': (task: Task, error: Error) => void;
  'task:cancelled': (task: Task) => void;
  'task:retrying': (task: Task, attempt: number) => void;
}

export class TaskQueue extends EventEmitter<TaskQueueEvents> {
  private queue: Queue;
  private worker: Worker | null = null;
  private queueEvents: QueueEvents;
  private connection: Redis;
  private logger = createChildLogger({ component: 'task-queue' });

  constructor() {
    super();
    const config = loadConfig();

    this.connection = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
      maxRetriesPerRequest: null,
    });

    this.queue = new Queue('tasks', {
      connection: this.connection,
      prefix: config.redis.keyPrefix,
      defaultJobOptions: {
        attempts: config.errorHandling.maxRetries,
        backoff: {
          type: 'exponential',
          delay: config.errorHandling.retryBackoffMs,
        },
        removeOnComplete: {
          count: 100, // Keep last 100 completed
          age: 24 * 3600, // Keep for 24 hours
        },
        removeOnFail: {
          count: 100,
        },
      },
    });

    this.queueEvents = new QueueEvents('tasks', {
      connection: this.connection,
      prefix: config.redis.keyPrefix,
    });

    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.queueEvents.on('waiting', ({ jobId }) => {
      this.logger.debug({ jobId }, 'Task waiting in queue');
    });

    this.queueEvents.on('active', ({ jobId }) => {
      this.logger.info({ jobId }, 'Task started');
    });

    this.queueEvents.on('completed', ({ jobId, returnvalue }) => {
      this.logger.info({ jobId }, 'Task completed');
    });

    this.queueEvents.on('failed', ({ jobId, failedReason }) => {
      this.logger.error({ jobId, failedReason }, 'Task failed');
    });

    this.queueEvents.on('progress', ({ jobId, data }) => {
      this.logger.debug({ jobId, progress: data }, 'Task progress');
    });
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

    const job = await this.queue.add(task.type, task, {
      jobId: taskId,
      priority: task.priority,
      attempts: task.retryPolicy?.maxAttempts,
      backoff: task.retryPolicy
        ? {
            type: 'exponential',
            delay: task.retryPolicy.backoffMs,
          }
        : undefined,
    });

    task.status = 'queued';
    this.emit('task:created', task);
    this.emit('task:queued', task);

    return task;
  }

  async getTask(taskId: string): Promise<Task | null> {
    const job = await this.queue.getJob(taskId);
    if (!job) {
      return null;
    }

    return this.jobToTask(job);
  }

  async getTasks(status?: TaskStatus): Promise<Task[]> {
    let jobs: Job[] = [];

    if (!status) {
      const [waiting, active, completed, failed] = await Promise.all([
        this.queue.getWaiting(),
        this.queue.getActive(),
        this.queue.getCompleted(),
        this.queue.getFailed(),
      ]);
      jobs = [...waiting, ...active, ...completed, ...failed];
    } else {
      switch (status) {
        case 'pending':
        case 'queued':
          jobs = await this.queue.getWaiting();
          break;
        case 'running':
          jobs = await this.queue.getActive();
          break;
        case 'completed':
          jobs = await this.queue.getCompleted();
          break;
        case 'failed':
          jobs = await this.queue.getFailed();
          break;
      }
    }

    return Promise.all(jobs.map((job) => this.jobToTask(job)));
  }

  async cancelTask(taskId: string): Promise<void> {
    const job = await this.queue.getJob(taskId);
    if (!job) {
      throw new Error(`Task ${taskId} not found`);
    }

    await job.remove();

    const task = await this.jobToTask(job);
    task.status = 'cancelled';
    this.emit('task:cancelled', task);

    this.logger.info({ taskId }, 'Task cancelled');
  }

  async updateTaskProgress(taskId: string, progress: number): Promise<void> {
    const job = await this.queue.getJob(taskId);
    if (job) {
      await job.updateProgress(progress);
    }
  }

  async createCheckpoint(
    taskId: string,
    state: unknown,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const job = await this.queue.getJob(taskId);
    if (!job) {
      throw new Error(`Task ${taskId} not found`);
    }

    const task = await this.jobToTask(job);
    const checkpoint = {
      id: randomUUID(),
      taskId,
      timestamp: new Date(),
      state,
      metadata,
    };

    task.checkpoints.push(checkpoint);
    await job.updateData(task);

    this.logger.debug({ taskId, checkpointId: checkpoint.id }, 'Checkpoint created');
  }

  async getLatestCheckpoint(taskId: string): Promise<unknown | null> {
    const job = await this.queue.getJob(taskId);
    if (!job) {
      return null;
    }

    const task = await this.jobToTask(job);
    if (task.checkpoints.length === 0) {
      return null;
    }

    return task.checkpoints[task.checkpoints.length - 1].state;
  }

  async completeTask(taskId: string, result: TaskResult): Promise<void> {
    const job = await this.queue.getJob(taskId);
    if (!job) {
      throw new Error(`Task ${taskId} not found`);
    }

    await job.moveToCompleted(result, job.token || '', true);
    const task = await this.jobToTask(job);
    this.emit('task:completed', task);
    this.logger.info({ taskId }, 'Task completed');
  }

  async failTask(taskId: string, error: string): Promise<void> {
    const job = await this.queue.getJob(taskId);
    if (!job) {
      throw new Error(`Task ${taskId} not found`);
    }

    await job.moveToFailed(new Error(error), job.token || '', true);
    const task = await this.jobToTask(job);
    this.emit('task:failed', task, new Error(error));
    this.logger.error({ taskId, error }, 'Task failed');
  }

  async getQueueStats() {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
    ]);

    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      total: waiting + active + completed + failed + delayed,
    };
  }

  async cleanup(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
    await this.queue.close();
    await this.queueEvents.close();
    await this.connection.quit();
  }

  private async jobToTask(job: Job): Promise<Task> {
    const task = job.data as Task;

    // Update status based on job state
    const state = await job.getState();
    switch (state) {
      case 'waiting':
      case 'delayed':
        task.status = 'queued';
        break;
      case 'active':
        task.status = 'running';
        break;
      case 'completed':
        task.status = 'completed';
        task.completedAt = job.finishedOn ? new Date(job.finishedOn) : undefined;
        task.result = job.returnvalue as Task['result'];
        break;
      case 'failed':
        task.status = 'failed';
        task.lastError = job.failedReason;
        break;
    }

    task.attempts = job.attemptsMade;
    task.startedAt = job.processedOn ? new Date(job.processedOn) : undefined;

    return task;
  }
}
