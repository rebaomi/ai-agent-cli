import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';

export interface Skill {
  name: string;
  version: string;
  description: string;
  author?: string;
  main: string;
  commands?: SkillCommand[];
  tools?: SkillTool[];
  hooks?: SkillHooks;
}

export interface SkillCommand {
  name: string;
  description: string;
  handler?: (args: string[], ctx: SkillContext) => Promise<string>;
}

export interface SkillTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler?: (args: Record<string, unknown>, ctx: SkillContext) => Promise<SkillToolResult>;
}

export interface SkillToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface SkillHooks {
  onStart?: (ctx: SkillContext) => Promise<void>;
  onMessage?: (message: string, ctx: SkillContext) => Promise<string | null>;
  onToolCall?: (name: string, args: Record<string, unknown>, ctx: SkillContext) => Promise<SkillToolResult | null>;
  onShutdown?: (ctx: SkillContext) => Promise<void>;
}

export interface SkillContext {
  workspace: string;
  config: Record<string, unknown>;
  skillsDir: string;
}

const skillManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  author: z.string().optional(),
  main: z.string(),
  commands: z.array(z.object({
    name: z.string(),
    description: z.string(),
  })).optional(),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.record(z.unknown()),
  })).optional(),
});

export class SkillManager {
  private skills: Map<string, Skill> = new Map();
  private skillsDir: string;
  private enabledSkills: Set<string> = new Set();

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.skillsDir, { recursive: true });
  }

  async installSkill(source: string): Promise<void> {
    const skillName = this.extractSkillName(source);
    const skillPath = join(this.skillsDir, skillName);

    await fs.mkdir(skillPath, { recursive: true });

    if (source.startsWith('npm:')) {
      await this.installFromNpm(source.slice(4), skillPath);
    } else if (source.startsWith('github:') || source.startsWith('https://')) {
      await this.installFromGit(source, skillPath);
    } else if (source.startsWith('./') || source.startsWith('/') || /^[a-zA-Z]:/.test(source)) {
      await this.installFromLocal(source, skillPath);
    } else {
      await this.installFromNpm(source, skillPath);
    }

    await this.loadSkill(skillName);
  }

  private async installFromNpm(packageName: string, targetPath: string): Promise<void> {
    const { execSync } = await import('child_process');
    try {
      execSync(`npm pack ${packageName}`, { cwd: targetPath, stdio: 'pipe' });
      const { execSync: exec2 } = await import('child_process');
      const tarball = exec2(`npm pack ${packageName} --json`, { cwd: targetPath, encoding: 'utf-8' });
      const info = JSON.parse(tarball);
      if (info[0]?.filename) {
        execSync(`tar -xzf ${info[0].filename}`, { cwd: targetPath });
      }
    } catch (error) {
      throw new Error(`Failed to install from npm: ${error}`);
    }
  }

  private async installFromGit(url: string, targetPath: string): Promise<void> {
    const { execSync } = await import('child_process');
    try {
      execSync(`git clone ${url} "${targetPath}"`, { stdio: 'pipe' });
    } catch (error) {
      throw new Error(`Failed to clone from git: ${error}`);
    }
  }

  private async installFromLocal(source: string, targetPath: string): Promise<void> {
    const srcPath = resolve(source);
    await this.copyDirectory(srcPath, targetPath);
  }

  private async copyDirectory(src: string, dest: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  private extractSkillName(source: string): string {
    if (source.startsWith('npm:')) {
      const name = source.slice(4).split('@')[0] || '';
      const parts = name.split('/');
      return parts.pop() || 'unknown';
    }
    const match = source.match(/([^/]+?)(?:\.git)?$/);
    return match?.[1] || 'unknown';
  }

  async uninstallSkill(name: string): Promise<void> {
    const skillPath = join(this.skillsDir, name);
    await fs.rm(skillPath, { recursive: true, force: true });
    this.skills.delete(name);
    this.enabledSkills.delete(name);
  }

  async loadSkill(name: string): Promise<void> {
    const skillPath = join(this.skillsDir, name);
    const manifestPath = join(skillPath, 'skill.json');

    let manifest: z.infer<typeof skillManifestSchema>;
    try {
      const content = await fs.readFile(manifestPath, 'utf-8');
      manifest = skillManifestSchema.parse(JSON.parse(content));
    } catch (error) {
      throw new Error(`Invalid skill manifest: ${error}`);
    }

    const skill: Skill = {
      ...manifest,
      main: manifest.main,
      hooks: {},
    };

    try {
      const mainPath = join(skillPath, manifest.main);
      const module = await import(mainPath);
      if (typeof module.default === 'function') {
        const instance = await module.default();
        skill.commands = instance.commands;
        skill.tools = instance.tools;
        skill.hooks = instance.hooks;
      }
    } catch (error) {
      console.warn(`Failed to load skill ${name}: ${error}`);
    }

    this.skills.set(name, skill);
    this.enabledSkills.add(name);
  }

  async listSkills(): Promise<Array<{ name: string; version: string; description: string; enabled: boolean }>> {
    const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
    const skills: Array<{ name: string; version: string; description: string; enabled: boolean }> = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const manifestPath = join(this.skillsDir, entry.name, 'skill.json');
        try {
          const content = await fs.readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(content);
          skills.push({
            name: manifest.name || entry.name,
            version: manifest.version || '1.0.0',
            description: manifest.description || '',
            enabled: this.enabledSkills.has(entry.name),
          });
        } catch {
          skills.push({ name: entry.name, version: 'unknown', description: '', enabled: false });
        }
      }
    }

    return skills;
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  getAllSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  getEnabledSkills(): Skill[] {
    return Array.from(this.skills.values()).filter(s => this.enabledSkills.has(s.name));
  }

  getCommands(): Array<{ skill: string; name: string; description: string }> {
    const commands: Array<{ skill: string; name: string; description: string }> = [];
    for (const skill of this.getEnabledSkills()) {
      for (const cmd of skill.commands || []) {
        commands.push({ skill: skill.name, name: cmd.name, description: cmd.description });
      }
    }
    return commands;
  }

  getTools(): Array<{ skill: string; name: string; description: string; inputSchema: Record<string, unknown> }> {
    const tools: Array<{ skill: string; name: string; description: string; inputSchema: Record<string, unknown> }> = [];
    for (const skill of this.getEnabledSkills()) {
      for (const tool of skill.tools || []) {
        tools.push({ skill: skill.name, name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
      }
    }
    return tools;
  }

  async executeCommand(name: string, args: string[], ctx: SkillContext): Promise<string> {
    const skill = this.getEnabledSkills().find(s => s.commands?.some(c => c.name === name));
    if (!skill) throw new Error(`Command not found: ${name}`);
    
    const cmd = skill.commands?.find(c => c.name === name);
    if (!cmd) throw new Error(`Command not found: ${name}`);
    
    if (cmd.handler) {
      return cmd.handler(args, ctx);
    }
    throw new Error(`Command handler not implemented: ${name}`);
  }

  async executeTool(name: string, args: Record<string, unknown>, ctx: SkillContext): Promise<SkillToolResult> {
    const skill = this.getEnabledSkills().find(s => s.tools?.some(t => t.name === name));
    if (!skill) throw new Error(`Tool not found: ${name}`);
    
    const tool = skill.tools?.find(t => t.name === name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    
    if (tool.handler) {
      return tool.handler(args, ctx);
    }
    throw new Error(`Tool handler not implemented: ${name}`);
  }

  async runHook(hookName: keyof NonNullable<Skill['hooks']>, ctx: SkillContext, ...args: unknown[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const skill of this.getEnabledSkills()) {
      const hook = skill.hooks?.[hookName];
      if (hook) {
        try {
          const result = await (hook as (ctx: SkillContext, ...args: unknown[]) => Promise<unknown>)(ctx, ...args);
          if (result !== null && result !== undefined) {
            results.push(result);
          }
        } catch (error) {
          console.warn(`Hook ${hookName} failed for ${skill.name}: ${error}`);
        }
      }
    }
    return results;
  }

  enableSkill(name: string): void {
    this.enabledSkills.add(name);
  }

  disableSkill(name: string): void {
    this.enabledSkills.delete(name);
  }
}

export function createSkillManager(skillsDir?: string): SkillManager {
  const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();
  const defaultDir = join(homeDir, '.ai-agent-cli', 'skills');
  return new SkillManager(skillsDir || defaultDir);
}
