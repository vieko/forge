import { Command } from 'commander';

export const monitorCommand = new Command('monitor').description('Start TUI monitor');

monitorCommand.action(() => {
  console.log('TUI Monitor not yet implemented');
  console.log('Use "forge task stats" and "forge agent list" for now');
  // TODO: Implement TUI monitor with Ink
  // import { startMonitor } from '../../tui/index.js';
  // startMonitor();
});
