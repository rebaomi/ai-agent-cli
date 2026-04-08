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

  constructor(config: SandboxConfig = { enabled: true }) {
    this.enabled = config.enabled ?? true;
    this.allowedPaths = config.allowedPaths ?? [];
    this.deniedPaths = config.deniedPaths ?? ['/etc', '/sys', '/root', '/proc', 'C:\\Windows', 'C:\\Program Files'];
    this.timeout = config.timeout ?? 30000;
    this.maxMemory = config.maxMemory;
    this.tempDir = path.join(os.tmpdir(), 'ai-agent-sandbox');
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
      return true;
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
    options: { cwd?: string; env?: Record<string, string> } = {}
  ): Promise<ExecuteResult> {
    const startTime = Date.now();
    const cwd = options.cwd ?? process.cwd();

    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...options.env },
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.timeout);

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timer);
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
        clearTimeout(timer);
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
    return this.execute('bash', ['-c', script], { cwd: this.allowedPaths[0] });
  }

  async executePowerShell(script: string): Promise<ExecuteResult> {
    return this.execute('powershell', ['-Command', script]);
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
    if (!this.allowedPaths.includes(allowedPath)) {
      this.allowedPaths.push(allowedPath);
    }
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
