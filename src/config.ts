// ── Forge Local Configuration ────────────────────────────────
//
// Lazy-initialized config from .forge/config.json with zod validation.
// Auto-created with defaults on first access, cached per working directory.
// The config file is local-only (gitignored by the existing `*` wildcard).
// Environment variables take precedence over file values.

import { z } from 'zod';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';

// ── Schema ───────────────────────────────────────────────────

/**
 * Strict schema for generating validation warnings.
 * Every field is optional so we only validate what's present.
 */
const StrictFieldSchemas = {
  setup: z.array(z.string()),
  teardown: z.array(z.string()),
  setupTimeout: z.number().positive(),
  executorIdleTimeout: z.number().positive(),
  dbProvider: z.enum(['sqlite', 'turso']),
  apiPort: z.number().int().positive(),
  apiToken: z.string().nullable(),
  maxWorktrees: z.number().positive(),
  maxWorktreeDiskMb: z.number().positive(),
  worktreePruneTtlDays: z.number().positive(),
} as const;

/**
 * Lenient schema -- uses .catch() on every field so parse() never throws.
 * .default() handles missing fields, .catch() handles invalid values.
 * .passthrough() preserves unknown keys for forward-compatibility.
 */
const ConfigSchema = z.object({
  setup: z.array(z.string()).default([]).catch([]),
  teardown: z.array(z.string()).default([]).catch([]),
  setupTimeout: z.number().positive().default(300000).catch(300000),
  executorIdleTimeout: z.number().positive().default(300000).catch(300000),
  dbProvider: z.enum(['sqlite', 'turso']).default('sqlite').catch('sqlite' as const),
  apiPort: z.number().int().positive().default(4926).catch(4926),
  apiToken: z.string().nullable().default(null).catch(null),
  maxWorktrees: z.number().positive().default(10).catch(10),
  maxWorktreeDiskMb: z.number().positive().default(5000).catch(5000),
  worktreePruneTtlDays: z.number().positive().default(7).catch(7),
}).passthrough();

// ── Types ────────────────────────────────────────────────────

export interface ForgeLocalConfig {
  setup: string[];
  teardown: string[];
  setupTimeout: number;
  executorIdleTimeout: number;
  dbProvider: 'sqlite' | 'turso';
  apiPort: number;
  apiToken: string | null;
  maxWorktrees: number;
  maxWorktreeDiskMb: number;
  worktreePruneTtlDays: number;
}

export const CONFIG_DEFAULTS: ForgeLocalConfig = {
  setup: [],
  teardown: [],
  setupTimeout: 300000,
  executorIdleTimeout: 300000,
  dbProvider: 'sqlite',
  apiPort: 4926,
  apiToken: null,
  maxWorktrees: 10,
  maxWorktreeDiskMb: 5000,
  worktreePruneTtlDays: 7,
};

// ── Cache ────────────────────────────────────────────────────

const configCache = new Map<string, ForgeLocalConfig>();

// ── Validation helpers ───────────────────────────────────────

/**
 * Validate raw parsed JSON and warn about any invalid fields.
 * Does not throw -- warnings are printed to stderr.
 */
function warnInvalidFields(raw: Record<string, unknown>): void {
  for (const [key, schema] of Object.entries(StrictFieldSchemas)) {
    if (!(key in raw)) continue;
    const result = schema.safeParse(raw[key]);
    if (!result.success) {
      const issue = result.error.issues[0];
      console.warn(
        `[forge] config: invalid value for "${key}" -- using default (${issue?.message ?? 'validation failed'})`,
      );
    }
  }
}

// ── Environment variable overrides ───────────────────────────

/**
 * Apply environment variable overrides.
 * Env vars take precedence over file values.
 */
function applyEnvOverrides(config: ForgeLocalConfig): ForgeLocalConfig {
  const result = { ...config };

  if (process.env.FORGE_API_TOKEN !== undefined) {
    result.apiToken = process.env.FORGE_API_TOKEN || null;
  }

  if (process.env.FORGE_API_PORT !== undefined) {
    const port = parseInt(process.env.FORGE_API_PORT, 10);
    if (!isNaN(port) && port > 0) {
      result.apiPort = port;
    }
  }

  if (process.env.FORGE_DB_PROVIDER !== undefined) {
    const provider = process.env.FORGE_DB_PROVIDER;
    if (provider === 'sqlite' || provider === 'turso') {
      result.dbProvider = provider;
    }
  }

  if (process.env.FORGE_SETUP_TIMEOUT !== undefined) {
    const timeout = parseInt(process.env.FORGE_SETUP_TIMEOUT, 10);
    if (!isNaN(timeout) && timeout > 0) {
      result.setupTimeout = timeout;
    }
  }

  if (process.env.FORGE_EXECUTOR_IDLE_TIMEOUT !== undefined) {
    const timeout = parseInt(process.env.FORGE_EXECUTOR_IDLE_TIMEOUT, 10);
    if (!isNaN(timeout) && timeout > 0) {
      result.executorIdleTimeout = timeout;
    }
  }

  if (process.env.FORGE_MAX_WORKTREES !== undefined) {
    const max = parseInt(process.env.FORGE_MAX_WORKTREES, 10);
    if (!isNaN(max) && max > 0) {
      result.maxWorktrees = max;
    }
  }

  if (process.env.FORGE_MAX_WORKTREE_DISK_MB !== undefined) {
    const max = parseInt(process.env.FORGE_MAX_WORKTREE_DISK_MB, 10);
    if (!isNaN(max) && max > 0) {
      result.maxWorktreeDiskMb = max;
    }
  }

  if (process.env.FORGE_WORKTREE_PRUNE_TTL_DAYS !== undefined) {
    const days = parseInt(process.env.FORGE_WORKTREE_PRUNE_TTL_DAYS, 10);
    if (!isNaN(days) && days > 0) {
      result.worktreePruneTtlDays = days;
    }
  }

  return result;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Get the local config for the given working directory.
 *
 * - Auto-creates .forge/config.json with defaults on first access
 * - Validates with zod; invalid values fall back to defaults with a warning
 * - Unknown keys are preserved (forward-compatible)
 * - Cached per resolved path -- subsequent calls return the same object
 * - Environment variables override file values
 */
export function getConfig(workingDir: string): ForgeLocalConfig {
  const configPath = path.resolve(path.join(workingDir, '.forge', 'config.json'));

  const cached = configCache.get(configPath);
  if (cached) return cached;

  let raw: Record<string, unknown> = {};
  let fileExists = false;

  try {
    const content = readFileSync(configPath, 'utf-8');
    raw = JSON.parse(content);
    fileExists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // File exists but couldn't be read/parsed -- warn and use defaults
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[forge] config: could not read config.json: ${message}`);
    }
  }

  // Warn about invalid fields (before lenient parse swallows them)
  if (fileExists) {
    warnInvalidFields(raw);
  }

  // Parse with lenient schema (never throws)
  const parsed = ConfigSchema.parse(raw);
  const config: ForgeLocalConfig = {
    setup: parsed.setup,
    teardown: parsed.teardown,
    setupTimeout: parsed.setupTimeout,
    executorIdleTimeout: parsed.executorIdleTimeout,
    dbProvider: parsed.dbProvider,
    apiPort: parsed.apiPort,
    apiToken: parsed.apiToken,
    maxWorktrees: parsed.maxWorktrees,
    maxWorktreeDiskMb: parsed.maxWorktreeDiskMb,
    worktreePruneTtlDays: parsed.worktreePruneTtlDays,
  };

  // Auto-create config file with defaults if it didn't exist
  if (!fileExists) {
    try {
      const forgeDir = path.join(workingDir, '.forge');
      if (!existsSync(forgeDir)) {
        mkdirSync(forgeDir, { recursive: true });
      }
      writeFileSync(configPath, JSON.stringify(CONFIG_DEFAULTS, null, 2) + '\n');
    } catch {
      // Best effort -- don't fail if we can't write
    }
  }

  // Apply environment variable overrides (highest precedence)
  const finalConfig = applyEnvOverrides(config);

  configCache.set(configPath, finalConfig);
  return finalConfig;
}

// ── Display ──────────────────────────────────────────────────

/**
 * Format config for CLI display.
 * Shows each field with its current value and source (file, env, default).
 */
export function formatConfig(workingDir: string): string {
  const configPath = path.join(workingDir, '.forge', 'config.json');

  // Read the raw file to determine per-field sources
  let fileValues: Record<string, unknown> = {};
  let fileExists = false;
  try {
    fileValues = JSON.parse(readFileSync(configPath, 'utf-8'));
    fileExists = true;
  } catch {
    // No file or parse error
  }

  const config = getConfig(workingDir);
  const lines: string[] = [];

  lines.push(`\x1b[1mForge Configuration\x1b[0m`);
  lines.push(`\x1b[2m${configPath}\x1b[0m`);
  lines.push('');

  const fields: Array<{ key: keyof ForgeLocalConfig; envVar?: string }> = [
    { key: 'setup' },
    { key: 'teardown' },
    { key: 'setupTimeout', envVar: 'FORGE_SETUP_TIMEOUT' },
    { key: 'executorIdleTimeout', envVar: 'FORGE_EXECUTOR_IDLE_TIMEOUT' },
    { key: 'dbProvider', envVar: 'FORGE_DB_PROVIDER' },
    { key: 'apiPort', envVar: 'FORGE_API_PORT' },
    { key: 'apiToken', envVar: 'FORGE_API_TOKEN' },
    { key: 'maxWorktrees', envVar: 'FORGE_MAX_WORKTREES' },
    { key: 'maxWorktreeDiskMb', envVar: 'FORGE_MAX_WORKTREE_DISK_MB' },
    { key: 'worktreePruneTtlDays', envVar: 'FORGE_WORKTREE_PRUNE_TTL_DAYS' },
  ];

  for (const { key, envVar } of fields) {
    const value = config[key];
    let source = 'default';
    if (envVar && process.env[envVar] !== undefined) {
      source = `env (${envVar})`;
    } else if (fileExists && key in fileValues) {
      // Check if the file value was actually valid (not replaced by a default)
      const fieldSchema = StrictFieldSchemas[key as keyof typeof StrictFieldSchemas];
      const validInFile = fieldSchema ? fieldSchema.safeParse(fileValues[key]).success : true;
      source = validInFile ? 'file' : 'default (invalid in file)';
    }

    // Format value for display
    let displayValue: string;
    if (value === null) {
      displayValue = '\x1b[2mnull\x1b[0m';
    } else if (Array.isArray(value)) {
      displayValue = value.length === 0 ? '\x1b[2m[]\x1b[0m' : JSON.stringify(value);
    } else {
      displayValue = String(value);
    }

    const sourceTag = source === 'default'
      ? `\x1b[2m(${source})\x1b[0m`
      : `\x1b[33m(${source})\x1b[0m`;

    lines.push(`  ${key.padEnd(16)} ${displayValue.padEnd(24)} ${sourceTag}`);
  }

  return lines.join('\n');
}

// ── Test helpers ─────────────────────────────────────────────

/**
 * Clear the config cache. Used in tests for isolation.
 */
export function clearConfigCache(): void {
  configCache.clear();
}
