import { Command } from 'commander';
import { spawn } from 'child_process';
import { getDaemonManager } from '../../core/daemon.js';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const daemonCommand = new Command('daemon').description(
  'Manage orchestrator daemon'
);

daemonCommand
  .command('start')
  .description('Start orchestrator daemon in background')
  .option('-f, --foreground', 'Run in foreground (for debugging)')
  .action(async (options) => {
    const daemon = getDaemonManager();

    try {
      // Check if already running
      if (daemon.isRunning()) {
        console.error('Error: Daemon is already running');
        const pid = daemon.getPid();
        console.error(`PID: ${pid}`);
        console.error('Use "forge daemon stop" to stop it first');
        process.exit(1);
      }

      if (options.foreground) {
        // Run in foreground (for debugging)
        console.log('Starting daemon in foreground mode...');
        console.log('Press Ctrl+C to stop');
        console.log('');

        const { runDaemon } = await import('../../core/daemon.js');
        await runDaemon();
      } else {
        // Run in background
        console.log('Starting orchestrator daemon...');

        // Spawn detached process
        const daemonScript = join(__dirname, '../../daemon-entry.js');
        const child = spawn(process.execPath, [daemonScript], {
          detached: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            NODE_ENV: 'production',
          },
        });

        child.unref();

        // Wait a moment to check if it started
        await new Promise((resolve) => setTimeout(resolve, 1000));

        if (daemon.isRunning()) {
          const pid = daemon.getPid();
          console.log('✓ Daemon started successfully');
          console.log(`PID: ${pid}`);
          console.log('');
          console.log('Use "forge daemon status" to check status');
          console.log('Use "forge daemon stop" to stop the daemon');
        } else {
          console.error('✗ Failed to start daemon');
          console.error('Check logs at ~/.forge/forge.log');
          process.exit(1);
        }
      }
    } catch (error) {
      console.error('Error starting daemon:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

daemonCommand
  .command('stop')
  .description('Stop orchestrator daemon')
  .option('-f, --force', 'Force stop (SIGKILL)')
  .action(async (options) => {
    const daemon = getDaemonManager();

    try {
      if (!daemon.isRunning()) {
        console.error('Error: Daemon is not running');
        process.exit(1);
      }

      const pid = daemon.getPid();
      console.log('Stopping daemon...');
      console.log(`PID: ${pid}`);

      // Send signal to daemon process
      if (pid) {
        const signal = options.force ? 'SIGKILL' : 'SIGTERM';
        process.kill(pid, signal);

        // Wait for process to stop
        let attempts = 0;
        while (daemon.isRunning() && attempts < 30) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          attempts++;
        }

        if (daemon.isRunning()) {
          console.error('✗ Failed to stop daemon');
          console.error('Use --force to force stop');
          process.exit(1);
        } else {
          console.log('✓ Daemon stopped successfully');
        }
      }
    } catch (error) {
      console.error('Error stopping daemon:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

daemonCommand
  .command('restart')
  .description('Restart orchestrator daemon')
  .action(async () => {
    const daemon = getDaemonManager();

    try {
      // Stop if running
      if (daemon.isRunning()) {
        console.log('Stopping daemon...');
        const pid = daemon.getPid();
        if (pid) {
          process.kill(pid, 'SIGTERM');

          // Wait for process to stop
          let attempts = 0;
          while (daemon.isRunning() && attempts < 30) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            attempts++;
          }

          if (daemon.isRunning()) {
            console.error('✗ Failed to stop daemon');
            process.exit(1);
          }
        }
      }

      // Start daemon
      console.log('Starting daemon...');
      const daemonScript = join(__dirname, '../../daemon-entry.js');
      const child = spawn(process.execPath, [daemonScript], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          NODE_ENV: 'production',
        },
      });

      child.unref();

      // Wait and check
      await new Promise((resolve) => setTimeout(resolve, 1000));

      if (daemon.isRunning()) {
        const pid = daemon.getPid();
        console.log('✓ Daemon restarted successfully');
        console.log(`PID: ${pid}`);
      } else {
        console.error('✗ Failed to restart daemon');
        process.exit(1);
      }
    } catch (error) {
      console.error('Error restarting daemon:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

daemonCommand
  .command('status')
  .description('Show daemon status')
  .action(async () => {
    const daemon = getDaemonManager();

    try {
      const status = daemon.getStatus();

      console.log('\nDaemon Status');
      console.log('═══════════════════════════');

      if (status.running) {
        console.log('Status: Running ✓');
        console.log(`PID: ${status.pid}`);

        if (status.agents !== undefined) {
          console.log(`Agents: ${status.agents}`);
        }

        if (status.tasks) {
          console.log('\nTask Queue:');
          console.log(`  Waiting: ${status.tasks.waiting}`);
          console.log(`  Active: ${status.tasks.active}`);
          console.log(`  Completed: ${status.tasks.completed}`);
          console.log(`  Failed: ${status.tasks.failed}`);
        }
      } else {
        console.log('Status: Not running ✗');
      }

      console.log('═══════════════════════════\n');
    } catch (error) {
      console.error('Error getting status:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

daemonCommand
  .command('logs')
  .description('Show daemon logs')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <number>', 'Number of lines to show', '50')
  .action(async (options) => {
    const { execSync, spawn } = await import('child_process');
    const { homedir } = await import('os');
    const { join } = await import('path');

    const logFile = join(homedir(), '.forge', 'forge.log');

    try {
      if (options.follow) {
        // Follow logs
        const tail = spawn('tail', ['-f', '-n', options.lines, logFile], {
          stdio: 'inherit',
        });

        // Handle Ctrl+C
        process.on('SIGINT', () => {
          tail.kill();
          process.exit(0);
        });
      } else {
        // Show last N lines
        const output = execSync(`tail -n ${options.lines} ${logFile}`, {
          encoding: 'utf-8',
        });
        console.log(output);
      }
    } catch (error) {
      console.error('Error reading logs:', error instanceof Error ? error.message : error);
      console.error(`Log file: ${logFile}`);
      process.exit(1);
    }
  });
