import { TaskDefinition } from '../types/index.js';

export interface PlanningTaskPayload {
  specPath: string; // Path to .bonfire/specs/[feature].md
  workflowId?: string; // Optional workflow identifier
}

export interface PlanningResult {
  success: boolean;
  workflowId: string;
  taskIds: string[]; // Created task IDs
  error?: string;
}

/**
 * Create a planning task definition from a spec file path
 */
export function createPlanningTask(specPath: string, workflowId?: string): TaskDefinition {
  const wfId = workflowId || getWorkflowIdFromSpec(specPath);

  const description = `# Planning Task: ${wfId}

You are a **planner agent**. Your job is to read the specification and decompose it into executable tasks.

## Instructions

1. **Read the spec file**:
   \`\`\`bash
   cat ${specPath}
   \`\`\`

2. **Analyze the specification** for:
   - Outcomes and success criteria
   - Files that need to be created/modified
   - Dependencies between work items
   - Required capabilities (typescript, testing, etc.)

3. **Create tasks by writing ONLY raw JSON to stdout**:

   **CRITICAL**: You MUST output the actual JSON objects directly, NOT explanations or markdown. Use the Bash tool to echo JSON directly to stdout:

   \`\`\`bash
   echo '{"type":"request:submit-task","id":"a7f8c2d1-e5f6-7890-abcd-ef1234567890","timestamp":"2026-02-05T00:00:00Z","payload":{"type":"implementation","name":"Task 1 name","description":"Task 1 details","payload":{"files":["src/file.ts"]},"requiredRole":"worker","requiredCapabilities":["typescript"],"dependencies":[],"priority":1}}'
   echo '{"type":"request:submit-task","id":"b8e9d3f2-e5f6-7890-abcd-ef1234567891","timestamp":"2026-02-05T00:00:01Z","payload":{"type":"implementation","name":"Task 2 name","description":"Task 2 details","payload":{"files":["src/test.ts"]},"requiredRole":"worker","requiredCapabilities":["typescript","testing"],"dependencies":["a7f8c2d1-e5f6-7890-abcd-ef1234567890"],"priority":2}}'
   \`\`\`

   **Do this for EACH task you create.**

   Each task JSON should have this structure:

   \`\`\`json
   {
     "type": "request:submit-task",
     "id": "<generate-uuid-here>",
     "timestamp": "<iso-8601-timestamp>",
     "payload": {
       "type": "implementation",
       "name": "Clear task title",
       "description": "What to do and how to verify success",
       "payload": {
         "files": ["src/file.ts"],
         "tests": ["src/__tests__/file.test.ts"]
       },
       "requiredRole": "worker",
       "requiredCapabilities": ["typescript", "testing"],
       "dependencies": [],
       "priority": 2
     }
   }
   \`\`\`

4. **Use dependencies** to order tasks:
   - Foundation tasks (models, utilities) have no dependencies
   - Feature tasks depend on foundations
   - Test tasks depend on implementations
   - Doc tasks depend on implementations

5. **After creating all tasks**: Write a summary explaining what you created

## Task Decomposition Principles

- **Atomic**: Each task should take < 30 minutes
- **Clear**: Include specific acceptance criteria
- **Testable**: Describe how to verify completion
- **Parallelizable**: Minimize dependencies where possible

## Good Task Example

\`\`\`json
{
  "type": "request:submit-task",
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "timestamp": "2026-02-04T16:00:00Z",
  "payload": {
    "type": "implementation",
    "name": "Create math utility module",
    "description": "Create src/utils/math.ts with add() and multiply() functions.\\n\\nSuccess Criteria:\\n- File exists at src/utils/math.ts\\n- Both functions have JSDoc comments\\n- Functions are exported\\n- Code compiles with no errors",
    "payload": {
      "files": ["src/utils/math.ts"]
    },
    "requiredRole": "worker",
    "requiredCapabilities": ["typescript"],
    "dependencies": [],
    "priority": 1
  }
}
\`\`\`

**Spec Path**: ${specPath}
**Workflow ID**: ${wfId}

Read the spec, decompose it, and create tasks. Good luck! 🚀
`;

  return {
    type: 'plan',
    name: `Plan: ${wfId}`,
    description,
    payload: {
      specPath,
      workflowId: wfId,
    } as unknown as Record<string, unknown>,
    requiredRole: 'planner',
    priority: 1, // High priority - planning blocks all work
    timeout: 300000, // 5 minutes
    retryPolicy: {
      maxAttempts: 3,
      backoffMs: 5000,
      backoffMultiplier: 2,
      maxBackoffMs: 30000,
    },
  };
}

/**
 * Validate spec path format
 */
export function validateSpecPath(specPath: string): boolean {
  // Must be in .bonfire/specs/ directory
  if (!specPath.startsWith('.bonfire/specs/')) {
    return false;
  }

  // Must end with .md
  if (!specPath.endsWith('.md')) {
    return false;
  }

  // Must not contain path traversal
  if (specPath.includes('..')) {
    return false;
  }

  return true;
}

/**
 * Extract workflow ID from spec path
 * Example: .bonfire/specs/feature-name.md -> feature-name
 */
export function getWorkflowIdFromSpec(specPath: string): string {
  return specPath
    .replace('.bonfire/specs/', '')
    .replace('.md', '')
    .replace(/[^a-z0-9-]/gi, '-')
    .toLowerCase();
}
