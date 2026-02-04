import { Command } from 'commander';
import { Orchestrator } from '../../core/orchestrator.js';
import { TaskDefinition } from '../../types/index.js';
import { readFileSync } from 'fs';

export const taskCommand = new Command('task').description('Manage tasks');

taskCommand
  .command('submit')
  .description('Submit a new task')
  .option('-f, --file <path>', 'Task definition file (JSON)')
  .option('-t, --type <type>', 'Task type')
  .option('-n, --name <name>', 'Task name')
  .option('-p, --priority <priority>', 'Task priority (1-5)', '3')
  .option('--wait', 'Wait for task completion')
  .action(async (options) => {
    const orchestrator = new Orchestrator();

    try {
      await orchestrator.start();

      let taskDef: TaskDefinition;

      if (options.file) {
        const content = readFileSync(options.file, 'utf-8');
        taskDef = JSON.parse(content) as TaskDefinition;
      } else {
        if (!options.type || !options.name) {
          console.error('Error: --type and --name are required when not using --file');
          process.exit(1);
        }

        taskDef = {
          type: options.type,
          name: options.name,
          priority: parseInt(options.priority) as 1 | 2 | 3 | 4 | 5,
          payload: {},
        };
      }

      const task = await orchestrator.submitTask(taskDef);
      console.log('Task submitted:', task.id);
      console.log('Status:', task.status);

      if (options.wait) {
        console.log('Waiting for task completion...');
        // TODO: Implement wait logic with polling
      }
    } catch (error) {
      console.error('Error submitting task:', error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      await orchestrator.stop();
    }
  });

taskCommand
  .command('list')
  .description('List all tasks')
  .option('-s, --status <status>', 'Filter by status (queued, running, completed, failed)')
  .action(async (options) => {
    const orchestrator = new Orchestrator();

    try {
      await orchestrator.start();
      const tasks = await orchestrator['taskQueue'].getTasks(options.status);

      if (tasks.length === 0) {
        console.log('No tasks found');
        return;
      }

      console.table(
        tasks.map((t) => ({
          id: t.id.slice(0, 8),
          name: t.name,
          type: t.type,
          status: t.status,
          priority: t.priority || '-',
          created: t.createdAt.toLocaleString(),
        }))
      );
    } catch (error) {
      console.error('Error listing tasks:', error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      await orchestrator.stop();
    }
  });

taskCommand
  .command('get <taskId>')
  .description('Get task details')
  .action(async (taskId: string) => {
    const orchestrator = new Orchestrator();

    try {
      await orchestrator.start();
      const task = await orchestrator.getTask(taskId);

      if (!task) {
        console.error('Task not found');
        process.exit(1);
      }

      console.log(JSON.stringify(task, null, 2));
    } catch (error) {
      console.error('Error getting task:', error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      await orchestrator.stop();
    }
  });

taskCommand
  .command('cancel <taskId>')
  .description('Cancel a task')
  .action(async (taskId: string) => {
    const orchestrator = new Orchestrator();

    try {
      await orchestrator.start();
      await orchestrator.cancelTask(taskId);
      console.log('Task cancelled:', taskId);
    } catch (error) {
      console.error('Error cancelling task:', error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      await orchestrator.stop();
    }
  });

taskCommand
  .command('stats')
  .description('Show task queue statistics')
  .action(async () => {
    const orchestrator = new Orchestrator();

    try {
      await orchestrator.start();
      const stats = await orchestrator.getQueueStats();

      console.log('\nTask Queue Statistics:');
      console.log('─────────────────────');
      console.log(`Waiting:   ${stats.waiting}`);
      console.log(`Active:    ${stats.active}`);
      console.log(`Completed: ${stats.completed}`);
      console.log(`Failed:    ${stats.failed}`);
      console.log(`Delayed:   ${stats.delayed}`);
      console.log(`─────────────────────`);
      console.log(`Total:     ${stats.total}`);
    } catch (error) {
      console.error('Error getting stats:', error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      await orchestrator.stop();
    }
  });
