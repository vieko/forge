export type RuntimeType = 'docker' | 'local' | 'vercel' | 'anthropic';

export type AgentRole = 'planner' | 'worker' | 'reviewer';

export type AgentStatus =
  | 'initializing'
  | 'idle'
  | 'busy'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'crashed'
  | 'unhealthy';

export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'assigned'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'retrying';

export type TaskPriority = 1 | 2 | 3 | 4 | 5; // 1 = highest

export interface AgentConfig {
  id?: string;
  runtime: RuntimeType;
  role: AgentRole;
  capabilities?: string[];
  runtimeOptions?: Record<string, unknown>;
  claudeConfig: {
    apiKey?: string;
    aiGatewayUrl?: string;
    model?: string;
    maxTokens?: number;
  };
  resources?: {
    memory?: string;
    cpu?: number;
    timeout?: number;
  };
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface AgentInstance {
  id: string;
  status: AgentStatus;
  config: AgentConfig;
  runtime: RuntimeType;
  role: AgentRole;
  workspace?: string;
  pid?: number;
  containerId?: string;
  sandboxId?: string;
  startedAt: Date;
  lastHealthCheck?: Date;
  currentTask?: string;
  stats: AgentStats;
  metadata?: Record<string, unknown>;
}

export interface AgentStats {
  tasksCompleted: number;
  tasksFailed: number;
  totalExecutionTime: number;
  apiCallsTotal: number;
  tokensUsed: number;
  costUsd: number;
  lastError?: string;
  lastErrorAt?: Date;
}

export interface TaskDefinition {
  id?: string;
  type: string;
  name: string;
  description?: string;
  payload: Record<string, unknown>;
  priority?: TaskPriority;
  timeout?: number;
  retryPolicy?: RetryPolicy;
  dependencies?: string[]; // Task IDs that must complete first
  requiredRole?: AgentRole;
  requiredCapabilities?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface Task extends TaskDefinition {
  id: string;
  status: TaskStatus;
  agentId?: string;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  attempts: number;
  lastError?: string;
  checkpoints: Checkpoint[];
  result?: TaskResult;
}

export interface TaskResult {
  success: boolean;
  output?: unknown;
  error?: string;
  exitCode?: number;
  duration: number;
  stats: {
    apiCalls: number;
    tokensUsed: number;
    costUsd: number;
  };
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier: number;
  maxBackoffMs: number;
  retryableErrors?: string[];
}

export interface Checkpoint {
  id: string;
  taskId: string;
  timestamp: Date;
  state: unknown;
  metadata?: Record<string, unknown>;
}

export interface HealthStatus {
  healthy: boolean;
  status: AgentStatus;
  message?: string;
  checks: {
    process: boolean;
    memory: boolean;
    apiConnectivity: boolean;
    taskExecution: boolean;
  };
  timestamp: Date;
}

export interface LogEntry {
  timestamp: Date;
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  agentId?: string;
  taskId?: string;
  message: string;
  context?: Record<string, unknown>;
  error?: Error;
}

export interface Metrics {
  timestamp: Date;
  agents: {
    total: number;
    byStatus: Record<AgentStatus, number>;
  };
  tasks: {
    total: number;
    byStatus: Record<TaskStatus, number>;
    averageDuration: number;
    successRate: number;
  };
  resources: {
    cpuUsage: number;
    memoryUsage: number;
    queueDepth: number;
  };
  costs: {
    totalTokens: number;
    totalCostUsd: number;
    costByAgent: Record<string, number>;
  };
}

export interface WorkspaceConfig {
  agentId: string;
  baseDir: string;
  workspaceRoot: string;
  agentWorkspace: string;
  sharedGit: boolean;
}

// Agent↔Orchestrator Message Protocol Types

export type MessageType =
  // Agent → Orchestrator (Requests)
  | 'request:query-agents'
  | 'request:query-tasks'
  | 'request:submit-task'
  | 'request:get-task'
  | 'request:ask-user'
  // Agent → Orchestrator (Events)
  | 'event:progress'
  | 'event:log'
  | 'event:error'
  | 'event:question'
  // Orchestrator → Agent (Responses)
  | 'response:success'
  | 'response:error'
  // Orchestrator → Agent (Notifications)
  | 'notify:task-assigned'
  | 'notify:task-cancelled'
  | 'notify:shutdown';

export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_MESSAGE_TYPE'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR';

export interface BaseMessage {
  type: MessageType;
  id: string;
  timestamp: string;
  agentId?: string;
}

export interface RequestMessage extends BaseMessage {
  type:
    | 'request:query-agents'
    | 'request:query-tasks'
    | 'request:submit-task'
    | 'request:get-task'
    | 'request:ask-user';
  payload: Record<string, unknown>;
}

export interface EventMessage extends BaseMessage {
  type: 'event:progress' | 'event:log' | 'event:error' | 'event:question';
  payload: Record<string, unknown>;
}

export interface ResponseMessage extends BaseMessage {
  type: 'response:success' | 'response:error';
  correlationId: string;
  payload?: Record<string, unknown>;
  error?: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface NotificationMessage extends BaseMessage {
  type: 'notify:task-assigned' | 'notify:task-cancelled' | 'notify:shutdown';
  payload: Record<string, unknown>;
}

export type AgentMessage = RequestMessage | EventMessage;
export type OrchestratorMessage = ResponseMessage | NotificationMessage;
