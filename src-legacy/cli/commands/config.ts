import { Command } from 'commander';
import { loadConfig } from '../../core/config.js';

export const configCommand = new Command('config').description('Manage configuration');

configCommand
  .command('show')
  .description('Show current configuration')
  .action(() => {
    try {
      const config = loadConfig();
      console.log(JSON.stringify(config, null, 2));
    } catch (error) {
      console.error('Error loading config:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

configCommand
  .command('validate')
  .description('Validate configuration')
  .action(() => {
    try {
      const config = loadConfig();
      console.log('✓ Configuration is valid');
      console.log('\nKey settings:');
      console.log('  Redis:', `${config.redis.host}:${config.redis.port}`);
      console.log('  Max Agents:', config.orchestrator.maxConcurrentAgents);
      console.log('  Default Runtime:', config.orchestrator.defaultRuntime);
      console.log('  Log Level:', config.monitoring.logLevel);
    } catch (error) {
      console.error('✗ Configuration is invalid');
      console.error('Error:', error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });
