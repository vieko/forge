#!/usr/bin/env node

/**
 * Daemon entry point
 * This script is spawned as a detached background process
 */

import { runDaemon } from './core/daemon.js';

// Run the daemon
runDaemon().catch((error) => {
  console.error('Fatal error in daemon:', error);
  process.exit(1);
});
