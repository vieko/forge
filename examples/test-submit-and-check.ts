#!/usr/bin/env tsx
/**
 * Submit task and immediately check queue
 */

import { TaskQueue } from '../src/core/queue.js';

async function main() {
  const queue = new TaskQueue();

  try {
    console.log('1. Submitting task...');
    const task = await queue.submit({
      type: 'test',
      name: 'Test Task',
      description: 'Test task for debugging',
      payload: { test: true },
      priority: 1,
    });
    console.log(`   ✅ Task submitted: ${task.id}`);
    console.log(`   Status: ${task.status}`);

    // Wait a moment for Bull MQ to process
    await new Promise(resolve => setTimeout(resolve, 500));

    console.log('\n2. Checking queue stats...');
    const stats = await queue.getQueueStats();
    console.log('   Stats:', JSON.stringify(stats, null, 2));

    console.log('\n3. Getting waiting tasks...');
    const waitingTasks = await queue.getTasks('queued');
    console.log(`   Found ${waitingTasks.length} waiting task(s)`);

    if (waitingTasks.length > 0) {
      console.log('\n4. Task details:');
      for (const t of waitingTasks) {
        console.log(`   - ID: ${t.id}`);
        console.log(`     Name: ${t.name}`);
        console.log(`     Status: ${t.status}`);
        console.log(`     Priority: ${t.priority}`);
      }
    }

    console.log('\n✅ Test complete');

    await queue.cleanup();
  } catch (error) {
    console.error('Error:', error);
    await queue.cleanup();
    process.exit(1);
  }
}

main().catch(console.error);
