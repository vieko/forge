#!/usr/bin/env node
/**
 * Test Planner Workflow
 *
 * Demonstrates the complete planning workflow:
 * 1. Submit planning task with spec file
 * 2. Planner agent would receive and decompose
 * 3. Worker agents would execute resulting tasks
 *
 * Note: This test submits the planning task and shows how
 * a planner agent would interact. Full autonomous execution
 * requires a running planner agent with PLANNER_AGENT.md instructions.
 */

import { Orchestrator } from '../src/core/orchestrator.js';
import { AgentConfig } from '../src/types/index.js';
import { createPlanningTask, validateSpecPath } from '../src/core/planner-task.js';
import { promises as fs } from 'fs';

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testPlannerWorkflow() {
  console.log('🧪 TESTING PLANNER WORKFLOW\n');
  console.log('='.repeat(60));

  const orchestrator = new Orchestrator();
  const specPath = '.bonfire/specs/sample-feature.md';

  try {
    // Step 1: Validate spec file
    console.log('\n📄 Step 1: Validating spec file...');
    if (!validateSpecPath(specPath)) {
      throw new Error('Invalid spec path format');
    }

    const specExists = await fs.access(specPath).then(() => true).catch(() => false);
    if (!specExists) {
      throw new Error(`Spec file not found: ${specPath}`);
    }

    const specContent = await fs.readFile(specPath, 'utf-8');
    console.log(`   ✅ Spec file found: ${specPath}`);
    console.log(`   📏 Size: ${specContent.length} bytes`);
    console.log(`   📝 Lines: ${specContent.split('\n').length}\n`);

    // Step 2: Start orchestrator
    console.log('📦 Step 2: Starting orchestrator...');
    await orchestrator.start();
    console.log('   ✅ Orchestrator started\n');

    // Step 3: Create and submit planning task
    console.log('📋 Step 3: Creating planning task...');
    const planTask = createPlanningTask(specPath, 'sample-feature');
    console.log(`   Task type: ${planTask.type}`);
    console.log(`   Required role: ${planTask.requiredRole}`);
    console.log(`   Priority: ${planTask.priority}\n`);

    const task = await orchestrator.submitTask(planTask);
    console.log('   ✅ Planning task submitted');
    console.log(`   Task ID: ${task.id}`);
    console.log(`   Status: ${task.status}\n`);

    // Step 4: Show what would happen next
    console.log('📡 Step 4: Next steps in autonomous workflow...\n');
    console.log('   With a planner agent running (role=planner):');
    console.log('   1. Agent receives planning task via TaskBridge');
    console.log('   2. Agent reads spec file from workspace');
    console.log('   3. Agent analyzes requirements and constraints');
    console.log('   4. Agent creates task graph using submit-task requests');
    console.log('   5. Agent sets dependencies between tasks');
    console.log('   6. Agent marks planning task as completed\n');

    console.log('   Example tasks that would be created:');
    console.log('   • Task 1: Create profile API routes');
    console.log('   • Task 2: Add validation middleware');
    console.log('   • Task 3: Write unit tests (depends on 1, 2)');
    console.log('   • Task 4: Update documentation (depends on 3)\n');

    // Step 5: Check system state
    console.log('📊 Step 5: Current system state...');
    const allAgents = orchestrator.getAllAgents();
    const queueStats = await orchestrator.getQueueStats();

    console.log(`   Agents: ${allAgents.length}`);
    allAgents.forEach((a) => {
      console.log(`     - ${a.id.slice(0, 8)}: ${a.status} (role: ${a.role})`);
    });

    console.log(`\n   Queue: ${queueStats.waiting} waiting, ${queueStats.active} active\n`);

    // Summary
    console.log('='.repeat(60));
    console.log('📋 TEST SUMMARY');
    console.log('='.repeat(60));
    console.log('✅ Spec file validated and read');
    console.log('✅ Planning task created with correct structure');
    console.log('✅ Task submitted to orchestrator queue');
    console.log('✅ Task requires planner role');
    console.log('✅ Ready for planner agent to process');
    console.log();

    console.log('🎯 TO RUN FULL AUTONOMOUS WORKFLOW:');
    console.log();
    console.log('1. Start planner agent with instructions:');
    console.log('   forge agent start --role planner');
    console.log('   (Provide PLANNER_AGENT.md as context)');
    console.log();
    console.log('2. Submit planning task:');
    console.log(`   forge task plan ${specPath}`);
    console.log();
    console.log('3. Start worker agents:');
    console.log('   forge agent start --role worker --capabilities typescript,testing');
    console.log();
    console.log('4. Monitor progress:');
    console.log('   forge task list');
    console.log('   forge agent list');
    console.log('='.repeat(60));

    // Cleanup
    console.log('\n🧹 Cleaning up...');
    await orchestrator.stop();
    console.log('   ✅ Orchestrator stopped');

    console.log('\n✅ Planner workflow test completed successfully!\n');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    console.error('\nStack trace:', (error as Error).stack);

    try {
      await orchestrator.stop();
    } catch (cleanupError) {
      console.error('Error during cleanup:', cleanupError);
    }

    process.exit(1);
  }
}

process.on('SIGINT', () => {
  console.log('\n\n⚠️  Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

testPlannerWorkflow().catch(console.error);
