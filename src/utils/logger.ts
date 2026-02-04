import pino from 'pino';
import { loadConfig } from '../core/config.js';

// Lazy load config to avoid validation errors for CLI help commands
let config: ReturnType<typeof loadConfig> | null = null;

function getConfig() {
  if (!config) {
    try {
      config = loadConfig();
    } catch (error) {
      // If config loading fails, use defaults
      return {
        monitoring: {
          logLevel: 'info' as const,
        },
      };
    }
  }
  return config;
}

const cfg = getConfig();

export const logger = pino.default({
  level: cfg.monitoring.logLevel,
  transport:
    process.env.NODE_ENV !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  base: {
    service: 'forge-orchestrator',
  },
});

export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}
