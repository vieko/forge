import { EventEmitter } from 'eventemitter3';
import { Task } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface ClaudeCodeTask {
  id: string;
  subject: string;
  description: string;
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed' | 'deleted';
  owner?: string;
  metadata?: {
    forgeTaskId: string;
    forgeAgentId?: string;
    forgeTaskType: string;
    [key: string]: unknown;
  };
  blocks?: string[];
  blockedBy?: string[];
}

export interface TaskBridgeEvents {
  'task:completed': (forgeTaskId: string) => void;
  'task:failed': (forgeTaskId: string) => void;
  'task:updated': (forgeTaskId: string, status: string) => void;
}

export class TaskBridge extends EventEmitter<TaskBridgeEvents> {
  private taskDir: string;
  private metadataPath: string;
  private pollInterval: NodeJS.Timeout | null = null;
  private taskMap: Map<string, string> = new Map(); // claudeTaskId -> forgeTaskId
  private logger = createChildLogger({ component: 'task-bridge' });
  private lastSyncedStatus: Map<string, string> = new Map(); // forgeTaskId -> status

  constructor(private taskListId: string) {
    super();
    this.taskDir = join(homedir(), '.claude', 'tasks', taskListId);
    this.metadataPath = join(this.taskDir, 'metadata.json');
  }

  async initialize(): Promise<void> {
    this.logger.info({ taskDir: this.taskDir }, 'Initializing task bridge');

    // Ensure task directory exists
    await fs.mkdir(this.taskDir, { recursive: true });

    // Load existing metadata
    try {
      const metadataContent = await fs.readFile(this.metadataPath, 'utf-8');
      const metadata = JSON.parse(metadataContent);

      // Rebuild task map from existing tasks
      const files = await fs.readdir(this.taskDir);
      for (const file of files) {
        if (file.endsWith('.json') && file !== 'metadata.json') {
          try {
            const taskPath = join(this.taskDir, file);
            const taskContent = await fs.readFile(taskPath, 'utf-8');
            const claudeTask: ClaudeCodeTask = JSON.parse(taskContent);

            if (claudeTask.metadata?.forgeTaskId) {
              this.taskMap.set(claudeTask.id, claudeTask.metadata.forgeTaskId);
              this.lastSyncedStatus.set(claudeTask.metadata.forgeTaskId, claudeTask.status);
            }
          } catch (err) {
            this.logger.warn({ file, error: err }, 'Failed to load existing task');
          }
        }
      }

      this.logger.info({ taskCount: this.taskMap.size }, 'Loaded existing tasks');
    } catch (err) {
      // Metadata file doesn't exist yet, create it
      await this.writeMetadata({
        version: '1.0.0',
        taskListId: this.taskListId,
        createdAt: new Date().toISOString(),
      });
    }
  }

  async createClaudeTask(forgeTask: Task, agentId?: string): Promise<ClaudeCodeTask> {
    // Generate Claude task ID from forge task ID
    const claudeTaskId = `${this.taskListId}-${forgeTask.id}`;

    // Convert task name to activeForm (imperative -> present continuous)
    const activeForm = this.toActiveForm(forgeTask.name);

    const claudeTask: ClaudeCodeTask = {
      id: claudeTaskId,
      subject: forgeTask.name,
      description: this.buildDescription(forgeTask),
      activeForm,
      status: this.mapForgeStatusToClaudeStatus(forgeTask.status),
      owner: agentId,
      metadata: {
        forgeTaskId: forgeTask.id,
        forgeAgentId: agentId,
        forgeTaskType: forgeTask.type,
        priority: forgeTask.priority,
        createdAt: forgeTask.createdAt.toISOString(),
      },
    };

    // Write task to file
    const taskPath = join(this.taskDir, `${claudeTaskId}.json`);
    await fs.writeFile(taskPath, JSON.stringify(claudeTask, null, 2), 'utf-8');

    // Update task map
    this.taskMap.set(claudeTaskId, forgeTask.id);
    this.lastSyncedStatus.set(forgeTask.id, claudeTask.status);

    this.logger.info(
      { forgeTaskId: forgeTask.id, claudeTaskId, agentId },
      'Created Claude Code task'
    );

    return claudeTask;
  }

  async updateClaudeTask(
    forgeTaskId: string,
    updates: Partial<ClaudeCodeTask>
  ): Promise<void> {
    const claudeTaskId = Array.from(this.taskMap.entries()).find(
      ([_, fid]) => fid === forgeTaskId
    )?.[0];

    if (!claudeTaskId) {
      this.logger.warn({ forgeTaskId }, 'Claude task not found for update');
      return;
    }

    const taskPath = join(this.taskDir, `${claudeTaskId}.json`);

    try {
      const taskContent = await fs.readFile(taskPath, 'utf-8');
      const claudeTask: ClaudeCodeTask = JSON.parse(taskContent);

      // Apply updates
      Object.assign(claudeTask, updates);

      // Write back to file
      await fs.writeFile(taskPath, JSON.stringify(claudeTask, null, 2), 'utf-8');

      if (updates.status) {
        this.lastSyncedStatus.set(forgeTaskId, updates.status);
      }

      this.logger.debug({ forgeTaskId, claudeTaskId, updates }, 'Updated Claude task');
    } catch (err) {
      this.logger.error({ forgeTaskId, claudeTaskId, error: err }, 'Failed to update Claude task');
    }
  }

  async syncTaskStatus(forgeTaskId: string): Promise<ClaudeCodeTask | null> {
    const claudeTaskId = Array.from(this.taskMap.entries()).find(
      ([_, fid]) => fid === forgeTaskId
    )?.[0];

    if (!claudeTaskId) {
      return null;
    }

    const taskPath = join(this.taskDir, `${claudeTaskId}.json`);

    try {
      const taskContent = await fs.readFile(taskPath, 'utf-8');
      const claudeTask: ClaudeCodeTask = JSON.parse(taskContent);
      return claudeTask;
    } catch (err) {
      this.logger.error({ forgeTaskId, claudeTaskId, error: err }, 'Failed to sync task status');
      return null;
    }
  }

  async startSync(interval: number): Promise<void> {
    if (this.pollInterval) {
      this.logger.warn('Task sync already running');
      return;
    }

    this.logger.info({ interval }, 'Starting task sync');
    this.pollInterval = setInterval(() => void this.pollClaudeTasks(), interval);

    // Perform initial sync
    await this.pollClaudeTasks();
  }

  stopSync(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      this.logger.info('Task sync stopped');
    }
  }

  async cleanup(): Promise<void> {
    this.stopSync();
    this.taskMap.clear();
    this.lastSyncedStatus.clear();
  }

  private async pollClaudeTasks(): Promise<void> {
    try {
      // Read all task files
      const files = await fs.readdir(this.taskDir);

      for (const file of files) {
        if (!file.endsWith('.json') || file === 'metadata.json') {
          continue;
        }

        try {
          const taskPath = join(this.taskDir, file);
          const taskContent = await fs.readFile(taskPath, 'utf-8');
          const claudeTask: ClaudeCodeTask = JSON.parse(taskContent);

          if (!claudeTask.metadata?.forgeTaskId) {
            continue;
          }

          const forgeTaskId = claudeTask.metadata.forgeTaskId;
          const lastStatus = this.lastSyncedStatus.get(forgeTaskId);

          // Check if status changed
          if (lastStatus !== claudeTask.status) {
            this.logger.info(
              { forgeTaskId, oldStatus: lastStatus, newStatus: claudeTask.status },
              'Task status changed'
            );

            this.lastSyncedStatus.set(forgeTaskId, claudeTask.status);

            // Emit appropriate event
            switch (claudeTask.status) {
              case 'completed':
                this.emit('task:completed', forgeTaskId);
                break;
              case 'deleted':
                this.emit('task:failed', forgeTaskId);
                break;
              default:
                this.emit('task:updated', forgeTaskId, claudeTask.status);
            }
          }
        } catch (err) {
          this.logger.warn({ file, error: err }, 'Failed to parse task file');
        }
      }
    } catch (err) {
      this.logger.error({ error: err }, 'Error polling Claude tasks');
    }
  }

  private buildDescription(forgeTask: Task): string {
    const parts: string[] = [];

    if (forgeTask.description) {
      parts.push(forgeTask.description);
      parts.push('');
    }

    // Add task metadata
    parts.push('## Task Details');
    parts.push(`- **Type**: ${forgeTask.type}`);
    parts.push(`- **Priority**: ${forgeTask.priority || 3}`);
    if (forgeTask.timeout) {
      parts.push(`- **Timeout**: ${forgeTask.timeout}ms`);
    }
    parts.push('');

    // Add payload if present
    if (forgeTask.payload && Object.keys(forgeTask.payload).length > 0) {
      parts.push('## Payload');
      parts.push('```json');
      parts.push(JSON.stringify(forgeTask.payload, null, 2));
      parts.push('```');
      parts.push('');
    }

    // Add instructions
    parts.push('## Instructions');
    parts.push('1. Use TaskUpdate to mark this task as in_progress when you start');
    parts.push('2. Complete the task according to the specifications above');
    parts.push('3. Use TaskUpdate to mark as completed when done');

    return parts.join('\n');
  }

  private toActiveForm(subject: string): string {
    // Simple heuristic to convert imperative to present continuous
    // "Fix bug" -> "Fixing bug"
    // "Add feature" -> "Adding feature"
    // "Update config" -> "Updating config"

    const lower = subject.toLowerCase();

    if (lower.startsWith('fix ')) {
      return 'Fixing ' + subject.slice(4);
    } else if (lower.startsWith('add ')) {
      return 'Adding ' + subject.slice(4);
    } else if (lower.startsWith('update ')) {
      return 'Updating ' + subject.slice(7);
    } else if (lower.startsWith('create ')) {
      return 'Creating ' + subject.slice(7);
    } else if (lower.startsWith('delete ') || lower.startsWith('remove ')) {
      return 'Removing ' + subject.slice(7);
    } else if (lower.startsWith('implement ')) {
      return 'Implementing ' + subject.slice(10);
    } else if (lower.startsWith('refactor ')) {
      return 'Refactoring ' + subject.slice(9);
    } else if (lower.startsWith('test ')) {
      return 'Testing ' + subject.slice(5);
    } else if (lower.startsWith('debug ')) {
      return 'Debugging ' + subject.slice(6);
    } else {
      // Default: add "Working on" prefix
      return 'Working on ' + subject;
    }
  }

  private mapForgeStatusToClaudeStatus(
    forgeStatus: string
  ): 'pending' | 'in_progress' | 'completed' | 'deleted' {
    switch (forgeStatus) {
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

  private async writeMetadata(metadata: Record<string, unknown>): Promise<void> {
    await fs.writeFile(this.metadataPath, JSON.stringify(metadata, null, 2), 'utf-8');
  }
}
