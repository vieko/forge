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
  return {
    type: 'plan',
    name: `Plan: ${specPath.replace('.bonfire/specs/', '').replace('.md', '')}`,
    description: `Read specification from ${specPath} and decompose into executable tasks with dependencies`,
    payload: {
      specPath,
      workflowId,
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
