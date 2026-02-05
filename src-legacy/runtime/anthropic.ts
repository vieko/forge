import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import { BaseRuntimeAdapter } from './adapter.js';
import {
  AgentConfig,
  AgentInstance,
  HealthStatus,
  LogEntry,
  RequestMessage,
  EventMessage,
  ResponseMessage,
} from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';
import { EventEmitter } from 'eventemitter3';
import { MessageHandler } from '../core/message-handler.js';

export class AnthropicAPIAdapter extends BaseRuntimeAdapter {
  private client: Anthropic;
  private conversations: Map<string, Anthropic.Messages.MessageParam[]> = new Map();
  private logEmitters: Map<string, EventEmitter> = new Map();
  private messageHandler: MessageHandler;
  private logger = createChildLogger({ adapter: 'anthropic' });
  private abortControllers: Map<string, AbortController> = new Map();

  constructor(messageHandler?: MessageHandler) {
    super();
    this.messageHandler = messageHandler || new MessageHandler();

    // Initialize Anthropic client with AI Gateway
    const apiKey = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_AI_GATEWAY_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('Missing API key: Set AI_GATEWAY_API_KEY, VERCEL_AI_GATEWAY_KEY, or ANTHROPIC_API_KEY in .env');
    }

    this.client = new Anthropic({
      apiKey,
      baseURL: 'https://ai-gateway.vercel.sh',
    });
  }

  async spawn(config: AgentConfig): Promise<AgentInstance> {
    const agentId = config.id || randomUUID();
    this.logger.info({ agentId, role: config.role }, 'Spawning Anthropic API agent');

    // Initialize conversation history
    this.conversations.set(agentId, []);

    // Create log emitter
    const logEmitter = new EventEmitter();
    this.logEmitters.set(agentId, logEmitter);

    // Create abort controller
    const abortController = new AbortController();
    this.abortControllers.set(agentId, abortController);

    // Build system prompt based on role
    let systemPrompt = 'You are an AI assistant helping with software development tasks.';
    if (config.role === 'planner') {
      systemPrompt = `You are a planner agent for the Forge orchestrator. Your job is to read specifications and decompose them into executable tasks.

When you create tasks, output them as JSON messages using the Bash tool with echo commands. Each task should be a separate echo command with a JSON object following this format:

{"type":"request:submit-task","id":"<uuid>","timestamp":"<iso-timestamp>","payload":{"type":"implementation","name":"Task name","description":"Task description","payload":{"files":["src/file.ts"]},"requiredRole":"worker","requiredCapabilities":["typescript"],"dependencies":[],"priority":1}}

Use the Read tool to read specification files and analyze them before creating tasks.`;
    } else if (config.role === 'worker') {
      systemPrompt = 'You are a worker agent for the Forge orchestrator. You execute implementation tasks, write code, run tests, and complete assigned work.';
    } else if (config.role === 'reviewer') {
      systemPrompt = 'You are a reviewer agent for the Forge orchestrator. You review code, check for issues, and verify quality standards.';
    }

    const agent: AgentInstance = {
      id: agentId,
      status: 'idle',
      config: {
        ...config,
        claudeConfig: {
          model: config.claudeConfig.model || 'claude-sonnet-4-5-20250929',
          ...config.claudeConfig,
        },
      },
      runtime: 'anthropic',
      role: config.role,
      workspace: config.runtimeOptions?.workspace as string | undefined,
      startedAt: new Date(),
      stats: {
        tasksCompleted: 0,
        tasksFailed: 0,
        totalExecutionTime: 0,
        apiCallsTotal: 0,
        tokensUsed: 0,
        costUsd: 0,
      },
      metadata: {
        systemPrompt,
      },
    };

    this.agents.set(agentId, agent);
    this.logger.info({ agentId }, 'Anthropic API agent spawned');
    return agent;
  }

  async terminate(agentId: string, force?: boolean): Promise<void> {
    this.logger.info({ agentId, force }, 'Terminating agent');

    // Abort any ongoing requests
    const abortController = this.abortControllers.get(agentId);
    if (abortController) {
      abortController.abort();
      this.abortControllers.delete(agentId);
    }

    // Cleanup
    this.conversations.delete(agentId);
    this.logEmitters.delete(agentId);

    const agent = this.getAgent(agentId);
    agent.status = 'stopped';
  }

  async healthCheck(agentId: string): Promise<HealthStatus> {
    const agent = this.getAgent(agentId);

    const healthy = agent.status === 'idle' || agent.status === 'busy';

    return {
      healthy,
      status: agent.status,
      checks: {
        process: true,
        memory: true,
        apiConnectivity: true,
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
              setTimeout(() => r(), 100);
            });
          }
        }
      } finally {
        emitter.off('log', listener);
      }
    }
  }

  async executeTask(agentId: string, taskPayload: Record<string, unknown>): Promise<void> {
    const agent = this.getAgent(agentId);
    agent.status = 'busy';
    agent.currentTask = taskPayload.taskId as string | undefined;

    const taskId = taskPayload.taskId as string;
    const taskDescription = taskPayload.description as string;

    this.logger.info({ agentId, taskId }, 'Executing task via Anthropic API');

    try {
      // Build the user message with task details
      const userMessage = `You have been assigned a task:

Task ID: ${taskId}
Description: ${taskDescription}

Please complete this task. If you need to create sub-tasks, output them as JSON echo commands as described in your system prompt.`;

      // Run the conversation
      await this.runConversation(agentId, userMessage);

      // Mark agent as idle after completion
      agent.status = 'idle';
      agent.currentTask = undefined;
      agent.stats.tasksCompleted++;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error({ agentId, taskId, error: errorMessage, stack: errorStack }, 'Error executing task');
      agent.status = 'idle';
      agent.currentTask = undefined;
      agent.stats.tasksFailed++;
      throw error;
    }
  }

  private async runConversation(agentId: string, userMessage: string): Promise<void> {
    const agent = this.getAgent(agentId);
    const conversation = this.conversations.get(agentId) || [];
    const abortController = this.abortControllers.get(agentId);
    const logEmitter = this.logEmitters.get(agentId);

    // Add user message to conversation
    conversation.push({
      role: 'user',
      content: userMessage,
    });

    const systemPrompt = agent.metadata?.systemPrompt as string || 'You are a helpful AI assistant.';

    // Define available tools
    const tools: Anthropic.Messages.Tool[] = [
      {
        name: 'Read',
        description: 'Read a file from the filesystem',
        input_schema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Absolute path to the file to read',
            },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'Bash',
        description: 'Execute a bash command',
        input_schema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The bash command to execute',
            },
            description: {
              type: 'string',
              description: 'Brief description of what this command does',
            },
          },
          required: ['command'],
        },
      },
    ];

    // Conversation loop
    let continueLoop = true;
    let turnCount = 0;
    const maxTurns = 10;

    while (continueLoop && turnCount < maxTurns) {
      turnCount++;

      try {
        // Call Anthropic API
        const response = await this.client.messages.create({
          model: agent.config.claudeConfig.model || 'claude-sonnet-4-5-20250929',
          max_tokens: 8192,
          system: systemPrompt,
          messages: conversation as Anthropic.Messages.MessageParam[],
          tools,
        }, {
          signal: abortController?.signal,
        });

        // Update stats
        agent.stats.apiCallsTotal++;
        agent.stats.tokensUsed += response.usage.input_tokens + response.usage.output_tokens;

        // Add assistant response to conversation
        conversation.push({
          role: 'assistant',
          content: response.content,
        });

        // Log assistant response
        this.logger.debug({ agentId, turnCount, stopReason: response.stop_reason }, 'Assistant response');

        // Check if we need to process tool uses
        const toolUses = response.content.filter((block): block is Anthropic.Messages.ToolUseBlock =>
          block.type === 'tool_use'
        );

        if (toolUses.length > 0) {
          // Process tool uses
          const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

          for (const toolUse of toolUses) {
            this.logger.debug({ agentId, toolName: toolUse.name, toolUseId: toolUse.id, toolInput: toolUse.input }, 'Processing tool use');

            try {
              const result = await this.executeTool(agentId, toolUse.name, toolUse.input);
              this.logger.debug({ agentId, toolName: toolUse.name, resultPreview: String(result).slice(0, 200) }, 'Tool result');

              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: typeof result === 'string' ? result : JSON.stringify(result),
              });

              // Log tool use
              if (logEmitter) {
                logEmitter.emit('log', {
                  timestamp: new Date(),
                  level: 'info',
                  agentId,
                  message: `Tool ${toolUse.name}: ${JSON.stringify(toolUse.input).slice(0, 100)}`,
                } as LogEntry);
              }
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: `Error: ${errorMessage}`,
                is_error: true,
              });

              this.logger.error({ agentId, toolName: toolUse.name, error }, 'Tool execution failed');
            }
          }

          // Add tool results to conversation
          conversation.push({
            role: 'user',
            content: toolResults,
          });

        } else {
          // No tool uses, conversation complete
          continueLoop = false;

          // Extract final text response
          const textBlocks = response.content.filter((block): block is Anthropic.Messages.TextBlock =>
            block.type === 'text'
          );
          const finalResponse = textBlocks.map(block => block.text).join('\n');

          this.logger.info({ agentId, response: finalResponse.slice(0, 200) }, 'Task completed');

          if (logEmitter) {
            logEmitter.emit('log', {
              timestamp: new Date(),
              level: 'info',
              agentId,
              message: `Completed: ${finalResponse}`,
            } as LogEntry);
          }
        }

      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          this.logger.info({ agentId }, 'Conversation aborted');
          break;
        }
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        this.logger.error({ agentId, error: errorMessage, stack: errorStack }, 'Error in conversation loop');
        throw error;
      }
    }

    if (turnCount >= maxTurns) {
      this.logger.warn({ agentId, turnCount }, 'Max turns reached');
    }

    // Update conversation history
    this.conversations.set(agentId, conversation);
  }

  private async executeTool(agentId: string, toolName: string, toolInput: unknown): Promise<unknown> {
    // Tool execution logic
    if (toolName === 'Read') {
      const { file_path } = toolInput as { file_path: string };
      const fs = await import('fs/promises');
      try {
        const content = await fs.readFile(file_path, 'utf-8');
        return content;
      } catch (error) {
        throw new Error(`Failed to read file: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (toolName === 'Bash') {
      const { command, description } = toolInput as { command: string; description?: string };
      const cp = await import('child_process');
      const util = await import('util');
      const execAsync = util.promisify(cp.exec);

      try {
        const { stdout, stderr } = await execAsync(command);

        // Check if this is a JSON echo command (task submission)
        if (command.startsWith('echo') && command.includes('"type":"request:submit-task"')) {
          // Extract the JSON from the echo command
          const jsonMatch = command.match(/echo\s+'(.+)'/) || command.match(/echo\s+"(.+)"/);
          if (jsonMatch) {
            try {
              const message = JSON.parse(jsonMatch[1]);
              if (message.type === 'request:submit-task') {
                // Route to message handler
                void this.handleAgentMessage(agentId, message);
              }
            } catch {
              // Not valid JSON, ignore
            }
          }
        }

        return stdout + (stderr ? `\nStderr: ${stderr}` : '');
      } catch (error) {
        throw new Error(`Command failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`Unknown tool: ${toolName}`);
  }

  private async handleAgentMessage(agentId: string, message: RequestMessage | EventMessage): Promise<void> {
    try {
      if (message.type.startsWith('request:')) {
        // Handle request - get response and send back
        const response = await this.messageHandler.handleRequest(agentId, message as RequestMessage);
        this.logger.debug({ agentId, response }, 'Request handled');
        // Note: We don't send the response back to the API since we're in a tool context
      } else if (message.type.startsWith('event:')) {
        // Handle event (fire-and-forget)
        await this.messageHandler.handleEvent(agentId, message as EventMessage);
      } else {
        this.logger.warn({ agentId, type: message.type }, 'Unknown message type');
      }
    } catch (error) {
      this.logger.error({ agentId, error }, 'Error handling agent message');
    }
  }

  getMessageHandler(): MessageHandler {
    return this.messageHandler;
  }

  async getResourceUsage(agentId: string): Promise<{
    cpu: number;
    memory: number;
    networkRx: number;
    networkTx: number;
  }> {
    // API-based agents don't have traditional resource usage
    return {
      cpu: 0,
      memory: 0,
      networkRx: 0,
      networkTx: 0,
    };
  }

  async pause(agentId: string): Promise<void> {
    const agent = this.getAgent(agentId);
    agent.status = 'paused';
    this.logger.info({ agentId }, 'Agent paused');
  }

  async resume(agentId: string): Promise<void> {
    const agent = this.getAgent(agentId);
    agent.status = 'idle';
    this.logger.info({ agentId }, 'Agent resumed');
  }
}
