# Agent↔Orchestrator Message Protocol

## Overview

Bidirectional communication protocol using JSON messages over stdin/stdout pipes between agents and the orchestrator.

## Design Principles

1. **JSON-based**: All messages are JSON objects for easy parsing
2. **Type-safe**: Structured message types with clear schemas
3. **Request/Response**: Correlation IDs for matching responses to requests
4. **Event-driven**: Agents can emit events without expecting responses
5. **Backward Compatible**: Non-JSON output treated as logs
6. **Error Handling**: Standardized error responses

## Message Format

### Base Message Structure

```typescript
interface BaseMessage {
  type: MessageType;
  id: string;              // UUID for correlation
  timestamp: string;       // ISO 8601
  agentId?: string;        // Set by orchestrator if missing
}
```

### Message Types

```typescript
type MessageType =
  // Agent → Orchestrator (Requests)
  | 'request:query-agents'
  | 'request:query-tasks'
  | 'request:submit-task'
  | 'request:get-task'
  | 'request:ask-user'

  // Agent → Orchestrator (Events)
  | 'event:progress'
  | 'event:log'
  | 'event:error'
  | 'event:question'

  // Orchestrator → Agent (Responses)
  | 'response:success'
  | 'response:error'

  // Orchestrator → Agent (Notifications)
  | 'notify:task-assigned'
  | 'notify:task-cancelled'
  | 'notify:shutdown';
```

## Request/Response Pattern

### Agent Request

```json
{
  "type": "request:query-agents",
  "id": "req-123e4567-e89b-12d3-a456-426614174000",
  "timestamp": "2026-02-04T14:30:00Z",
  "payload": {
    "role": "worker",
    "status": "idle"
  }
}
```

### Orchestrator Response (Success)

```json
{
  "type": "response:success",
  "id": "res-123e4567-e89b-12d3-a456-426614174000",
  "correlationId": "req-123e4567-e89b-12d3-a456-426614174000",
  "timestamp": "2026-02-04T14:30:00.123Z",
  "payload": {
    "agents": [
      { "id": "agent-1", "role": "worker", "status": "idle" },
      { "id": "agent-2", "role": "worker", "status": "busy" }
    ]
  }
}
```

### Orchestrator Response (Error)

```json
{
  "type": "response:error",
  "id": "res-123e4567-e89b-12d3-a456-426614174000",
  "correlationId": "req-123e4567-e89b-12d3-a456-426614174000",
  "timestamp": "2026-02-04T14:30:00.123Z",
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Invalid role specified",
    "details": { "role": "invalid-role" }
  }
}
```

## Event Pattern (Fire-and-Forget)

### Agent Event

```json
{
  "type": "event:progress",
  "id": "evt-123e4567-e89b-12d3-a456-426614174000",
  "timestamp": "2026-02-04T14:30:00Z",
  "payload": {
    "taskId": "task-123",
    "progress": 0.5,
    "message": "Halfway through implementation"
  }
}
```

No response expected for events.

## Supported Requests

### 1. Query Agents

**Request:**
```json
{
  "type": "request:query-agents",
  "id": "...",
  "timestamp": "...",
  "payload": {
    "role": "worker" | "planner" | "reviewer",  // optional
    "status": "idle" | "busy" | ...,            // optional
    "capabilities": ["typescript", "testing"]    // optional
  }
}
```

**Response:**
```json
{
  "type": "response:success",
  "id": "...",
  "correlationId": "...",
  "timestamp": "...",
  "payload": {
    "agents": [
      {
        "id": "agent-1",
        "role": "worker",
        "status": "idle",
        "capabilities": ["typescript"],
        "currentTask": null
      }
    ]
  }
}
```

### 2. Query Tasks

**Request:**
```json
{
  "type": "request:query-tasks",
  "id": "...",
  "timestamp": "...",
  "payload": {
    "status": "queued" | "running" | "completed",  // optional
    "requiredRole": "worker",                      // optional
    "limit": 10                                    // optional
  }
}
```

**Response:**
```json
{
  "type": "response:success",
  "id": "...",
  "correlationId": "...",
  "timestamp": "...",
  "payload": {
    "tasks": [
      {
        "id": "task-1",
        "name": "Implement feature",
        "status": "queued",
        "requiredRole": "worker",
        "dependencies": []
      }
    ]
  }
}
```

### 3. Submit Task

**Request:**
```json
{
  "type": "request:submit-task",
  "id": "...",
  "timestamp": "...",
  "payload": {
    "type": "implementation",
    "name": "Fix bug in auth",
    "description": "...",
    "payload": { "file": "src/auth.ts" },
    "requiredRole": "worker",
    "requiredCapabilities": ["typescript"],
    "dependencies": ["task-parent-id"],
    "priority": 2
  }
}
```

**Response:**
```json
{
  "type": "response:success",
  "id": "...",
  "correlationId": "...",
  "timestamp": "...",
  "payload": {
    "task": {
      "id": "task-new-123",
      "status": "queued",
      "...": "..."
    }
  }
}
```

### 4. Get Task

**Request:**
```json
{
  "type": "request:get-task",
  "id": "...",
  "timestamp": "...",
  "payload": {
    "taskId": "task-123"
  }
}
```

**Response:**
```json
{
  "type": "response:success",
  "id": "...",
  "correlationId": "...",
  "timestamp": "...",
  "payload": {
    "task": {
      "id": "task-123",
      "name": "...",
      "status": "completed",
      "result": { "success": true }
    }
  }
}
```

### 5. Ask User (Interactive)

**Request:**
```json
{
  "type": "request:ask-user",
  "id": "...",
  "timestamp": "...",
  "payload": {
    "question": "Which authentication method should I use?",
    "options": [
      { "label": "OAuth 2.0", "value": "oauth" },
      { "label": "JWT", "value": "jwt" }
    ],
    "timeout": 300000  // 5 minutes
  }
}
```

**Response:**
```json
{
  "type": "response:success",
  "id": "...",
  "correlationId": "...",
  "timestamp": "...",
  "payload": {
    "answer": "oauth",
    "metadata": { "answeredAt": "2026-02-04T14:35:00Z" }
  }
}
```

## Supported Events

### 1. Progress Update

```json
{
  "type": "event:progress",
  "id": "...",
  "timestamp": "...",
  "payload": {
    "taskId": "task-123",
    "progress": 0.75,
    "message": "Tests passing, writing docs"
  }
}
```

### 2. Log Entry

```json
{
  "type": "event:log",
  "id": "...",
  "timestamp": "...",
  "payload": {
    "level": "info" | "warn" | "error",
    "message": "Completed database migration",
    "context": { "table": "users", "rows": 1000 }
  }
}
```

### 3. Error Report

```json
{
  "type": "event:error",
  "id": "...",
  "timestamp": "...",
  "payload": {
    "taskId": "task-123",
    "error": "TypeError: Cannot read property 'x' of undefined",
    "stack": "...",
    "recoverable": false
  }
}
```

### 4. Question (Non-blocking)

```json
{
  "type": "event:question",
  "id": "...",
  "timestamp": "...",
  "payload": {
    "question": "Should I proceed with breaking changes?",
    "context": { "affectedFiles": 15 }
  }
}
```

## Orchestrator Notifications

### 1. Task Assigned

```json
{
  "type": "notify:task-assigned",
  "id": "...",
  "timestamp": "...",
  "payload": {
    "taskId": "task-123",
    "message": "Task assigned. Use TaskGet to view details."
  }
}
```

### 2. Task Cancelled

```json
{
  "type": "notify:task-cancelled",
  "id": "...",
  "timestamp": "...",
  "payload": {
    "taskId": "task-123",
    "reason": "Dependency failed"
  }
}
```

### 3. Shutdown

```json
{
  "type": "notify:shutdown",
  "id": "...",
  "timestamp": "...",
  "payload": {
    "gracePeriod": 30000,  // 30 seconds
    "reason": "Orchestrator stopping"
  }
}
```

## Error Codes

```typescript
type ErrorCode =
  | 'INVALID_REQUEST'      // Malformed request
  | 'INVALID_MESSAGE_TYPE' // Unknown message type
  | 'UNAUTHORIZED'         // Agent not authorized for operation
  | 'NOT_FOUND'           // Resource not found
  | 'TIMEOUT'             // Request timed out
  | 'INTERNAL_ERROR';     // Unexpected error
```

## Implementation Notes

### Parsing Strategy

1. **Orchestrator receives agent output:**
   - Try to parse as JSON
   - If valid JSON with `type` field → route to MessageHandler
   - If not JSON → treat as log output

2. **Agent receives orchestrator input:**
   - Parse JSON from stdin
   - Route by message type
   - Handle responses via correlation ID

### Backward Compatibility

- Existing agents that don't use message protocol continue to work
- Log output (non-JSON) is captured as before
- Task notifications still sent via stdin

### Timeouts

- Requests timeout after 30 seconds (configurable)
- Long-running operations should use event pattern
- Progress events keep connection alive

### Correlation

- Each request gets unique UUID
- Response includes `correlationId` matching request `id`
- Timeout handler cleans up pending requests

## Usage Example

### Agent Side (TypeScript)

```typescript
// Send request
const request = {
  type: 'request:query-tasks',
  id: randomUUID(),
  timestamp: new Date().toISOString(),
  payload: { status: 'queued' }
};
console.log(JSON.stringify(request));

// Listen for response
process.stdin.on('data', (data) => {
  const message = JSON.parse(data.toString());
  if (message.correlationId === request.id) {
    // Handle response
    console.error('Received response:', message.payload);
  }
});
```

### Orchestrator Side (Forge)

```typescript
// Parse agent stdout
childProcess.stdout.on('data', (data) => {
  try {
    const message = JSON.parse(data.toString());
    if (message.type?.startsWith('request:')) {
      await messageHandler.handleRequest(agentId, message);
    } else if (message.type?.startsWith('event:')) {
      await messageHandler.handleEvent(agentId, message);
    }
  } catch {
    // Not JSON, treat as log
    logEmitter.emit('log', { message: data.toString() });
  }
});
```

## Security Considerations

1. **Validation**: All messages validated against schema
2. **Authorization**: Agents can only query their own tasks
3. **Rate Limiting**: Prevent message flooding (100 msg/sec limit)
4. **Sanitization**: User-facing content escaped
5. **Audit**: All requests logged with agent ID

## Future Enhancements

- Message compression for large payloads
- Binary protocol for performance
- Message batching for efficiency
- Pub/sub for agent-to-agent communication
- WebSocket upgrade for remote agents
