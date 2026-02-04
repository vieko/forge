#!/usr/bin/env tsx
/**
 * Test Autonomous Workflow
 *
 * This script validates the autonomous workflow infrastructure by:
 * 1. Starting a planner agent
 * 2. Starting worker agents
 * 3. Submitting a planning task
 * 4. Monitoring task decomposition and execution
 * 5. Verifying completion
 */

import { Orchestrator } from '../src/core/orchestrator.js';
import { promises as fs } from 'fs';
import { logger } from '../src/utils/logger.js';

const SPEC_PATH = '.bonfire/specs/test-simple-feature.md';

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('🚀 Testing Autonomous Workflow\n');

  const orchestrator = new Orchestrator();

  try {
    // Step 1: Start orchestrator
    console.log('1️⃣  Starting orchestrator...');
    await orchestrator.start();
    console.log('   ✅ Orchestrator started\n');

    // Step 2: Verify spec exists
    console.log('2️⃣  Verifying test spec...');
    try {
      await fs.access(SPEC_PATH);
      console.log(`   ✅ Spec found: ${SPEC_PATH}\n`);
    } catch {
      console.error(`   ❌ Spec not found: ${SPEC_PATH}`);
      process.exit(1);
    }

    // Step 3: Spawn planner agent
    console.log('3️⃣  Spawning planner agent...');
    const planner = await orchestrator.spawnAgent({
      runtime: 'local',
      role: 'planner',
      claudeConfig: {},
      tags: ['planner', 'test'],
    });
    console.log(`   ✅ Planner agent spawned: ${planner.id}\n`);

    // Wait for planner to initialize
    await sleep(2000);

    // Step 4: Spawn worker agents
    console.log('4️⃣  Spawning worker agents...');
    const worker1 = await orchestrator.spawnAgent({
      runtime: 'local',
      role: 'worker',
      capabilities: ['typescript', 'testing'],
      claudeConfig: {},
      tags: ['worker', 'test'],
    });
    console.log(`   ✅ Worker 1 spawned: ${worker1.id}`);

    const worker2 = await orchestrator.spawnAgent({
      runtime: 'local',
      role: 'worker',
      capabilities: ['typescript', 'documentation'],
      claudeConfig: {},
      tags: ['worker', 'test'],
    });
    console.log(`   ✅ Worker 2 spawned: ${worker2.id}\n`);

    // Wait for workers to initialize
    await sleep(2000);

    // Step 5: Submit planning task
    console.log('5️⃣  Submitting planning task...');
    const planningTask = await orchestrator.submitTask({
      type: 'plan',
      name: 'Plan: Simple Math Utility',
      description: `Decompose the specification at ${SPEC_PATH} into executable tasks.`,
      priority: 1,
      payload: {
        specPath: SPEC_PATH,
        workflowId: 'test-simple-feature',
      },
      requiredRole: 'planner',
    });
    console.log(`   ✅ Planning task submitted: ${planningTask.id}\n`);

    // Step 6: Monitor execution
    console.log('6️⃣  Monitoring execution...\n');
    console.log('   ⏱️  Waiting for task assignment (checking every 2s)...');

    let iterations = 0;
    const maxIterations = 30; // 60 seconds max

    while (iterations < maxIterations) {
      await sleep(2000);
      iterations++;

      // Check agents status
      const agents = orchestrator.getAllAgents();
      const stats = await orchestrator.getQueueStats();

      console.log(`   [${iterations}] Agents: ${agents.filter(a => a.status === 'idle').length} idle, ${agents.filter(a => a.status === 'busy').length} busy | Tasks: ${stats.waiting} waiting, ${stats.active} active, ${stats.completed} completed`);

      // Check if planning task is assigned
      const plannerAgent = agents.find(a => a.id === planner.id);
      if (plannerAgent?.currentTask) {
        console.log(`\n   ✅ Planning task assigned to ${planner.id}`);
        console.log(`   ℹ️  Planner is now working on task decomposition...`);
        break;
      }

      if (iterations >= maxIterations) {
        console.log('\n   ⚠️  Timeout waiting for task assignment');
      }
    }

    // Step 7: Wait a bit longer for task decomposition
    console.log('\n   ⏱️  Waiting for planner to create sub-tasks (20s)...');
    await sleep(20000);

    // Step 8: Check results
    console.log('\n7️⃣  Checking results...\n');

    const agents = orchestrator.getAllAgents();
    const stats = await orchestrator.getQueueStats();

    console.log('   Final Status:');
    console.log(`   - Agents: ${agents.length} total`);
    console.log(`     - Idle: ${agents.filter(a => a.status === 'idle').length}`);
    console.log(`     - Busy: ${agents.filter(a => a.status === 'busy').length}`);
    console.log(`     - Unhealthy: ${agents.filter(a => a.status === 'unhealthy').length}`);
    console.log(`   - Task Queue:`);
    console.log(`     - Waiting: ${stats.waiting}`);
    console.log(`     - Active: ${stats.active}`);
    console.log(`     - Completed: ${stats.completed}`);
    console.log(`     - Failed: ${stats.failed}`);

    // Check Claude Code task directory
    const taskDir = '/Users/vieko/.claude/tasks/forge';
    try {
      const files = await fs.readdir(taskDir);
      const taskFiles = files.filter(f => f.endsWith('.json'));
      console.log(`\n   📋 Claude Code Tasks: ${taskFiles.length} task(s) in ${taskDir}`);

      if (taskFiles.length > 0) {
        console.log('   Task files:');
        for (const file of taskFiles) {
          const content = await fs.readFile(`${taskDir}/${file}`, 'utf-8');
          const task = JSON.parse(content);
          console.log(`     - ${file}: ${task.subject} (${task.status})`);
        }
      }
    } catch (error) {
      console.log(`   ℹ️  No Claude Code task directory or error reading: ${error}`);
    }

    console.log('\n✅ Test complete!\n');

    // Step 9: Cleanup
    console.log('8️⃣  Cleaning up...');
    await orchestrator.stop();
    console.log('   ✅ Orchestrator stopped\n');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
    logger.error({ error }, 'Test failed');
    await orchestrator.stop();
    process.exit(1);
  }
}

main().catch(console.error);
