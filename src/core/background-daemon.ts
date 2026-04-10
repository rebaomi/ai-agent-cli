import { closeSync, existsSync, openSync, promises as fs, statSync } from 'fs';
import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

export interface BackgroundDaemonState {
  pid: number;
  startedAt: number;
  logFile: string;
  configPath?: string;
  workspace?: string;
  cronSchedulerRunning?: boolean;
  mcpServers?: BackgroundServiceConnection[];
  lspServers?: BackgroundServiceConnection[];
}

export interface BackgroundDaemonStatus extends BackgroundDaemonState {
  running: boolean;
}

export interface BackgroundServiceConnection {
  name: string;
  status: 'connected' | 'failed';
  detail?: string;
}

export class BackgroundDaemonManager {
  private readonly appBaseDir: string;

  constructor(appBaseDir?: string) {
    this.appBaseDir = appBaseDir || path.join(os.homedir(), '.ai-agent-cli');
  }

  async getStatus(): Promise<BackgroundDaemonStatus> {
    const state = await this.readState();
    const logFile = state?.logFile || this.getLogFilePath();
    if (!state) {
      return {
        running: false,
        pid: 0,
        startedAt: 0,
        logFile,
      };
    }

    if (!(await this.isProcessRunning(state.pid))) {
      await this.clearState();
      return {
        running: false,
        pid: 0,
        startedAt: 0,
        logFile,
      };
    }

    return {
      ...state,
      running: true,
    };
  }

  async ensureRunning(options: { configPath?: string; workspace?: string } = {}): Promise<BackgroundDaemonStatus> {
    const current = await this.getStatus();
    if (current.running) {
      const requestedConfigPath = options.configPath?.trim() || undefined;
      const requestedWorkspace = options.workspace?.trim() || undefined;
      if (current.configPath === requestedConfigPath && current.workspace === requestedWorkspace) {
        return current;
      }

      await this.stop();
    }

    await this.spawnDaemon(options);
    return this.waitUntilRunning();
  }

  async stop(): Promise<boolean> {
    const current = await this.getStatus();
    if (!current.running || current.pid <= 0) {
      await this.clearState();
      return false;
    }

    try {
      process.kill(current.pid, 'SIGTERM');
    } catch {
      await this.clearState();
      return false;
    }

    const gracefulExit = await this.waitForExit(current.pid, 4000);
    if (!gracefulExit) {
      try {
        process.kill(current.pid, 'SIGKILL');
      } catch {
      }
      await this.waitForExit(current.pid, 1500);
    }

    await this.clearState();
    return true;
  }

  async registerCurrentProcess(options: {
    pid: number;
    configPath?: string;
    workspace?: string;
    cronSchedulerRunning?: boolean;
    mcpServers?: BackgroundServiceConnection[];
    lspServers?: BackgroundServiceConnection[];
  }): Promise<void> {
    const runtimeDir = this.getRuntimeDir();
    await fs.mkdir(runtimeDir, { recursive: true });
    await fs.writeFile(this.getStateFilePath(), JSON.stringify({
      pid: options.pid,
      startedAt: Date.now(),
      logFile: this.getLogFilePath(),
      configPath: options.configPath?.trim() || undefined,
      workspace: options.workspace?.trim() || undefined,
      cronSchedulerRunning: options.cronSchedulerRunning ?? false,
      mcpServers: Array.isArray(options.mcpServers) ? options.mcpServers : [],
      lspServers: Array.isArray(options.lspServers) ? options.lspServers : [],
    }, null, 2), 'utf-8');
  }

  async clearState(): Promise<void> {
    try {
      await fs.rm(this.getStateFilePath(), { force: true });
    } catch {
    }
  }

  getLogFilePath(): string {
    return path.join(this.getRuntimeDir(), 'daemon.log');
  }

  private getRuntimeDir(): string {
    return path.join(this.appBaseDir, 'runtime');
  }

  private getStateFilePath(): string {
    return path.join(this.getRuntimeDir(), 'daemon.json');
  }

  private async readState(): Promise<BackgroundDaemonState | null> {
    try {
      const raw = await fs.readFile(this.getStateFilePath(), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<BackgroundDaemonState>;
      if (!parsed || typeof parsed.pid !== 'number' || parsed.pid <= 0) {
        return null;
      }

      return {
        pid: parsed.pid,
        startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
        logFile: typeof parsed.logFile === 'string' && parsed.logFile.trim() ? parsed.logFile : this.getLogFilePath(),
        configPath: typeof parsed.configPath === 'string' && parsed.configPath.trim() ? parsed.configPath.trim() : undefined,
        workspace: typeof parsed.workspace === 'string' && parsed.workspace.trim() ? parsed.workspace.trim() : undefined,
        cronSchedulerRunning: parsed.cronSchedulerRunning === true
          ? true
          : parsed.cronSchedulerRunning === false
            ? false
            : undefined,
        mcpServers: this.parseConnectionList(parsed.mcpServers),
        lspServers: this.parseConnectionList(parsed.lspServers),
      };
    } catch {
      return null;
    }
  }

  private parseConnectionList(value: unknown): BackgroundServiceConnection[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const connections: BackgroundServiceConnection[] = [];

    for (const item of value) {
      if (!item || typeof item !== 'object') {
        continue;
      }

      const record = item as Record<string, unknown>;
      const name = typeof record.name === 'string' ? record.name.trim() : '';
      const status = record.status === 'failed' ? 'failed' : record.status === 'connected' ? 'connected' : null;
      if (!name || !status) {
        continue;
      }

      connections.push({
        name,
        status,
        detail: typeof record.detail === 'string' && record.detail.trim() ? record.detail.trim() : undefined,
      });
    }

    return connections;
  }

  private async spawnDaemon(options: { configPath?: string; workspace?: string }): Promise<void> {
    const entry = this.resolveCliEntryScript();
    const logFile = this.getLogFilePath();
    await fs.mkdir(this.getRuntimeDir(), { recursive: true });
    const outputFd = openSync(logFile, 'a');
    const nodeExecutable = this.resolveNodeExecutable();
    const spawnCwd = await this.resolveSpawnCwd(options.workspace);
    const daemonArgs = entry.isTypeScript
      ? ['--import', 'tsx', entry.scriptPath, '--daemon-service']
      : [entry.scriptPath, '--daemon-service'];

    if (options.configPath?.trim()) {
      daemonArgs.push('--config', options.configPath.trim());
    }

    if (options.workspace?.trim()) {
      daemonArgs.push('--workspace', options.workspace.trim());
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(nodeExecutable, daemonArgs, {
        cwd: spawnCwd,
        detached: true,
        stdio: ['ignore', outputFd, outputFd],
        env: {
          ...process.env,
          AI_AGENT_CLI_DAEMON: '1',
        },
        windowsHide: true,
      });

      child.once('error', (error) => {
        try {
          closeSync(outputFd);
        } catch {
        }
        reject(new Error(`启动后台 daemon 失败: ${error instanceof Error ? error.message : String(error)}`));
      });

      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }

  private async waitUntilRunning(timeoutMs = 15000): Promise<BackgroundDaemonStatus> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.getStatus();
      if (status.running) {
        return status;
      }
      await delay(200);
    }

    throw new Error('后台 daemon 启动超时');
  }

  private async waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.isProcessRunning(pid))) {
        return true;
      }
      await delay(150);
    }
    return !(await this.isProcessRunning(pid));
  }

  private async isProcessRunning(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private resolveCliEntryScript(): { scriptPath: string; isTypeScript: boolean } {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const distCliPath = path.resolve(moduleDir, '..', 'cli', 'index.js');
    const srcCliPath = path.resolve(moduleDir, '..', 'cli', 'index.ts');

    if (existsSync(distCliPath) && existsSync(srcCliPath)) {
      const distStat = statSync(distCliPath);
      const srcStat = statSync(srcCliPath);
      if (srcStat.mtimeMs > distStat.mtimeMs) {
        return { scriptPath: srcCliPath, isTypeScript: true };
      }
      return { scriptPath: distCliPath, isTypeScript: false };
    }

    if (existsSync(distCliPath)) {
      return { scriptPath: distCliPath, isTypeScript: false };
    }

    if (existsSync(srcCliPath)) {
      return { scriptPath: srcCliPath, isTypeScript: true };
    }

    throw new Error('找不到 CLI 入口，无法启动后台 daemon');
  }

  private resolveNodeExecutable(): string {
    const candidates = [
      process.execPath,
      process.argv[0],
      process.env.npm_node_execpath,
      process.env.NODE,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return process.platform === 'win32' ? 'node.exe' : 'node';
  }

  private async resolveSpawnCwd(workspace?: string): Promise<string> {
    const normalizedWorkspace = workspace?.trim();
    if (!normalizedWorkspace) {
      return process.cwd();
    }

    try {
      await fs.mkdir(normalizedWorkspace, { recursive: true });
      return normalizedWorkspace;
    } catch {
      return process.cwd();
    }
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, timeoutMs));
}