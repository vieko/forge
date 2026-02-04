import { spawn, ChildProcess, exec } from 'child_process';
import { randomUUID } from 'crypto';
import { BaseRuntimeAdapter } from './adapter.js';
import { AgentConfig, AgentInstance, HealthStatus, LogEntry } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';
import { EventEmitter } from 'eventemitter3';
import { WorkspaceManager } from '../core/workspace-manager.js';

export class LocalProcessAdapter extends BaseRuntimeAdapter {
  private processes: Map<string, ChildProcess> = new Map();
  private logEmitters: Map<string, EventEmitter> = new Map();
  private workspaceManager: WorkspaceManager;
  private logger = createChildLogger({ adapter: 'local' });

  constructor() {
    super();
    this.workspaceManager = new WorkspaceManager();
  }

  async spawn(config: AgentConfig): Promise<AgentInstance> {
    const agentId = config.id || randomUUID();
    this.logger.info({ agentId, role: config.role }, 'Spawning local agent');

    // Create isolated workspace
    const workspace = await this.workspaceManager.createWorkspace(agentId);

    const claudeCodePath =
      (config.runtimeOptions?.claudeCodePath as string | undefined) ||
      process.env.CLAUDE_CODE_PATH ||
      'claude';

    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: config.claudeConfig.apiKey || process.env.ANTHROPIC_API_KEY,
      AI_GATEWAY_URL: config.claudeConfig.aiGatewayUrl,
      CLAUDE_MODEL: config.claudeConfig.model,
    };

    // Start Claude Code in isolated workspace
    const childProcess = spawn(claudeCodePath, ['--print', '--output-format=json'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workspace.agentWorkspace,
    });

    const logEmitter = new EventEmitter();
    this.logEmitters.set(agentId, logEmitter);

    // Capture stdout
    childProcess.stdout?.on('data', (data) => {
      const log: LogEntry = {
        timestamp: new Date(),
        level: 'info',
        agentId,
        message: data.toString(),
      };
      logEmitter.emit('log', log);
    });

    // Capture stderr
    childProcess.stderr?.on('data', (data) => {
      const log: LogEntry = {
        timestamp: new Date(),
        level: 'error',
        agentId,
        message: data.toString(),
      };
      logEmitter.emit('log', log);
    });

    // Handle process exit
    childProcess.on('exit', (code, signal) => {
      this.logger.info({ agentId, code, signal }, 'Agent process exited');
      const agent = this.agents.get(agentId);
      if (agent) {
        agent.status = code === 0 ? 'stopped' : 'crashed';
      }

      // Cleanup workspace on exit
      void this.workspaceManager.cleanup(agentId).catch((err) =>
        this.logger.error({ agentId, error: err }, 'Failed to cleanup workspace on exit')
      );
    });

    this.processes.set(agentId, childProcess);

    const agent: AgentInstance = {
      id: agentId,
      status: 'idle',
      config,
      runtime: 'local',
      role: config.role,
      workspace: workspace.agentWorkspace,
      pid: childProcess.pid,
      startedAt: new Date(),
      stats: {
        tasksCompleted: 0,
        tasksFailed: 0,
        totalExecutionTime: 0,
        apiCallsTotal: 0,
        tokensUsed: 0,
        costUsd: 0,
      },
    };

    this.agents.set(agentId, agent);
    return agent;
  }

  async terminate(agentId: string, force?: boolean): Promise<void> {
    this.logger.info({ agentId, force }, 'Terminating agent');

    const process = this.processes.get(agentId);
    if (!process) {
      throw new Error(`Agent ${agentId} process not found`);
    }

    const signal = force ? 'SIGKILL' : 'SIGTERM';
    process.kill(signal);

    this.processes.delete(agentId);
    this.logEmitters.delete(agentId);

    // Cleanup workspace
    await this.workspaceManager.cleanup(agentId);

    const agent = this.getAgent(agentId);
    agent.status = 'stopped';
  }

  async healthCheck(agentId: string): Promise<HealthStatus> {
    const agent = this.getAgent(agentId);
    const process = this.processes.get(agentId);

    const isProcessAlive = Boolean(process && !process.killed);
    const memoryUsage = process?.pid ? await this.getProcessMemory(process.pid) : 0;
    const memoryOk = memoryUsage < 4 * 1024 * 1024 * 1024; // 4GB

    const healthy = isProcessAlive && memoryOk;

    return {
      healthy,
      status: agent.status,
      checks: {
        process: Boolean(isProcessAlive),
        memory: memoryOk,
        apiConnectivity: true, // TODO: Implement actual check
        taskExecution: agent.status === 'idle' || agent.status === 'busy',
      },
      timestamp: new Date(),
    };
  }

  async *getLogs(
    agentId: string,
    options?: { since?: Date; tail?: number; follow?: boolean }
  ): AsyncIterable<LogEntry> {
    const emitter = this.logEmitters.get(agentId);
    if (!emitter) {
      throw new Error(`Agent ${agentId} log emitter not found`);
    }

    if (options?.follow) {
      // Stream logs in real-time
      const queue: LogEntry[] = [];
      let resolveNext: ((value: IteratorResult<LogEntry>) => void) | null = null;

      const listener = (log: LogEntry) => {
        if (options.since && log.timestamp < options.since) {
          return;
        }

        if (resolveNext) {
          resolveNext({ value: log, done: false });
          resolveNext = null;
        } else {
          queue.push(log);
        }
      };

      emitter.on('log', listener);

      try {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift()!;
          } else {
            await new Promise<void>((r) => {
              // Wait for next log
              const timeout = setTimeout(() => r(), 100);
            });
          }
        }
      } finally {
        emitter.off('log', listener);
      }
    } else {
      // Return buffered logs (not implemented in this simple version)
      return;
    }
  }

  async executeTask(agentId: string, taskPayload: Record<string, unknown>): Promise<void> {
    const process = this.processes.get(agentId);
    if (!process || !process.stdin) {
      throw new Error(`Agent ${agentId} process not available`);
    }

    const agent = this.getAgent(agentId);
    agent.status = 'busy';
    agent.currentTask = taskPayload.taskId as string | undefined;

    // Send notification via stdin
    const message = `Task ${taskPayload.taskId} assigned. Use TaskList and TaskGet to view details.`;
    const instruction = {
      type: 'task_notification',
      taskId: taskPayload.taskId,
      message,
    };

    process.stdin.write(JSON.stringify(instruction) + '\n');
  }

  async getResourceUsage(agentId: string): Promise<{
    cpu: number;
    memory: number;
    networkRx: number;
    networkTx: number;
  }> {
    const process = this.processes.get(agentId);
    if (!process?.pid) {
      return { cpu: 0, memory: 0, networkRx: 0, networkTx: 0 };
    }

    // TODO: Implement actual resource monitoring
    return {
      cpu: 0,
      memory: await this.getProcessMemory(process.pid),
      networkRx: 0,
      networkTx: 0,
    };
  }

  async pause(agentId: string): Promise<void> {
    const process = this.processes.get(agentId);
    if (process?.pid) {
      process.kill('SIGSTOP');
      const agent = this.getAgent(agentId);
      agent.status = 'paused';
    }
  }

  async resume(agentId: string): Promise<void> {
    const process = this.processes.get(agentId);
    if (process?.pid) {
      process.kill('SIGCONT');
      const agent = this.getAgent(agentId);
      agent.status = 'idle';
    }
  }

  private async getProcessMemory(pid: number): Promise<number> {
    // Simple memory check using ps command
    try {
      return new Promise((resolve) => {
        exec(`ps -o rss= -p ${pid}`, (err, stdout) => {
          if (err) {
            resolve(0);
          } else {
            // Convert from KB to bytes
            resolve(parseInt(stdout.trim()) * 1024);
          }
        });
      });
    } catch {
      return 0;
    }
  }
}
