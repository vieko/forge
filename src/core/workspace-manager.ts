import { promises as fs } from 'fs';
import { join } from 'path';
import { WorkspaceConfig } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export class WorkspaceManager {
  private workspaces: Map<string, WorkspaceConfig> = new Map();
  private logger = createChildLogger({ component: 'workspace-manager' });
  private workspaceRoot: string;
  private baseDir: string;

  constructor(workspaceRoot?: string, baseDir?: string) {
    this.workspaceRoot = workspaceRoot || '/tmp/forge-workspaces';
    this.baseDir = baseDir || process.cwd();
  }

  async createWorkspace(agentId: string): Promise<WorkspaceConfig> {
    this.logger.info({ agentId }, 'Creating workspace');

    const agentWorkspace = join(this.workspaceRoot, `agent-${agentId}`);

    // Create workspace directory
    await fs.mkdir(agentWorkspace, { recursive: true });

    try {
      // Copy working tree (excluding .git, node_modules, etc.)
      await this.copyWorkingTree(this.baseDir, agentWorkspace);

      // Create symlink to shared .git
      const gitSource = join(this.baseDir, '.git');
      const gitTarget = join(agentWorkspace, '.git');

      try {
        await fs.symlink(gitSource, gitTarget, 'dir');
      } catch (err) {
        // If symlink fails, log but continue (workspace still usable)
        this.logger.warn({ agentId, error: err }, 'Failed to create .git symlink');
      }

      const config: WorkspaceConfig = {
        agentId,
        baseDir: this.baseDir,
        workspaceRoot: this.workspaceRoot,
        agentWorkspace,
        sharedGit: true,
      };

      this.workspaces.set(agentId, config);
      this.logger.info({ agentId, workspace: agentWorkspace }, 'Workspace created');

      return config;
    } catch (error) {
      this.logger.error({ agentId, error }, 'Failed to create workspace');
      // Cleanup on failure
      await this.cleanup(agentId).catch(() => {});
      throw error;
    }
  }

  async cleanup(agentId: string): Promise<void> {
    const config = this.workspaces.get(agentId);
    if (!config) {
      this.logger.warn({ agentId }, 'Workspace not found for cleanup');
      return;
    }

    this.logger.info({ agentId, workspace: config.agentWorkspace }, 'Cleaning up workspace');

    try {
      await fs.rm(config.agentWorkspace, { recursive: true, force: true });
      this.workspaces.delete(agentId);
      this.logger.info({ agentId }, 'Workspace cleaned up');
    } catch (error) {
      this.logger.error({ agentId, error }, 'Failed to cleanup workspace');
      throw error;
    }
  }

  async cleanupAll(): Promise<void> {
    const agentIds = Array.from(this.workspaces.keys());
    await Promise.all(
      agentIds.map((id) =>
        this.cleanup(id).catch((err) =>
          this.logger.error({ agentId: id, error: err }, 'Failed to cleanup workspace')
        )
      )
    );
  }

  getWorkspace(agentId: string): WorkspaceConfig | undefined {
    return this.workspaces.get(agentId);
  }

  private async copyWorkingTree(source: string, target: string): Promise<void> {
    // Use rsync for efficient copying with exclusions
    const excludes = [
      '.git/',
      'node_modules/',
      'dist/',
      '.turbo/',
      'coverage/',
      '.next/',
      '*.log',
      '.DS_Store',
      '/tmp/',
      '.env.local',
    ];

    const excludeArgs = excludes.map((e) => `--exclude='${e}'`).join(' ');
    const cmd = `rsync -a ${excludeArgs} ${source}/ ${target}/`;

    try {
      await execAsync(cmd);
    } catch (error) {
      // Fallback to manual copy if rsync fails
      this.logger.warn({ error }, 'rsync failed, using fallback copy');
      await this.fallbackCopy(source, target, excludes);
    }
  }

  private async fallbackCopy(
    source: string,
    target: string,
    excludes: string[]
  ): Promise<void> {
    const entries = await fs.readdir(source, { withFileTypes: true });

    for (const entry of entries) {
      const sourcePath = join(source, entry.name);
      const targetPath = join(target, entry.name);

      // Check exclusions
      const shouldExclude = excludes.some((pattern) => {
        if (pattern.endsWith('/')) {
          return entry.isDirectory() && entry.name === pattern.slice(0, -1);
        }
        if (pattern.startsWith('*')) {
          return entry.name.endsWith(pattern.slice(1));
        }
        return entry.name === pattern;
      });

      if (shouldExclude) continue;

      if (entry.isDirectory()) {
        await fs.mkdir(targetPath, { recursive: true });
        await this.fallbackCopy(sourcePath, targetPath, excludes);
      } else if (entry.isFile()) {
        await fs.copyFile(sourcePath, targetPath);
      }
    }
  }
}
