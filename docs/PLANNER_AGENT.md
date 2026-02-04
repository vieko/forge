# Planner Agent Guide

## Overview

Planner agents are specialized Claude Code agents with `role=planner` that decompose high-level specifications into executable task graphs. They read Bonfire-style specification files and create structured task hierarchies that worker agents can execute in parallel.

## Role and Responsibilities

### Primary Function
Read `.bonfire/specs/*.md` files and break them down into:
- **Discrete tasks** with clear acceptance criteria
- **Dependencies** that define execution order
- **Parallelizable work** to maximize throughput
- **Verification steps** (tests, linting, docs)

### Key Capabilities
- Read and analyze specification documents
- Identify task boundaries and dependencies
- Create tasks using message protocol
- Set task metadata and requirements
- Report progress and ask clarifying questions

## How It Works

### 1. Receiving Planning Tasks

When you receive a planning task (type: "plan"), it contains:
```json
{
  "type": "plan",
  "name": "Plan: feature-name",
  "payload": {
    "specPath": ".bonfire/specs/feature-name.md",
    "workflowId": "feature-name"
  }
}
```

Use `TaskGet` to retrieve full task details:
```typescript
const task = await TaskGet("forge-<task-id>");
```

### 2. Reading the Specification

Read the spec file from the workspace:
```typescript
const specContent = await readFile(task.payload.specPath, 'utf-8');
```

Analyze the specification for:
- **Outcomes**: What success looks like
- **Context**: Current state and constraints
- **Requirements**: Functional and non-functional needs
- **Files**: What code needs to change

### 3. Decomposing into Tasks

Create tasks that are:
- **Atomic**: Completable in < 30 minutes
- **Clear**: Unambiguous acceptance criteria
- **Testable**: Verifiable completion
- **Parallelizable**: Minimal dependencies

#### Task Creation Pattern

Use the message protocol to create tasks:
```json
{
  "type": "request:submit-task",
  "id": "<uuid>",
  "timestamp": "<iso-8601>",
  "payload": {
    "type": "implementation",
    "name": "Implement user authentication",
    "description": "Add JWT-based authentication to API endpoints. Success criteria: (1) Login endpoint returns JWT token, (2) Protected endpoints require valid token, (3) Tests pass.",
    "payload": {
      "files": ["src/auth/jwt.ts", "src/middleware/auth.ts"],
      "tests": ["src/auth/__tests__/jwt.test.ts"]
    },
    "requiredRole": "worker",
    "requiredCapabilities": ["typescript", "testing"],
    "dependencies": [],
    "priority": 2
  }
}
```

Write this JSON to stdout to send the request.

### 4. Establishing Dependencies

Tasks with dependencies should specify them using the `dependencies` field:
```json
{
  "name": "Write tests for authentication",
  "dependencies": ["<task-id-of-implementation>"],
  ...
}
```

Dependency Guidelines:
- **Minimize**: Only add when truly required
- **Parallelism**: Maximize concurrent execution
- **Logical**: Implementation before tests, tests before docs

### 5. Task Types and Priorities

**Task Types:**
- `implementation`: Write feature code (priority 2-3)
- `testing`: Write or fix tests (priority 2)
- `refactoring`: Improve code structure (priority 3-4)
- `documentation`: Update docs (priority 4-5)
- `verification`: Run tests/linting (priority 1-2)

**Priority Levels** (1=highest, 5=lowest):
- **1**: Blocking (setup, critical dependencies)
- **2**: Core functionality
- **3**: Additional features
- **4**: Documentation
- **5**: Nice-to-haves

### 6. Progress Reporting

Report progress as you work:
```json
{
  "type": "event:progress",
  "id": "<uuid>",
  "timestamp": "<iso-8601>",
  "payload": {
    "taskId": "<your-planning-task-id>",
    "progress": 0.5,
    "message": "Created 5 of 10 planned tasks"
  }
}
```

### 7. Asking Questions

If requirements are unclear:
```json
{
  "type": "request:ask-user",
  "id": "<uuid>",
  "timestamp": "<iso-8601>",
  "payload": {
    "question": "Which authentication method should we use?",
    "options": [
      {"label": "OAuth 2.0", "value": "oauth"},
      {"label": "JWT", "value": "jwt"},
      {"label": "Session-based", "value": "session"}
    ],
    "timeout": 300000
  }
}
```

### 8. Completing Planning

When all tasks are created:
1. Use `TaskUpdate` to mark your planning task as completed
2. Report final task count in progress event
3. Let orchestrator assign tasks to workers

## Message Protocol Reference

### Query Available Workers
```json
{
  "type": "request:query-agents",
  "id": "<uuid>",
  "timestamp": "<iso-8601>",
  "payload": {
    "role": "worker",
    "status": "idle",
    "capabilities": ["typescript"]
  }
}
```

### Query Existing Tasks
```json
{
  "type": "request:query-tasks",
  "id": "<uuid>",
  "timestamp": "<iso-8601>",
  "payload": {
    "status": "queued",
    "limit": 50
  }
}
```

### Submit New Task
```json
{
  "type": "request:submit-task",
  "id": "<uuid>",
  "timestamp": "<iso-8601>",
  "payload": {
    "type": "implementation",
    "name": "Task name",
    "description": "Detailed requirements and acceptance criteria",
    "payload": {"files": [...]},
    "requiredRole": "worker",
    "requiredCapabilities": ["typescript"],
    "dependencies": [],
    "priority": 2
  }
}
```

## Task Decomposition Principles

### 1. Atomic Tasks
Each task should be independently completable:
- ❌ "Implement entire authentication system"
- ✅ "Implement JWT token generation"
- ✅ "Add authentication middleware"
- ✅ "Write authentication tests"

### 2. Clear Acceptance Criteria
Tasks must have measurable success criteria:
- ❌ "Make the API better"
- ✅ "Add rate limiting: (1) 100 req/min limit, (2) Return 429 on exceed, (3) Tests verify limit"

### 3. Dependency Minimization
Only add dependencies when order matters:
```
✅ Good: Parallel execution
- Task A: Implement feature X
- Task B: Implement feature Y (no dependency on A)
- Task C: Write tests for X (depends on A)
- Task D: Write tests for Y (depends on B)

❌ Bad: Artificial serialization
- Task A: Implement feature X
- Task B: Implement feature Y (depends on A - why?)
- Task C: Write tests (depends on B - could be parallel)
```

### 4. Include Verification
Always add verification tasks:
- Run unit tests
- Run integration tests
- Check linting
- Verify build
- Update documentation

### 5. Handle Edge Cases
Consider:
- Error handling tasks
- Migration tasks (if changing data structures)
- Rollback procedures
- Performance testing
- Security review

## Example Planning Session

### Input Spec
```markdown
# Add User Authentication

## Outcomes
- Users can create accounts and log in
- API endpoints are protected
- JWT tokens expire after 24 hours

## Context
- Express.js API (src/api/)
- PostgreSQL database
- No authentication currently exists

## Requirements
- Email/password authentication
- JWT token-based sessions
- Password hashing with bcrypt
- Protected routes middleware
```

### Generated Tasks

**Task 1: Database Schema**
```
Type: implementation
Name: Create users table with authentication fields
Description: Add migration for users table with email, password_hash, created_at
Dependencies: []
Priority: 1
Capabilities: [sql, migrations]
```

**Task 2: Password Hashing**
```
Type: implementation
Name: Implement password hashing utilities
Description: Create bcrypt wrapper for hashing/comparing passwords
Dependencies: []
Priority: 2
Capabilities: [typescript, security]
```

**Task 3: JWT Service**
```
Type: implementation
Name: Implement JWT token generation and verification
Description: Create service for generating and validating JWT tokens (24h expiry)
Dependencies: []
Priority: 2
Capabilities: [typescript, security]
```

**Task 4: Registration Endpoint**
```
Type: implementation
Name: Create user registration endpoint
Description: POST /auth/register - validate email, hash password, create user
Dependencies: [Task1, Task2]
Priority: 2
Capabilities: [typescript, api]
```

**Task 5: Login Endpoint**
```
Type: implementation
Name: Create login endpoint
Description: POST /auth/login - validate credentials, return JWT
Dependencies: [Task1, Task2, Task3]
Priority: 2
Capabilities: [typescript, api]
```

**Task 6: Auth Middleware**
```
Type: implementation
Name: Create authentication middleware
Description: Middleware to verify JWT and attach user to request
Dependencies: [Task3]
Priority: 2
Capabilities: [typescript, api]
```

**Task 7: Protect Routes**
```
Type: implementation
Name: Add authentication to protected routes
Description: Apply auth middleware to routes that require authentication
Dependencies: [Task6]
Priority: 3
Capabilities: [typescript, api]
```

**Task 8: Tests**
```
Type: testing
Name: Write authentication tests
Description: Test registration, login, JWT validation, protected routes
Dependencies: [Task4, Task5, Task6, Task7]
Priority: 2
Capabilities: [typescript, testing]
```

**Task 9: Documentation**
```
Type: documentation
Name: Document authentication API
Description: Add API docs for /auth endpoints and authentication flow
Dependencies: [Task8]
Priority: 4
Capabilities: [documentation]
```

## Tips and Best Practices

### Communication
- Report progress every 5-10 tasks created
- Ask questions early if requirements unclear
- Log your reasoning for task breakdown

### Task Granularity
- Aim for 5-15 tasks per feature
- Split large tasks (> 1 hour) into smaller ones
- Combine tiny tasks (< 10 minutes) into larger units

### Capability Matching
- Check available workers: `query-agents` request
- Match required capabilities to worker capabilities
- Don't over-specify: ["typescript"] better than ["typescript", "express", "jwt"]

### Error Handling
- If spec file missing: fail fast with clear error
- If spec unclear: ask user for clarification
- If stuck: report progress and ask for help

### Workflow IDs
- Use workflow ID to group related tasks
- Helps with monitoring and debugging
- Enables workflow-level operations in future

## Troubleshooting

### Planning Task Stuck
- Check you're actually receiving the task via TaskList
- Verify you have Read access to spec file
- Check orchestrator logs for errors

### Tasks Not Being Assigned
- Verify workers are running: `query-agents`
- Check task dependencies are satisfiable
- Verify requiredRole and requiredCapabilities match available agents

### Duplicate Tasks
- Use workflow ID to avoid recreating tasks
- Query existing tasks before creating: `query-tasks`
- Check task names for uniqueness

## Next Steps

After planning completes:
1. Worker agents receive tasks via TaskBridge
2. Workers execute tasks in dependency order
3. Orchestrator manages parallel execution
4. Tasks update status via TaskUpdate
5. Workflow completes when all tasks done

The orchestrator handles all coordination - you just create the task graph!
