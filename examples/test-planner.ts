#!/usr/bin/env bun
/**
 * Test Planner Agent
 *
 * This test verifies that a real Claude Code planner agent can:
 * 1. Read a specification file
 * 2. Decompose it into tasks
 * 3. Submit tasks via message protocol
 */

import { Orchestrator } from '../src/core/orchestrator.js';
import { createPlanningTask } from '../src/core/planner-task.js';

const SPEC_PATH = '.bonfire/specs/test-simple-feature.md';

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('🧪 Testing Planner Agent\n');

  const orchestrator = new Orchestrator();

  try {
    // Start orchestrator
    console.log('1️⃣  Starting orchestrator...');
    await orchestrator.start();
    console.log('   ✅ Started\n');

    // Spawn planner agent
    console.log('2️⃣  Spawning planner agent...');
    const planner = await orchestrator.spawnAgent({
      runtime: 'local',
      role: 'planner',
      claudeConfig: {},
      tags: ['planner', 'test'],
    });
    console.log(`   ✅ Planner spawned: ${planner.id}\n`);

    await sleep(2000);

    // Submit planning task with full instructions
    console.log('3️⃣  Submitting planning task...');
    const planningTaskDef = createPlanningTask(SPEC_PATH, 'test-simple-feature');
    const planningTask = await orchestrator.submitTask(planningTaskDef);
    console.log(`   ✅ Task submitted: ${planningTask.id}`);
    console.log(`   📋 Task will instruct planner to create sub-tasks\n`);

    // Monitor for task assignment
    console.log('4️⃣  Monitoring planner execution...\n');

    let assigned = false;
    let attempts = 0;
    const maxAttempts = 30; // 60 seconds

    while (!assigned && attempts < maxAttempts) {
      await sleep(2000);
      attempts++;

      const agents = orchestrator.getAllAgents();
      const plannerAgent = agents.find(a => a.id === planner.id);

      if (plannerAgent?.currentTask === planningTask.id) {
        assigned = true;
        console.log(`   ✅ [${attempts}] Planning task assigned to planner`);
        console.log(`   ⏱️  Planner is now reading spec and creating tasks...\n`);
      } else {
        console.log(`   ⏳ [${attempts}] Waiting for assignment...`);
      }
    }

    if (!assigned) {
      console.log('   ❌ Task was never assigned\n');
      await orchestrator.stop();
      process.exit(1);
    }

    // Monitor for sub-task creation (planner should submit tasks via JSON)
    console.log('5️⃣  Monitoring for sub-task creation...\n');

    let monitorAttempts = 0;
    const maxMonitorAttempts = 60; // 2 minutes
    let lastTaskCount = 0;

    while (monitorAttempts < maxMonitorAttempts) {
      await sleep(2000);
      monitorAttempts++;

      const stats = await orchestrator.getQueueStats();
      const allTasks = await orchestrator.taskQueue.getTasks();

      // Filter out the planning task to see sub-tasks
      const subTasks = allTasks.filter(t => t.type !== 'plan');

      if (subTasks.length > lastTaskCount) {
        console.log(`   ✅ [${monitorAttempts}] Sub-tasks created: ${subTasks.length}`);
        console.log(`   Tasks:`);
        for (const task of subTasks) {
          console.log(`     - ${task.name} (${task.status})`);
        }
        lastTaskCount = subTasks.length;
      } else {
        console.log(`   ⏳ [${monitorAttempts}] Waiting... (${stats.waiting} waiting, ${stats.active} active, ${subTasks.length} sub-tasks)`);
      }

      // Check if planning task is complete
      const planningTaskStatus = await orchestrator.taskQueue.getTask(planningTask.id);
      if (planningTaskStatus?.status === 'completed') {
        console.log('\n   ✅ Planning task completed!\n');
        break;
      }

      if (planningTaskStatus?.status === 'failed') {
        console.log('\n   ❌ Planning task failed!\n');
        break;
      }
    }

    // Final results
    console.log('6️⃣  Final Results:\n');

    const stats = await orchestrator.getQueueStats();
    const allTasks = await orchestrator.taskQueue.getTasks();
    const subTasks = allTasks.filter(t => t.type !== 'plan');

    console.log(`   📊 Queue Stats:`);
    console.log(`      Waiting: ${stats.waiting}`);
    console.log(`      Active: ${stats.active}`);
    console.log(`      Completed: ${stats.completed}`);
    console.log(`      Failed: ${stats.failed}`);
    console.log(`      Total: ${stats.total}`);

    console.log(`\n   📋 Sub-tasks Created: ${subTasks.length}`);
    if (subTasks.length > 0) {
      console.log(`   Tasks:`);
      for (const task of subTasks) {
        console.log(`     - ${task.name}`);
        console.log(`       Type: ${task.type}, Priority: ${task.priority}`);
        console.log(`       Status: ${task.status}`);
        if (task.dependencies && task.dependencies.length > 0) {
          console.log(`       Dependencies: ${task.dependencies.join(', ')}`);
        }
      }
    }

    // Check planning task final status
    const finalPlanningTask = await orchestrator.taskQueue.getTask(planningTask.id);
    console.log(`\n   📝 Planning Task Status: ${finalPlanningTask?.status}`);

    if (subTasks.length > 0) {
      console.log('\n✅ Planner agent successfully created sub-tasks!\n');
    } else {
      console.log('\n⚠️  Planner did not create any sub-tasks\n');
    }

    // Cleanup
    console.log('7️⃣  Cleaning up...');
    await orchestrator.stop();
    console.log('   ✅ Done\n');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    await orchestrator.stop();
    process.exit(1);
  }
}

main().catch(console.error);
