#!/bin/bash
set -e

echo "════════════════════════════════════════"
echo "  Forge Orchestrator - Complete Demo"
echo "════════════════════════════════════════"
echo ""

# Build the project
echo "📦 Building project..."
npm run build > /dev/null 2>&1
echo "✓ Build complete"
echo ""

# Check initial status
echo "📊 Initial Status:"
echo "──────────────────────────────────────"
node dist/cli/index.js status
echo ""

# Start an agent
echo "🚀 Starting Agent..."
echo "──────────────────────────────────────"
AGENT_OUTPUT=$(node dist/cli/index.js agent start --tags "demo,testing" 2>&1)
echo "$AGENT_OUTPUT"
AGENT_ID=$(echo "$AGENT_OUTPUT" | grep "ID:" | awk '{print $2}')
echo ""
echo "✓ Agent started with ID: $AGENT_ID"
echo ""

# Wait a moment for agent to initialize
sleep 2

# List agents
echo "📋 Active Agents:"
echo "──────────────────────────────────────"
node dist/cli/index.js agent list
echo ""

# Submit a task
echo "📝 Submitting Task..."
echo "──────────────────────────────────────"
TASK_OUTPUT=$(node dist/cli/index.js task submit --file examples/demo-task.json 2>&1)
echo "$TASK_OUTPUT"
TASK_ID=$(echo "$TASK_OUTPUT" | grep "Task submitted:" | awk '{print $3}')
echo ""
echo "✓ Task submitted with ID: $TASK_ID"
echo ""

# Wait a moment for task to be processed
sleep 2

# Show task queue stats
echo "📊 Task Queue Statistics:"
echo "──────────────────────────────────────"
node dist/cli/index.js task stats
echo ""

# List all tasks
echo "📋 All Tasks:"
echo "──────────────────────────────────────"
node dist/cli/index.js task list
echo ""

# Get detailed task info
echo "🔍 Task Details:"
echo "──────────────────────────────────────"
node dist/cli/index.js task get "$TASK_ID" | head -20
echo ""

# Get agent details
echo "🤖 Agent Details:"
echo "──────────────────────────────────────"
node dist/cli/index.js agent get "$AGENT_ID"
echo ""

# Final status
echo "📊 Final Status:"
echo "──────────────────────────────────────"
node dist/cli/index.js status
echo ""

# Cleanup
echo "🧹 Cleanup:"
echo "──────────────────────────────────────"
if [ ! -z "$AGENT_ID" ]; then
  echo "Stopping agent $AGENT_ID..."
  node dist/cli/index.js agent stop "$AGENT_ID" --force 2>&1 || echo "Agent already stopped"
fi
echo "✓ Cleanup complete"
echo ""

echo "════════════════════════════════════════"
echo "  Demo Complete! 🎉"
echo "════════════════════════════════════════"
echo ""
echo "Summary:"
echo "  - Agent spawned and managed"
echo "  - Task submitted and queued"
echo "  - Coordination between components working"
echo "  - Clean shutdown executed"
echo ""
