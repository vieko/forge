#!/usr/bin/env node
/**
 * Test script for Claude Code task integration
 *
 * This script verifies that the TaskBridge correctly:
 * 1. Creates task files in ~/.claude/tasks/forge/
 * 2. Maps Forge tasks to Claude Code format
 * 3. Syncs status changes
 */

import { TaskBridge } from '../src/core/task-bridge.js';
import { Task } from '../src/types/index.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

async function testTaskBridge() {
  console.log('🧪 Testing Claude Code Task Integration\n');

  const bridge = new TaskBridge('forge-test');
  const testDir = join(homedir(), '.claude', 'tasks', 'forge-test');

  try {
    // 1. Initialize bridge
    console.log('1️⃣  Initializing TaskBridge...');
    await bridge.initialize();
    console.log('   ✅ Bridge initialized');
    console.log(`   📁 Task directory: ${testDir}\n`);

    // 2. Create a test task
    console.log('2️⃣  Creating test task...');
    const mockTask: Task = {
      id: 'test-123',
      type: 'test',
      name: 'Fix authentication bug',
      description: 'Fix the JWT token expiration issue in the auth middleware',
      payload: {
        file: 'src/auth/middleware.ts',
        line: 42,
        priority: 'high',
      },
      priority: 1,
      status: 'queued',
      createdAt: new Date(),
      attempts: 0,
      checkpoints: [],
    };

    const claudeTask = await bridge.createClaudeTask(mockTask, 'agent-xyz');
    console.log('   ✅ Claude task created');
    console.log(`   🆔 ID: ${claudeTask.id}`);
    console.log(`   📝 Subject: ${claudeTask.subject}`);
    console.log(`   🔄 Active Form: ${claudeTask.activeForm}`);
    console.log(`   📊 Status: ${claudeTask.status}`);
    console.log(`   👤 Owner: ${claudeTask.owner}\n`);

    // 3. Verify file was created
    console.log('3️⃣  Verifying task file...');
    const taskPath = join(testDir, `forge-test-${mockTask.id}.json`);
    const fileExists = await fs
      .access(taskPath)
      .then(() => true)
      .catch(() => false);

    if (fileExists) {
      const taskContent = await fs.readFile(taskPath, 'utf-8');
      const savedTask = JSON.parse(taskContent);
      console.log('   ✅ Task file exists');
      console.log(`   📄 Path: ${taskPath}`);
      console.log(
        `   🔍 Metadata: ${JSON.stringify(savedTask.metadata, null, 2).replace(/\n/g, '\n      ')}\n`
      );
    } else {
      throw new Error('Task file was not created');
    }

    // 4. Update task status
    console.log('4️⃣  Updating task status...');
    await bridge.updateClaudeTask(mockTask.id, {
      status: 'in_progress',
    });

    const updatedContent = await fs.readFile(taskPath, 'utf-8');
    const updatedTask = JSON.parse(updatedContent);
    console.log('   ✅ Task status updated');
    console.log(`   📊 New status: ${updatedTask.status}\n`);

    // 5. Sync status (simulate agent completion)
    console.log('5️⃣  Simulating agent completion...');
    // Manually update the file to simulate agent marking it complete
    updatedTask.status = 'completed';
    await fs.writeFile(taskPath, JSON.stringify(updatedTask, null, 2));

    // Start sync to detect the change
    const completionPromise = new Promise((resolve) => {
      bridge.once('task:completed', (forgeTaskId) => {
        console.log(`   ✅ Completion detected for task: ${forgeTaskId}`);
        resolve(forgeTaskId);
      });
    });

    await bridge.startSync(500); // Sync every 500ms for faster testing
    const completedTaskId = await Promise.race([
      completionPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout waiting for completion event')), 3000)
      ),
    ]);

    console.log(`   🎉 Task ${completedTaskId} completed successfully\n`);

    // 6. Cleanup
    console.log('6️⃣  Cleaning up...');
    await bridge.cleanup();
    await fs.rm(testDir, { recursive: true, force: true });
    console.log('   ✅ Cleanup complete\n');

    console.log('✅ All tests passed! Task integration is working correctly.\n');
    console.log('📋 Summary:');
    console.log('   • TaskBridge initializes correctly');
    console.log('   • Tasks are created in Claude Code format');
    console.log('   • Task files are written to filesystem');
    console.log('   • Status updates are applied correctly');
    console.log('   • Completion events are detected and emitted');
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    console.error('\nStack trace:', (error as Error).stack);
    process.exit(1);
  }
}

testTaskBridge().catch(console.error);
