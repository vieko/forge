#!/usr/bin/env node

import { Command } from 'commander';
import { taskCommand } from './commands/task.js';
import { agentCommand } from './commands/agent.js';
import { configCommand } from './commands/config.js';
import { monitorCommand } from './commands/monitor.js';
import { daemonCommand } from './commands/daemon.js';
import { logger } from '../utils/logger.js';

const program = new Command();

program
  .name('forge')
  .description('Claude Code Orchestrator - Coordinate multiple Claude agents')
  .version('0.1.0');

// Add subcommands
program.addCommand(daemonCommand);
program.addCommand(taskCommand);
program.addCommand(agentCommand);
program.addCommand(configCommand);
program.addCommand(monitorCommand);

// Quick status command
program
  .command('status')
  .description('Show orchestrator status')
  .action(async () => {
    const { Orchestrator } = await import('../core/orchestrator.js');
    const orchestrator = new Orchestrator();

    try {
      await orchestrator.start();

      const agents = orchestrator.getAllAgents();
      const queueStats = await orchestrator.getQueueStats();

      console.log('\nForge Orchestrator Status');
      console.log('═══════════════════════════');
      console.log('\nAgents:');
      console.log(`  Total: ${agents.length}`);
      console.log(`  Idle: ${agents.filter((a) => a.status === 'idle').length}`);
      console.log(`  Busy: ${agents.filter((a) => a.status === 'busy').length}`);
      console.log(`  Unhealthy: ${agents.filter((a) => a.status === 'unhealthy').length}`);

      console.log('\nTask Queue:');
      console.log(`  Waiting: ${queueStats.waiting}`);
      console.log(`  Active: ${queueStats.active}`);
      console.log(`  Completed: ${queueStats.completed}`);
      console.log(`  Failed: ${queueStats.failed}`);
      console.log('═══════════════════════════\n');
    } catch (error) {
      console.error('Error getting status:', error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      await orchestrator.stop();
    }
  });

// Global error handler
program.configureHelp({
  sortSubcommands: true,
  sortOptions: true,
});

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof Error) {
    logger.error({ error }, 'CLI error');
    console.error('\nError:', error.message);
  }
  process.exit(1);
}
