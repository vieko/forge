#!/usr/bin/env node
/**
 * Full Integration Test for Claude Code Task Integration
 *
 * This script tests the complete workflow:
 * 1. Start orchestrator with task bridge
 * 2. Spawn an agent
 * 3. Submit a task
 * 4. Verify task file creation
 * 5. Monitor task execution
 */

import { Orchestrator } from '../src/core/orchestrator.js';
import { AgentConfig } from '../src/types/index.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runIntegrationTest() {
  console.log('🧪 FULL INTEGRATION TEST - Claude Code Task Bridge\n');
  console.log('='.repeat(60));

  const orchestrator = new Orchestrator();
  const taskDir = join(homedir(), '.claude', 'tasks', 'forge');

  try {
    // Step 1: Start orchestrator
    console.log('\n📦 Step 1: Starting orchestrator...');
    await orchestrator.start();
    console.log('   ✅ Orchestrator started');
    await sleep(1000);

    // Step 2: Spawn an agent
    console.log('\n🤖 Step 2: Spawning agent...');
    const agentConfig: AgentConfig = {
      runtime: 'local',
      claudeConfig: {
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: 'claude-sonnet-4-5-20250929',
      },
    };

    const agent = await orchestrator.spawnAgent(agentConfig);
    console.log(`   ✅ Agent spawned: ${agent.id}`);
    console.log(`   📊 Status: ${agent.status}`);
    console.log(`   🏃 Runtime: ${agent.runtime}`);
    console.log(`   🆔 PID: ${agent.pid}`);
    await sleep(2000);

    // Step 3: Submit a task
    console.log('\n📝 Step 3: Submitting task...');
    const task = await orchestrator.submitTask({
      type: 'test',
      name: 'Test task bridge integration',
      description: 'This task tests the TaskBridge integration between Forge and Claude Code',
      payload: {
        test: true,
        timestamp: new Date().toISOString(),
        instructions: 'Use TaskList to view this task, then mark it as completed using TaskUpdate',
      },
      priority: 1,
    });

    console.log(`   ✅ Task submitted: ${task.id}`);
    console.log(`   📊 Status: ${task.status}`);
    console.log(`   ⚡ Priority: ${task.priority}`);
    await sleep(2000);

    // Step 4: Verify task file creation
    console.log('\n📁 Step 4: Verifying task file creation...');
    const taskFiles = await fs.readdir(taskDir).catch(() => []);
    const forgeTaskFile = taskFiles.find(f => f.includes(task.id));

    if (forgeTaskFile) {
      const taskPath = join(taskDir, forgeTaskFile);
      const taskContent = await fs.readFile(taskPath, 'utf-8');
      const claudeTask = JSON.parse(taskContent);

      console.log(`   ✅ Task file created: ${forgeTaskFile}`);
      console.log(`   📄 Location: ${taskPath}`);
      console.log(`   📝 Subject: ${claudeTask.subject}`);
      console.log(`   🔄 Active Form: ${claudeTask.activeForm}`);
      console.log(`   📊 Status: ${claudeTask.status}`);
      console.log(`   👤 Owner: ${claudeTask.owner}`);
      console.log(`   🔍 Metadata:`, JSON.stringify(claudeTask.metadata, null, 2).replace(/\n/g, '\n      '));
    } else {
      console.log('   ⚠️  Task file not found yet (may need to wait for assignment)');
    }

    // Step 5: Monitor queue and agents
    console.log('\n📊 Step 5: Current system state...');
    const queueStats = await orchestrator.getQueueStats();
    const agents = orchestrator.getAllAgents();

    console.log(`   Queue Stats:`);
    console.log(`     - Waiting: ${queueStats.waiting}`);
    console.log(`     - Active: ${queueStats.active}`);
    console.log(`     - Completed: ${queueStats.completed}`);
    console.log(`     - Failed: ${queueStats.failed}`);

    console.log(`   Agents: ${agents.length}`);
    agents.forEach(a => {
      console.log(`     - ${a.id}: ${a.status} (runtime: ${a.runtime})`);
      if (a.currentTask) {
        console.log(`       Current task: ${a.currentTask}`);
      }
    });

    // Step 6: Wait for task assignment
    console.log('\n⏳ Step 6: Waiting for task assignment (5 seconds)...');
    await sleep(5000);

    const updatedTask = await orchestrator.getTask(task.id);
    if (updatedTask) {
      console.log(`   📊 Task status: ${updatedTask.status}`);
      if (updatedTask.agentId) {
        console.log(`   👤 Assigned to: ${updatedTask.agentId}`);
      }
    }

    // Check task file again
    const taskFiles2 = await fs.readdir(taskDir).catch(() => []);
    const forgeTaskFile2 = taskFiles2.find(f => f.includes(task.id));
    if (forgeTaskFile2) {
      const taskPath = join(taskDir, forgeTaskFile2);
      const taskContent = await fs.readFile(taskPath, 'utf-8');
      const claudeTask = JSON.parse(taskContent);
      console.log(`   📊 Claude task status: ${claudeTask.status}`);
    }

    // Step 7: Summary
    console.log('\n' + '='.repeat(60));
    console.log('📋 TEST SUMMARY');
    console.log('='.repeat(60));
    console.log('✅ Orchestrator started with task bridge');
    console.log('✅ Agent spawned successfully');
    console.log('✅ Task submitted to queue');
    console.log(forgeTaskFile ? '✅ Task file created in Claude Code format' : '⚠️  Task file creation pending');
    console.log('✅ Task assignment workflow initiated');

    console.log('\n📝 NEXT STEPS FOR MANUAL VERIFICATION:');
    console.log('1. Check task files:');
    console.log(`   ls -la ${taskDir}/`);
    console.log(`   cat ${taskDir}/forge-${task.id}.json | jq`);
    console.log('\n2. Agent should receive stdin notification');
    console.log('3. Agent can use:');
    console.log('   - TaskList (to see all tasks)');
    console.log('   - TaskGet forge-' + task.id + ' (to read task)');
    console.log('   - TaskUpdate forge-' + task.id + ' --status completed');
    console.log('\n4. TaskBridge will detect completion within 2 seconds');
    console.log('\n' + '='.repeat(60));

    // Keep running for a bit to observe
    console.log('\n⏸️  Keeping orchestrator running for 30 seconds...');
    console.log('   (Press Ctrl+C to stop early)\n');

    let secondsLeft = 30;
    const intervalId = setInterval(() => {
      process.stdout.write(`\r   ⏱️  ${secondsLeft--} seconds remaining...`);
      if (secondsLeft < 0) {
        clearInterval(intervalId);
      }
    }, 1000);

    await sleep(30000);
    console.log('\n');

    // Cleanup
    console.log('🧹 Cleaning up...');
    await orchestrator.stop();
    console.log('   ✅ Orchestrator stopped');

    console.log('\n✅ Integration test completed successfully!\n');

  } catch (error) {
    console.error('\n❌ Integration test failed:', error);
    console.error('\nStack trace:', (error as Error).stack);

    try {
      await orchestrator.stop();
    } catch (cleanupError) {
      console.error('Error during cleanup:', cleanupError);
    }

    process.exit(1);
  }
}

// Handle cleanup on Ctrl+C
process.on('SIGINT', () => {
  console.log('\n\n⚠️  Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

runIntegrationTest().catch(console.error);
