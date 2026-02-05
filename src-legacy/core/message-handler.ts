import { EventEmitter } from 'eventemitter3';
import { randomUUID } from 'crypto';
import {
  RequestMessage,
  EventMessage,
  ResponseMessage,
  ErrorCode,
  AgentInstance,
  Task,
  TaskDefinition,
} from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';

export interface MessageHandlerEvents {
  'message:request': (agentId: string, message: RequestMessage) => void;
  'message:event': (agentId: string, message: EventMessage) => void;
  'message:response-ready': (agentId: string, response: ResponseMessage) => void;
}

interface PendingRequest {
  requestId: string;
  agentId: string;
  timestamp: Date;
  timeoutId: NodeJS.Timeout;
}

export type RequestHandler = (
  agentId: string,
  payload: Record<string, unknown>
) => Promise<Record<string, unknown>>;

export type EventHandler = (agentId: string, payload: Record<string, unknown>) => Promise<void>;

export class MessageHandler extends EventEmitter<MessageHandlerEvents> {
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private requestHandlers: Map<string, RequestHandler> = new Map();
  private eventHandlers: Map<string, EventHandler> = new Map();
  private logger = createChildLogger({ component: 'message-handler' });
  private requestTimeout = 30000; // 30 seconds
  private messageRateLimits: Map<string, number[]> = new Map();
  private maxMessagesPerSecond = 100;

  constructor() {
    super();
    this.initializeDefaultHandlers();
  }

  private initializeDefaultHandlers() {
    // Default event handlers
    this.registerEventHandler('event:progress', async (agentId, payload) => {
      this.logger.info({ agentId, ...payload }, 'Agent progress update');
    });

    this.registerEventHandler('event:log', async (agentId, payload) => {
      const level = (payload.level as string) || 'info';
      this.logger[level as 'info' | 'warn' | 'error']?.(
        { agentId, ...payload },
        'Agent log entry'
      );
    });

    this.registerEventHandler('event:error', async (agentId, payload) => {
      this.logger.error({ agentId, ...payload }, 'Agent error reported');
    });

    this.registerEventHandler('event:question', async (agentId, payload) => {
      this.logger.warn({ agentId, ...payload }, 'Agent has a question (non-blocking)');
    });
  }

  registerRequestHandler(type: string, handler: RequestHandler): void {
    this.requestHandlers.set(type, handler);
    this.logger.debug({ type }, 'Registered request handler');
  }

  registerEventHandler(type: string, handler: EventHandler): void {
    this.eventHandlers.set(type, handler);
    this.logger.debug({ type }, 'Registered event handler');
  }

  async handleRequest(agentId: string, message: RequestMessage): Promise<ResponseMessage> {
    this.logger.debug({ agentId, type: message.type, id: message.id }, 'Handling request');

    // Check rate limit
    if (!this.checkRateLimit(agentId)) {
      return this.createErrorResponse(message.id, 'INTERNAL_ERROR', 'Rate limit exceeded');
    }

    // Emit event for monitoring
    this.emit('message:request', agentId, message);

    try {
      // Find handler
      const handler = this.requestHandlers.get(message.type);
      if (!handler) {
        return this.createErrorResponse(
          message.id,
          'INVALID_MESSAGE_TYPE',
          `No handler for message type: ${message.type}`
        );
      }

      // Execute handler
      const result = await handler(agentId, message.payload);

      // Create success response
      const response = this.createSuccessResponse(message.id, result);

      this.logger.debug(
        { agentId, requestId: message.id, responseId: response.id },
        'Request handled successfully'
      );

      return response;
    } catch (error) {
      this.logger.error({ agentId, requestId: message.id, error }, 'Error handling request');

      return this.createErrorResponse(
        message.id,
        'INTERNAL_ERROR',
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  }

  async handleEvent(agentId: string, message: EventMessage): Promise<void> {
    this.logger.debug({ agentId, type: message.type, id: message.id }, 'Handling event');

    // Check rate limit
    if (!this.checkRateLimit(agentId)) {
      this.logger.warn({ agentId }, 'Event dropped due to rate limit');
      return;
    }

    // Emit event for monitoring
    this.emit('message:event', agentId, message);

    try {
      // Find handler
      const handler = this.eventHandlers.get(message.type);
      if (!handler) {
        this.logger.warn({ agentId, type: message.type }, 'No handler for event type');
        return;
      }

      // Execute handler (fire-and-forget)
      await handler(agentId, message.payload);

      this.logger.debug({ agentId, eventId: message.id }, 'Event handled');
    } catch (error) {
      this.logger.error({ agentId, eventId: message.id, error }, 'Error handling event');
      // Don't throw - events are fire-and-forget
    }
  }

  private createSuccessResponse(
    correlationId: string,
    payload: Record<string, unknown>
  ): ResponseMessage {
    return {
      type: 'response:success',
      id: randomUUID(),
      correlationId,
      timestamp: new Date().toISOString(),
      payload,
    };
  }

  private createErrorResponse(
    correlationId: string,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>
  ): ResponseMessage {
    return {
      type: 'response:error',
      id: randomUUID(),
      correlationId,
      timestamp: new Date().toISOString(),
      error: {
        code,
        message,
        details,
      },
    };
  }

  private checkRateLimit(agentId: string): boolean {
    const now = Date.now();
    const windowMs = 1000; // 1 second window

    // Get or create message timestamps for this agent
    let timestamps = this.messageRateLimits.get(agentId) || [];

    // Filter out old timestamps (outside window)
    timestamps = timestamps.filter((ts) => now - ts < windowMs);

    // Check if limit exceeded
    if (timestamps.length >= this.maxMessagesPerSecond) {
      return false;
    }

    // Add current timestamp
    timestamps.push(now);
    this.messageRateLimits.set(agentId, timestamps);

    return true;
  }

  // Helper to track pending requests (for future timeout implementation)
  private trackPendingRequest(agentId: string, requestId: string): void {
    const timeoutId = setTimeout(() => {
      this.logger.warn({ agentId, requestId }, 'Request timed out');
      this.pendingRequests.delete(requestId);
    }, this.requestTimeout);

    this.pendingRequests.set(requestId, {
      requestId,
      agentId,
      timestamp: new Date(),
      timeoutId,
    });
  }

  private clearPendingRequest(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      this.pendingRequests.delete(requestId);
    }
  }

  cleanup(): void {
    // Clear all pending request timeouts
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeoutId);
    }
    this.pendingRequests.clear();
    this.messageRateLimits.clear();

    this.logger.info('Message handler cleaned up');
  }
}
