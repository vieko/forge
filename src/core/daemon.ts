import { Orchestrator } from './orchestrator.js';
import { createChildLogger } from '../utils/logger.js';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const logger = createChildLogger({ component: 'daemon' });

export class DaemonManager {
  private orchestrator: Orchestrator | null = null;
  private pidFile: string;
  private logFile: string;
  private running = false;

  constructor() {
    const runtimeDir = join(homedir(), '.forge');
    this.pidFile = join(runtimeDir, 'forge.pid');
    this.logFile = join(runtimeDir, 'forge.log');

    // Ensure runtime directory exists
    try {
      mkdirSync(runtimeDir, { recursive: true });
    } catch {
      // Directory already exists
    }
  }

  async start(): Promise<void> {
    // Check if already running
    if (this.isRunning()) {
      throw new Error('Daemon is already running');
    }

    logger.info('Starting daemon');

    // Create orchestrator
    this.orchestrator = new Orchestrator();

    // Set up signal handlers
    this.setupSignalHandlers();

    // Write PID file
    this.writePidFile();

    // Start orchestrator
    await this.orchestrator.start();
    this.running = true;

    logger.info({ pid: process.pid }, 'Daemon started successfully');

    // Keep process alive
    process.on('beforeExit', () => {
      if (this.running) {
        logger.info('Process attempting to exit, keeping alive');
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.orchestrator || !this.running) {
      throw new Error('Daemon is not running');
    }

    logger.info('Stopping daemon');

    this.running = false;
    await this.orchestrator.stop();
    this.removePidFile();

    logger.info('Daemon stopped successfully');
  }

  isRunning(): boolean {
    if (!existsSync(this.pidFile)) {
      return false;
    }

    try {
      const pid = parseInt(readFileSync(this.pidFile, 'utf-8'));

      // Check if process with this PID exists
      try {
        process.kill(pid, 0); // Signal 0 checks existence without killing
        return true;
      } catch {
        // Process doesn't exist, remove stale PID file
        this.removePidFile();
        return false;
      }
    } catch {
      return false;
    }
  }

  getPid(): number | null {
    if (!existsSync(this.pidFile)) {
      return null;
    }

    try {
      return parseInt(readFileSync(this.pidFile, 'utf-8'));
    } catch {
      return null;
    }
  }

  getStatus(): {
    running: boolean;
    pid: number | null;
    uptime?: number;
    agents?: number;
    tasks?: {
      waiting: number;
      active: number;
      completed: number;
      failed: number;
    };
  } {
    const running = this.isRunning();
    const pid = this.getPid();

    const status: ReturnType<DaemonManager['getStatus']> = {
      running,
      pid,
    };

    if (running && this.orchestrator) {
      const agents = this.orchestrator.getAllAgents();
      status.agents = agents.length;
    }

    return status;
  }

  private writePidFile(): void {
    writeFileSync(this.pidFile, process.pid.toString());
  }

  private removePidFile(): void {
    try {
      if (existsSync(this.pidFile)) {
        unlinkSync(this.pidFile);
      }
    } catch (error) {
      logger.error({ error }, 'Failed to remove PID file');
    }
  }

  private setupSignalHandlers(): void {
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal');

      try {
        await this.stop();
        process.exit(0);
      } catch (error) {
        logger.error({ error }, 'Error during shutdown');
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

    process.on('uncaughtException', (error) => {
      logger.error({ error }, 'Uncaught exception');
      void shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason) => {
      logger.error({ reason }, 'Unhandled rejection');
      void shutdown('unhandledRejection');
    });
  }

  getOrchestrator(): Orchestrator | null {
    return this.orchestrator;
  }
}

// Singleton instance for daemon mode
let daemonInstance: DaemonManager | null = null;

export function getDaemonManager(): DaemonManager {
  if (!daemonInstance) {
    daemonInstance = new DaemonManager();
  }
  return daemonInstance;
}

// Entry point for daemon process
export async function runDaemon(): Promise<void> {
  const daemon = getDaemonManager();

  try {
    await daemon.start();

    // Keep process alive
    await new Promise(() => {
      // Never resolves - keeps process running until signal
    });
  } catch (error) {
    logger.error({ error }, 'Failed to start daemon');
    process.exit(1);
  }
}
