# Claude Code Task Integration

This document describes how Forge integrates with Claude Code's native task system for multi-agent coordination.

## Overview

Forge uses a **hybrid bridge architecture** where BullMQ remains the source of truth for task orchestration, while tasks are synced to Claude Code's native task system at `~/.claude/tasks/forge/`. This gives agents full transparency into the task queue using their built-in TaskList, TaskGet, and TaskUpdate tools.

## Architecture

```
┌─────────────────────────────────────────────┐
│         Forge Orchestrator                  │
│    (BullMQ - Source of Truth)               │
└────────────┬────────────────────────────────┘
             │ sync via TaskBridge
             v
┌─────────────────────────────────────────────┐
│    ~/.claude/tasks/forge/                   │
│    (Shared Task List - Agent View)          │
│    - task-1.json                            │
│    - task-2.json                            │
│    - metadata.json                          │
└────────────┬────────────────────────────────┘
             │ TaskList/TaskGet/TaskUpdate
             v
┌─────────────────────────────────────────────┐
│      Claude Code Agents                     │
│    (Native Task Tools)                      │
└─────────────────────────────────────────────┘
```

## Task Lifecycle

### 1. Task Submission

```bash
forge task submit -t test -n "Fix authentication bug" -p 1
```

The orchestrator:
1. Creates task in BullMQ queue (status: `queued`)
2. Emits `task:created` event

### 2. Task Assignment

When an idle agent is available, the orchestrator:

1. **Marks agent as busy** - `AgentManager.assignTask()`
2. **Creates Claude Code task** - `TaskBridge.createClaudeTask()`
   - Writes task JSON to `~/.claude/tasks/forge/forge-{taskId}.json`
   - Maps Forge task fields to Claude format
3. **Notifies agent via stdin** - `LocalProcessAdapter.executeTask()`
   - Sends JSON message: `{ type: 'task_notification', taskId: '...', message: '...' }`

Task file structure:
```json
{
  "id": "forge-abc123",
  "subject": "Fix authentication bug",
  "description": "Detailed task description with payload...",
  "activeForm": "Fixing authentication bug",
  "status": "pending",
  "owner": "agent-xyz",
  "metadata": {
    "forgeTaskId": "abc123",
    "forgeAgentId": "agent-xyz",
    "forgeTaskType": "test",
    "priority": 1,
    "createdAt": "2025-01-15T10:30:00Z"
  }
}
```

### 3. Agent Execution

The agent receives the stdin notification and:

1. **Lists tasks** - Runs `TaskList` to see all pending tasks
2. **Reads details** - Runs `TaskGet {taskId}` to read full task description
3. **Marks in progress** - Runs `TaskUpdate {taskId, status: 'in_progress'}`
4. **Performs work** - Executes the task
5. **Marks complete** - Runs `TaskUpdate {taskId, status: 'completed'}`

### 4. Sync & Completion

TaskBridge polls every 2 seconds (configurable):

1. Reads all task files in `~/.claude/tasks/forge/`
2. Detects status changes
3. When a task is marked `completed`:
   - Emits `task:completed` event
   - Orchestrator calls `TaskQueue.completeTask()`
   - Updates BullMQ job to completed state
   - Agent is marked as `idle` and ready for next task

## Task Mapping

### Forge → Claude Status

| Forge Status | Claude Status |
|--------------|---------------|
| `pending`, `queued` | `pending` |
| `assigned`, `running` | `in_progress` |
| `completed` | `completed` |
| `failed`, `cancelled` | `deleted` |

### Task Fields

| Forge Field | Claude Field | Notes |
|-------------|--------------|-------|
| `name` | `subject` | Imperative form (e.g., "Fix bug") |
| `name` | `activeForm` | Present continuous (e.g., "Fixing bug") |
| `description` + `payload` | `description` | Full task details |
| `id` | `metadata.forgeTaskId` | Reverse lookup |
| `type` | `metadata.forgeTaskType` | Task type |
| `agentId` | `owner` | Assigned agent |

## Configuration

### Environment Variables

```bash
# Enable native task integration (default: true)
ENABLE_NATIVE_TASKS=true

# Sync interval in milliseconds (default: 2000)
TASK_SYNC_INTERVAL=2000
```

### Settings File

Tasks use the `CLAUDE_CODE_TASK_LIST_ID` from `.claude/settings.local.json`:

```json
{
  "env": {
    "CLAUDE_CODE_TASK_LIST_ID": "forge"
  }
}
```

Agents spawned in this directory automatically inherit this setting, so they all share the same task list at `~/.claude/tasks/forge/`.

## Agent Perspective

From an agent's perspective, tasks appear in their native task system:

```
Agent receives stdin: { type: 'task_notification', taskId: 'abc123', ... }

Agent runs: TaskList
Output:
  ID               Subject                      Status      Owner
  forge-abc123     Fix authentication bug       pending     agent-xyz

Agent runs: TaskGet forge-abc123
Output:
  {
    "subject": "Fix authentication bug",
    "description": "## Task Details\n- Type: test\n- Priority: 1\n...",
    "status": "pending",
    "owner": "agent-xyz"
  }

Agent runs: TaskUpdate forge-abc123 --status in_progress
Agent works on task...
Agent runs: TaskUpdate forge-abc123 --status completed

TaskBridge detects completion → marks task complete in BullMQ → agent goes idle
```

## Troubleshooting

### Tasks not appearing in agent

**Check task directory:**
```bash
ls ~/.claude/tasks/forge/
cat ~/.claude/tasks/forge/forge-*.json
```

**Verify settings:**
```bash
cat .claude/settings.local.json
```

**Check TaskBridge is enabled:**
```bash
# In daemon logs
grep "Task bridge initialized" /var/log/forge-daemon.log
```

### Tasks not syncing back to orchestrator

**Check sync interval:**
```bash
# Verify TASK_SYNC_INTERVAL in .env
cat .env | grep TASK_SYNC_INTERVAL
```

**Monitor sync logs:**
```bash
forge daemon logs --follow | grep task-bridge
```

**Manually verify task status:**
```bash
cat ~/.claude/tasks/forge/forge-{taskId}.json | jq .status
```

### Agent not updating task status

**Verify agent is using correct task list:**
```bash
# Agent should inherit CLAUDE_CODE_TASK_LIST_ID from settings
# Check agent environment
forge agent list -v  # shows agent config
```

**Check stdin notification:**
```bash
# Look for task_notification in agent logs
forge daemon logs | grep task_notification
```

## Performance Considerations

### Sync Interval

The default 2-second sync interval balances responsiveness with disk I/O:

- **Faster (1000ms)**: More responsive, higher disk I/O
- **Slower (5000ms)**: Lower overhead, slight delay in completion detection

Adjust based on your workload:
```bash
# For high-throughput scenarios
TASK_SYNC_INTERVAL=1000

# For resource-constrained environments
TASK_SYNC_INTERVAL=5000
```

### File System Load

Each task creates one JSON file. Monitor disk usage:

```bash
# Count active tasks
ls ~/.claude/tasks/forge/*.json | wc -l

# Check directory size
du -sh ~/.claude/tasks/forge/
```

Completed tasks remain in the directory until manually cleaned:
```bash
# Clean up completed tasks older than 24 hours
find ~/.claude/tasks/forge/ -name "*.json" -mtime +1 -exec rm {} \;
```

## Future Enhancements

### Real-time Sync (inotify/fswatch)

Replace polling with file system watchers for instant sync:

```typescript
import { watch } from 'fs';

watch(this.taskDir, (eventType, filename) => {
  if (filename && filename.endsWith('.json')) {
    void this.syncTaskFile(filename);
  }
});
```

### Task Dependencies

Support Claude Code's `blockedBy` field for task dependencies:

```typescript
claudeTask.blockedBy = forgeTask.dependencies?.map(
  depId => `forge-${depId}`
);
```

### Progress Tracking

Map task progress updates to Claude tasks:

```typescript
claudeTask.metadata.progress = forgeTask.progress;
```

## Backward Compatibility

To disable task integration and use stdin-only mode:

```bash
ENABLE_NATIVE_TASKS=false
```

Agents will still receive task payloads via stdin but won't see tasks in TaskList.

## Examples

### Example 1: Agent workflow

```bash
# Orchestrator assigns task
→ Creates ~/.claude/tasks/forge/forge-abc123.json
→ Sends stdin: { type: 'task_notification', taskId: 'abc123' }

# Agent receives notification
→ Runs: TaskList
→ Sees: forge-abc123 | Fix authentication bug | pending | agent-1

# Agent reads details
→ Runs: TaskGet forge-abc123
→ Sees full description with payload

# Agent starts work
→ Runs: TaskUpdate forge-abc123 --status in_progress

# Agent completes work
→ Runs: TaskUpdate forge-abc123 --status completed

# TaskBridge syncs (within 2s)
→ Reads forge-abc123.json
→ Sees status: completed
→ Emits task:completed event
→ Orchestrator marks BullMQ job complete
→ Agent marked idle
```

### Example 2: Multi-agent coordination

```bash
# Three agents spawned
forge agent start  # agent-1
forge agent start  # agent-2
forge agent start  # agent-3

# Submit three tasks
forge task submit -t test -n "Task A" -p 1
forge task submit -t test -n "Task B" -p 1
forge task submit -t test -n "Task C" -p 1

# All agents see all tasks
TaskList (from any agent):
  forge-a | Task A | in_progress | agent-1
  forge-b | Task B | in_progress | agent-2
  forge-c | Task C | pending     | (unassigned)

# agent-1 finishes first
→ TaskUpdate forge-a --status completed
→ Within 2s: agent-1 gets assigned Task C
```

### Example 3: Error recovery

```bash
# Agent crashes mid-task
forge agent list
→ agent-1: crashed (current task: abc123)

# BullMQ automatically retries task
→ Task abc123 moved back to queue

# Another agent picks it up
→ forge-abc123.json updated: owner = agent-2
→ Agent-2 receives notification
→ Agent-2 completes task
```

## Related Documentation

- [Architecture Overview](ARCHITECTURE.md)
- [Agent Lifecycle](AGENTS.md)
- [Task Queue](TASK_QUEUE.md)
- [Error Handling](ERROR_HANDLING.md)
