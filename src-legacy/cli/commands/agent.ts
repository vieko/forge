import { Command } from 'commander';
import { Orchestrator } from '../../core/orchestrator.js';
import { AgentConfig, AgentRole, RuntimeType } from '../../types/index.js';
import { loadConfig } from '../../core/config.js';

export const agentCommand = new Command('agent').description('Manage agents');

agentCommand
  .command('start')
  .description('Start a new agent')
  .option('-r, --runtime <runtime>', 'Runtime type (local, docker, vercel)', 'local')
  .option('--role <role>', 'Agent role (planner, worker, reviewer)', 'worker')
  .option('-t, --tags <tags>', 'Comma-separated tags')
  .action(async (options) => {
    const orchestrator = new Orchestrator();

    try {
      await orchestrator.start();

      const config = loadConfig();
      const agentConfig: AgentConfig = {
        runtime: options.runtime as RuntimeType,
        role: options.role as AgentRole,
        claudeConfig: {
          apiKey: config.claude.apiKey,
          aiGatewayUrl: config.claude.aiGatewayUrl,
          model: config.claude.model,
          maxTokens: config.claude.maxTokens,
        },
        tags: options.tags ? options.tags.split(',').map((t: string) => t.trim()) : undefined,
      };

      const agent = await orchestrator.spawnAgent(agentConfig);
      console.log('Agent started successfully');
      console.log('ID:', agent.id);
      console.log('Runtime:', agent.runtime);
      console.log('Status:', agent.status);
      if (agent.pid) {
        console.log('PID:', agent.pid);
      }
    } catch (error) {
      console.error('Error starting agent:', error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      await orchestrator.stop();
    }
  });

agentCommand
  .command('stop <agentId>')
  .description('Stop an agent')
  .option('-f, --force', 'Force stop')
  .action(async (agentId: string, options) => {
    const orchestrator = new Orchestrator();

    try {
      await orchestrator.start();
      await orchestrator.terminateAgent(agentId, options.force);
      console.log('Agent stopped:', agentId);
    } catch (error) {
      console.error('Error stopping agent:', error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      await orchestrator.stop();
    }
  });

agentCommand
  .command('list')
  .description('List all agents')
  .option('-s, --status <status>', 'Filter by status')
  .action(async (options) => {
    const orchestrator = new Orchestrator();

    try {
      await orchestrator.start();
      let agents = orchestrator.getAllAgents();

      if (options.status) {
        agents = agents.filter((a) => a.status === options.status);
      }

      if (agents.length === 0) {
        console.log('No agents found');
        return;
      }

      console.table(
        agents.map((a) => ({
          id: a.id.slice(0, 8),
          role: a.role,
          status: a.status,
          runtime: a.runtime,
          currentTask: a.currentTask?.slice(0, 8) || '-',
          completed: a.stats.tasksCompleted,
          failed: a.stats.tasksFailed,
          started: a.startedAt.toLocaleString(),
        }))
      );
    } catch (error) {
      console.error('Error listing agents:', error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      await orchestrator.stop();
    }
  });

agentCommand
  .command('get <agentId>')
  .description('Get agent details')
  .action(async (agentId: string) => {
    const orchestrator = new Orchestrator();

    try {
      await orchestrator.start();
      const agent = orchestrator.getAgent(agentId);

      if (!agent) {
        console.error('Agent not found');
        process.exit(1);
      }

      console.log('\nAgent Details:');
      console.log('─────────────────────');
      console.log('ID:', agent.id);
      console.log('Role:', agent.role);
      console.log('Status:', agent.status);
      console.log('Runtime:', agent.runtime);
      console.log('Workspace:', agent.workspace || '-');
      console.log('PID:', agent.pid || '-');
      console.log('Current Task:', agent.currentTask || '-');
      console.log('Started:', agent.startedAt.toLocaleString());
      console.log('\nStatistics:');
      console.log('  Tasks Completed:', agent.stats.tasksCompleted);
      console.log('  Tasks Failed:', agent.stats.tasksFailed);
      console.log('  Total Execution Time:', agent.stats.totalExecutionTime, 'ms');
      console.log('  API Calls:', agent.stats.apiCallsTotal);
      console.log('  Tokens Used:', agent.stats.tokensUsed);
      console.log('  Cost:', `$${agent.stats.costUsd.toFixed(4)}`);

      if (agent.config.tags && agent.config.tags.length > 0) {
        console.log('Tags:', agent.config.tags.join(', '));
      }
    } catch (error) {
      console.error('Error getting agent:', error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      await orchestrator.stop();
    }
  });
