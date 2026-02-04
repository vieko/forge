#!/usr/bin/env tsx
/**
 * Debug Queue - Check if getTasks returns waiting jobs
 */

import { TaskQueue } from '../src/core/queue.js';

async function main() {
  const queue = new TaskQueue();

  try {
    console.log('Checking queue stats...');
    const stats = await queue.getQueueStats();
    console.log('Stats:', stats);

    console.log('\nGetting waiting tasks...');
    const waitingTasks = await queue.getTasks('queued');
    console.log(`Found ${waitingTasks.length} waiting tasks`);

    if (waitingTasks.length > 0) {
      console.log('\nTasks:');
      for (const task of waitingTasks) {
        console.log(`  - ${task.id}: ${task.name} (${task.status})`);
      }
    }

    await queue.cleanup();
  } catch (error) {
    console.error('Error:', error);
    await queue.cleanup();
    process.exit(1);
  }
}

main().catch(console.error);
