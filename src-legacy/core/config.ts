import { z } from 'zod';
import { config as dotenvConfig } from 'dotenv';

// Schema definition
export const ConfigSchema = z.object({
  // Redis configuration
  redis: z.object({
    host: z.string().default('localhost'),
    port: z.number().default(6379),
    password: z.string().optional(),
    db: z.number().default(0),
    keyPrefix: z.string().default('forge:'),
  }),

  // Orchestrator configuration
  orchestrator: z.object({
    maxConcurrentAgents: z.number().default(5),
    taskTimeout: z.number().default(300000), // 5 minutes
    healthCheckInterval: z.number().default(30000), // 30 seconds
    defaultRuntime: z.enum(['docker', 'local', 'vercel', 'anthropic']).default('anthropic'),
  }),

  // Claude API configuration
  claude: z.object({
    apiKey: z.string().optional(),
    aiGatewayUrl: z.string().optional(),
    model: z.string().default('claude-sonnet-4-5-20250929'),
    maxTokens: z.number().default(100000),
  }),

  // Monitoring configuration
  monitoring: z.object({
    enabled: z.boolean().default(true),
    metricsPort: z.number().default(9090),
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    retentionDays: z.number().default(7),
  }),

  // Error handling configuration
  errorHandling: z.object({
    maxRetries: z.number().default(3),
    retryBackoffMs: z.number().default(1000),
    circuitBreakerThreshold: z.number().default(5),
    circuitBreakerTimeout: z.number().default(60000),
    enableCheckpointing: z.boolean().default(true),
    checkpointIntervalMs: z.number().default(30000),
  }),

  // Runtime-specific configs
  runtimes: z.object({
    docker: z.object({
      image: z.string().default('anthropics/claude-code:latest'),
      network: z.string().default('bridge'),
      memoryLimit: z.string().default('4g'),
      cpuLimit: z.number().default(2),
    }),
    local: z.object({
      claudeCodePath: z.string().optional(),
      nodeOptions: z.string().optional(),
      enableNativeTasks: z.boolean().default(true),
      taskSyncInterval: z.number().default(2000),
      taskListId: z.string().default('forge'),
    }),
    vercel: z.object({
      sandboxUrl: z.string().optional(),
      timeout: z.number().default(300000),
    }),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  dotenvConfig();

  const config = {
    redis: {
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT) : undefined,
      password: process.env.REDIS_PASSWORD,
      db: process.env.REDIS_DB ? parseInt(process.env.REDIS_DB) : undefined,
      keyPrefix: process.env.REDIS_KEY_PREFIX,
    },
    orchestrator: {
      maxConcurrentAgents: process.env.MAX_CONCURRENT_AGENTS
        ? parseInt(process.env.MAX_CONCURRENT_AGENTS)
        : undefined,
      taskTimeout: process.env.TASK_TIMEOUT ? parseInt(process.env.TASK_TIMEOUT) : undefined,
      healthCheckInterval: process.env.HEALTH_CHECK_INTERVAL
        ? parseInt(process.env.HEALTH_CHECK_INTERVAL)
        : undefined,
      defaultRuntime: process.env.DEFAULT_RUNTIME as 'docker' | 'local' | 'vercel' | undefined,
    },
    claude: {
      apiKey: process.env.ANTHROPIC_API_KEY,
      aiGatewayUrl: process.env.VERCEL_AI_GATEWAY_URL,
      model: process.env.CLAUDE_MODEL,
      maxTokens: process.env.CLAUDE_MAX_TOKENS
        ? parseInt(process.env.CLAUDE_MAX_TOKENS)
        : undefined,
    },
    monitoring: {
      enabled: process.env.MONITORING_ENABLED === 'true',
      metricsPort: process.env.METRICS_PORT ? parseInt(process.env.METRICS_PORT) : undefined,
      logLevel: process.env.LOG_LEVEL as
        | 'trace'
        | 'debug'
        | 'info'
        | 'warn'
        | 'error'
        | 'fatal'
        | undefined,
      retentionDays: process.env.LOG_RETENTION_DAYS
        ? parseInt(process.env.LOG_RETENTION_DAYS)
        : undefined,
    },
    errorHandling: {
      maxRetries: process.env.MAX_RETRIES ? parseInt(process.env.MAX_RETRIES) : undefined,
      retryBackoffMs: process.env.RETRY_DELAY_MS
        ? parseInt(process.env.RETRY_DELAY_MS)
        : undefined,
      circuitBreakerThreshold: process.env.CIRCUIT_BREAKER_THRESHOLD
        ? parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD)
        : undefined,
      circuitBreakerTimeout: process.env.CIRCUIT_BREAKER_TIMEOUT
        ? parseInt(process.env.CIRCUIT_BREAKER_TIMEOUT)
        : undefined,
      enableCheckpointing: process.env.CHECKPOINT_ENABLED === 'true',
      checkpointIntervalMs: process.env.CHECKPOINT_INTERVAL
        ? parseInt(process.env.CHECKPOINT_INTERVAL)
        : undefined,
    },
    runtimes: {
      docker: {
        image: process.env.DOCKER_IMAGE,
        network: process.env.DOCKER_NETWORK,
        memoryLimit: process.env.DOCKER_MEMORY_LIMIT,
        cpuLimit: process.env.DOCKER_CPU_LIMIT
          ? parseFloat(process.env.DOCKER_CPU_LIMIT)
          : undefined,
      },
      local: {
        claudeCodePath: process.env.CLAUDE_CODE_PATH,
        nodeOptions: process.env.NODE_OPTIONS,
        enableNativeTasks: process.env.ENABLE_NATIVE_TASKS === 'true',
        taskSyncInterval: process.env.TASK_SYNC_INTERVAL
          ? parseInt(process.env.TASK_SYNC_INTERVAL)
          : undefined,
        taskListId: process.env.CLAUDE_CODE_TASK_LIST_ID,
      },
      vercel: {
        sandboxUrl: process.env.VERCEL_SANDBOX_URL,
        timeout: process.env.VERCEL_TIMEOUT ? parseInt(process.env.VERCEL_TIMEOUT) : undefined,
      },
    },
  };

  return ConfigSchema.parse(config);
}

export function validateConfig(config: unknown): Config {
  return ConfigSchema.parse(config);
}
