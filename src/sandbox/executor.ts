import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SandboxConfig, ExecuteResult } from '../types/index.js';

export class Sandbox {
  private enabled: boolean;
  private allowedPaths: string[];
  private deniedPaths: string[];
  private timeout: number;
  private maxMemory?: number;
  private tempDir: string;
  private allowCommandExecution: boolean;
  private allowBash: boolean;
  private allowPowerShell: boolean;

  constructor(config: SandboxConfig = { enabled: true }) {
    this.enabled = config.enabled ?? true;
    this.tempDir = path.join(os.tmpdir(), 'ai-agent-sandbox');
    this.allowedPaths = this.buildAllowedPaths(config.allowedPaths);
    this.deniedPaths = config.deniedPaths ?? ['/etc', '/sys', '/root', '/proc', 'C:\\Windows', 'C:\\Program Files'];
    this.timeout = config.timeout ?? 30000;
    this.maxMemory = config.maxMemory;
    this.allowCommandExecution = config.allowCommandExecution ?? true;
    this.allowBash = config.allowBash ?? (process.platform !== 'win32');
    this.allowPowerShell = config.allowPowerShell ?? (process.platform === 'win32');
  }

  async initialize(): Promise<void> {
    if (this.enabled) {
      await fs.mkdir(this.tempDir, { recursive: true });
    }
  }

  private normalizeComparisonPath(targetPath: string): string {
    const resolved = path.resolve(targetPath);
    const normalized = path.normalize(resolved);
    const root = path.parse(normalized).root;
    const trimmed = normalized === root ? normalized : normalized.replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
  }

  private isWithinPath(targetPath: string, basePath: string): boolean {
    const normalizedTarget = this.normalizeComparisonPath(targetPath);
    const normalizedBase = this.normalizeComparisonPath(basePath);

    if (normalizedTarget === normalizedBase) {
      return true;
    }

    const relative = path.relative(normalizedBase, normalizedTarget);
    if (!relative) {
      return true;
    }

    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  private isPathAllowed(filePath: string): boolean {
    for (const denied of this.deniedPaths) {
      if (this.isWithinPath(filePath, denied)) {
        return false;
      }
    }

    if (this.allowedPaths.length === 0) {
      return false;
    }

    for (const allowed of this.allowedPaths) {
      if (this.isWithinPath(filePath, allowed)) {
        return true;
      }
    }

    return false;
  }

  async readFile(filePath: string): Promise<string> {
    if (!this.enabled) {
      return fs.readFile(filePath, 'utf-8');
    }

    if (!this.isPathAllowed(filePath)) {
      const resolved = this.normalizeComparisonPath(filePath);
      const allowedList = this.allowedPaths.map(p => this.normalizeComparisonPath(p));
      throw new Error(`Path not allowed: ${filePath}\nResolved: ${resolved}\nAllowed: ${allowedList.join(', ')}`);
    }

    return fs.readFile(filePath, 'utf-8');
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    if (!this.enabled) {
      await fs.writeFile(filePath, content, 'utf-8');
      return;
    }

    if (!this.isPathAllowed(filePath)) {
      const resolved = this.normalizeComparisonPath(filePath);
      const allowedList = this.allowedPaths.map(p => this.normalizeComparisonPath(p));
      throw new Error(`Path not allowed: ${filePath}\nResolved: ${resolved}\nAllowed: ${allowedList.join(', ')}`);
    }

    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }

  async deleteFile(filePath: string): Promise<void> {
    if (!this.enabled) {
      await fs.unlink(filePath);
      return;
    }

    if (!this.isPathAllowed(filePath)) {
      const resolved = this.normalizeComparisonPath(filePath);
      const allowedList = this.allowedPaths.map(p => this.normalizeComparisonPath(p));
      throw new Error(`Path not allowed: ${filePath}\nResolved: ${resolved}\nAllowed: ${allowedList.join(', ')}`);
    }

    await fs.unlink(filePath);
  }

  async listDirectory(dirPath: string): Promise<string[]> {
    if (!this.enabled) {
      return fs.readdir(dirPath);
    }

    if (!this.isPathAllowed(dirPath)) {
      const resolved = this.normalizeComparisonPath(dirPath);
      const allowedList = this.allowedPaths.map(p => this.normalizeComparisonPath(p));
      throw new Error(`Path not allowed: ${dirPath}\nResolved: ${resolved}\nAllowed: ${allowedList.join(', ')}`);
    }

    return fs.readdir(dirPath);
  }

  async execute(
    command: string,
    args: string[] = [],
    options: { cwd?: string; env?: Record<string, string>; timeout?: number } = {}
  ): Promise<ExecuteResult> {
    if (this.enabled && !this.allowCommandExecution) {
      throw new Error('Command execution is disabled by sandbox policy');
    }

    const startTime = Date.now();
    const cwd = options.cwd ?? process.cwd();
    const timeoutMs = options.timeout === undefined ? this.timeout : options.timeout;

    if (this.enabled && !this.isPathAllowed(cwd)) {
      const resolved = this.normalizeComparisonPath(cwd);
      const allowedList = this.allowedPaths.map(p => this.normalizeComparisonPath(p));
      throw new Error(`Command cwd not allowed: ${cwd}\nResolved: ${resolved}\nAllowed: ${allowedList.join(', ')}`);
    }

    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...options.env },
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = timeoutMs > 0 ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs) : null;

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({
          command,
          args,
          stdout,
          stderr,
          exitCode: code ?? 0,
          timedOut,
          duration: Date.now() - startTime,
        });
      });

      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        resolve({
          command,
          args,
          stdout,
          stderr: error.message,
          exitCode: 1,
          duration: Date.now() - startTime,
        });
      });
    });
  }

  async executeNode(script: string, args: string[] = []): Promise<ExecuteResult> {
    const tempFile = path.join(this.tempDir, `script-${Date.now()}.js`);
    await this.writeFile(tempFile, script);
    const result = await this.execute('node', [tempFile, ...args]);
    await this.deleteFile(tempFile).catch(() => {});
    return result;
  }

  async executeBash(script: string): Promise<ExecuteResult> {
    if (this.enabled && !this.allowBash) {
      throw new Error('Bash execution is disabled by sandbox policy');
    }

    return this.execute('bash', ['-c', script], { cwd: this.getPreferredExecutionCwd() });
  }

  async executePowerShell(script: string): Promise<ExecuteResult> {
    if (this.enabled && !this.allowPowerShell) {
      throw new Error('PowerShell execution is disabled by sandbox policy');
    }

    return this.execute('powershell', ['-Command', script], { cwd: this.getPreferredExecutionCwd() });
  }

  async executePython(script: string): Promise<ExecuteResult> {
    const tempFile = path.join(this.tempDir, `script-${Date.now()}.py`);
    await this.writeFile(tempFile, script);
    const result = await this.execute('python', [tempFile]);
    await this.deleteFile(tempFile).catch(() => {});
    return result;
  }

  getTempDir(): string {
    return this.tempDir;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  addAllowedPath(allowedPath: string): void {
    const normalized = path.resolve(allowedPath);
    if (!this.allowedPaths.includes(normalized)) {
      this.allowedPaths.push(normalized);
    }
  }

  getAllowedPaths(): string[] {
    return [...this.allowedPaths];
  }

  async cleanup(): Promise<void> {
    try {
      const files = await fs.readdir(this.tempDir);
      await Promise.all(files.map(f => fs.unlink(path.join(this.tempDir, f))));
      await fs.rmdir(this.tempDir);
    } catch {
      // Ignore cleanup errors
    }
  }

  private buildAllowedPaths(configuredAllowedPaths?: string[]): string[] {
    const defaults = configuredAllowedPaths && configuredAllowedPaths.length > 0
      ? configuredAllowedPaths
      : [process.cwd()];
    const unique = new Set<string>();
    for (const allowedPath of [...defaults, this.tempDir]) {
      unique.add(path.resolve(allowedPath));
    }
    return Array.from(unique);
  }

  private getPreferredExecutionCwd(): string {
    for (const candidate of this.allowedPaths) {
      if (candidate !== this.tempDir) {
        return candidate;
      }
    }

    return this.tempDir;
  }
}

export class ToolRegistry {
  private tools: Map<string, (args: unknown) => Promise<unknown>> = new Map();

  register(name: string, handler: (args: unknown) => Promise<unknown>): void {
    this.tools.set(name, handler);
  }

  async execute(name: string, args: unknown): Promise<unknown> {
    const handler = this.tools.get(name);
    if (!handler) {
      throw new Error(`Tool not found: ${name}`);
    }
    return handler(args);
  }

  getTools(): string[] {
    return Array.from(this.tools.keys());
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }
}

export function createSandbox(config?: SandboxConfig): Sandbox {
  return new Sandbox(config);
}

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}
