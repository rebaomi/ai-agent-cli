import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { z } from 'zod';
import chalk from 'chalk';

export interface Skill {
  name: string;
  version: string;
  description: string;
  author?: string;
  main: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  skillContent?: string;
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
    await this.discoverSkills();
  }

  private async discoverSkills(): Promise<void> {
    const searchPaths: string[] = [];

    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    if (homeDir) {
      searchPaths.push(
        join(homeDir, '.config', 'ai-agent-cli', 'skills'),
        join(homeDir, '.opencode', 'skills'),
        join(homeDir, '.claude', 'skills'),
        join(homeDir, '.agents', 'skills')
      );
    }

    try {
      let currentDir = process.cwd();
      const rootDir = await this.findGitRoot(currentDir);
      
      while (currentDir && currentDir !== rootDir) {
        searchPaths.push(
          join(currentDir, '.ai-agent-cli', 'skills'),
          join(currentDir, '.opencode', 'skills'),
          join(currentDir, '.claude', 'skills'),
          join(currentDir, '.agents', 'skills')
        );
        const parent = join(currentDir, '..');
        if (parent === currentDir) break;
        currentDir = parent;
      }
    } catch {}

    const discovered = new Set<string>();
    
    for (const path of searchPaths) {
      try {
        const entries = await fs.readdir(path, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && !discovered.has(entry.name)) {
            if (!this.isValidSkillName(entry.name)) {
              console.log(chalk.gray(`[Skill] Invalid name skipped: ${entry.name}`));
              continue;
            }
            discovered.add(entry.name);
            try {
              await this.loadSkill(entry.name, join(path, entry.name));
              console.log(chalk.cyan(`[Skill] Loaded: ${entry.name}`));
            } catch (e) {
              console.log(chalk.gray(`[Skill] Skipped: ${entry.name}`));
            }
          }
        }
      } catch {}
    }
  }

  private isValidSkillName(name: string): boolean {
    if (name.length < 1 || name.length > 64) return false;
    if (name.startsWith('-') || name.endsWith('-')) return false;
    if (name.includes('--')) return false;
    return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name);
  }

  private async findGitRoot(dir: string): Promise<string> {
    try {
      const { execSync } = await import('child_process');
      const root = execSync('git rev-parse --show-toplevel', { 
        cwd: dir, 
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore']
      });
      return root.trim();
    } catch {
      return dir;
    }
  }

  async installSkill(source: string): Promise<void> {
    const skillName = this.extractSkillName(source);
    const skillPath = join(this.skillsDir, skillName);

    await fs.mkdir(skillPath, { recursive: true });

    if (source.startsWith('npm:')) {
      await this.installFromNpm(source.slice(4), skillPath);
    } else if (source.startsWith('github:')) {
      await this.installFromGitHub(source.slice(7), skillPath);
    } else if (source.startsWith('https://github.com/')) {
      await this.installFromGitHub(source.replace('https://github.com/', ''), skillPath);
    } else if (source.startsWith('https://')) {
      await this.installFromGit(source, skillPath);
    } else if (source.startsWith('./') || source.startsWith('/') || /^[a-zA-Z]:/.test(source)) {
      await this.installFromLocal(source, skillPath);
    } else {
      await this.installFromNpm(source, skillPath);
    }

    await this.loadSkill(skillName);
  }

  private async installFromGitHub(repoPath: string, targetPath: string): Promise<void> {
    const { execSync } = await import('child_process');
    
    let owner: string, repo: string, subPath: string;
    
    if (repoPath.includes('/tree/')) {
      const parts = repoPath.split('/');
      const treeIndex = parts.indexOf('tree');
      owner = parts[0] || '';
      repo = parts[1] || '';
      subPath = parts.slice(treeIndex + 2).join('/') || '';
    } else {
      const [o, r, ...rest] = repoPath.split('/');
      owner = o || '';
      repo = r || '';
      subPath = rest.join('/') || '';
    }
    
    const repoUrl = `https://github.com/${owner}/${repo}.git`;
    const tempPath = join(this.skillsDir, '_temp_install');
    
    try {
      execSync(`git clone --depth 1 ${repoUrl} "${tempPath}"`, { stdio: 'pipe' });
      
      if (subPath) {
        const srcPath = join(tempPath, subPath);
        await this.copyDirectory(srcPath, targetPath);
      } else {
        await this.copyDirectory(tempPath, targetPath);
      }
    } finally {
      await fs.rm(tempPath, { recursive: true, force: true });
    }
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
    
    if (source.includes('github.com')) {
      const match = source.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (match && match[2]) {
        return match[2];
      }
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

  async loadSkill(name: string, customPath?: string): Promise<void> {
    const skillPath = customPath || join(this.skillsDir, name);
    
    let manifest: any = null;
    let mainPath: string | undefined;
    
    const manifestFiles = ['skill.json', 'SKILL.md', 'package.json'];
    
    for (const mf of manifestFiles) {
      const manifestPath = join(skillPath, mf);
      try {
        const content = await fs.readFile(manifestPath, 'utf-8');
        
        if (mf === 'skill.json') {
          manifest = JSON.parse(content);
          mainPath = manifest.main || 'index.js';
          break;
        } else if (mf === 'SKILL.md') {
          const frontmatter = this.parseFrontmatter(content);
          manifest = {
            name: frontmatter.name || name,
            version: frontmatter.version || '1.0.0',
            description: frontmatter.description || '',
            ...frontmatter,
          };
          mainPath = 'index.js';
          break;
        } else if (mf === 'package.json') {
          manifest = JSON.parse(content);
          mainPath = manifest.main || 'index.js';
          break;
        }
      } catch {
        continue;
      }
    }
    
    if (!manifest) {
      manifest = { name, version: '1.0.0', description: `Skill: ${name}` };
      mainPath = 'index.js';
    }
    
    if (!manifest.name) manifest.name = name;
    if (!manifest.version) manifest.version = '1.0.0';
    if (!manifest.description) manifest.description = '';
    
    if (manifest.description.length < 1 || manifest.description.length > 1024) {
      throw new Error(`Invalid description length: ${manifest.description.length}`);
    }
    
    let skillContent = '';
    try {
      const skillMdPath = join(skillPath, 'SKILL.md');
      await fs.access(skillMdPath);
      skillContent = await fs.readFile(skillMdPath, 'utf-8');
      skillContent = skillContent.replace(/^---[\s\S]*?---\n/, '');
    } catch {}
    
    const skill: Skill = {
      name: manifest.name || name,
      version: manifest.version || '1.0.0',
      description: manifest.description || '',
      main: mainPath || 'index.js',
      license: manifest.license || undefined,
      compatibility: manifest.compatibility || undefined,
      metadata: manifest.metadata || undefined,
      skillContent: skillContent || undefined,
      hooks: {},
    };
    
    const entryFiles = ['index.js', 'index.ts', 'main.js', 'main.ts', 'skill.js', 'skill.ts'];
    let loadedEntry = false;
    
    for (const ef of entryFiles) {
      const entryPath = join(skillPath, ef);
      try {
        await fs.access(entryPath);
        const module = await import(pathToFileURL(entryPath).href);
        if (typeof module.default === 'function') {
          const instance = await module.default();
          skill.commands = instance.commands || [];
          skill.tools = instance.tools || [];
          skill.hooks = instance.hooks || {};
        }
        loadedEntry = true;
        break;
      } catch {
        continue;
      }
    }
    
    if (!loadedEntry) {
      console.log(chalk.gray(`[Skill] ${name}: no entry file, using SKILL.md content`));
    }
    
    this.skills.set(name, skill);
    this.enabledSkills.add(name);
  }
  
  private parseFrontmatter(content: string): Record<string, any> {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch || !fmMatch[1]) return {};
    
    const fm: Record<string, any> = {};
    const lines = fmMatch[1].split('\n');
    let currentKey = '';
    let currentValue: string[] = [];
    
    for (const line of lines) {
      if (line.match(/^\s+/) && currentKey) {
        currentValue.push(line.trim());
      } else {
        if (currentKey) {
          fm[currentKey] = currentValue.join(' ').replace(/^["']|["']$/g, '');
        }
        const keyMatch = line.match(/^(\w+):\s*(.*)$/);
        if (keyMatch && keyMatch[1]) {
          currentKey = keyMatch[1];
          const val = keyMatch[2]?.trim() || '';
          if (val) {
            currentValue = [val];
          } else {
            currentValue = [];
          }
        }
      }
    }
    if (currentKey) {
      fm[currentKey] = currentValue.join(' ').replace(/^["']|["']$/g, '');
    }
    
    return fm;
  }

  async listSkills(): Promise<Array<{ name: string; version: string; description: string; enabled: boolean }>> {
    const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
    const skills: Array<{ name: string; version: string; description: string; enabled: boolean }> = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const skillPath = join(this.skillsDir, entry.name);
        let manifest: any = null;
        
        const manifestFiles = ['skill.json', 'SKILL.md', 'package.json'];
        for (const mf of manifestFiles) {
          const manifestPath = join(skillPath, mf);
          try {
            const content = await fs.readFile(manifestPath, 'utf-8');
            if (mf === 'skill.json' || mf === 'package.json') {
              manifest = JSON.parse(content);
            } else if (mf === 'SKILL.md') {
              const fm = this.parseFrontmatter(content);
              manifest = { name: fm.name, version: fm.version, description: fm.description };
            }
            break;
          } catch {
            continue;
          }
        }
        
        if (manifest) {
          skills.push({
            name: manifest.name || entry.name,
            version: manifest.version || '1.0.0',
            description: manifest.description || '',
            enabled: this.enabledSkills.has(entry.name),
          });
        } else {
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

  getSkillDescriptions(): Array<{ name: string; description: string }> {
    return Array.from(this.skills.values())
      .filter(s => this.enabledSkills.has(s.name))
      .map(s => ({ name: s.name, description: s.description }));
  }

  getSkillContent(name: string): string | undefined {
    const skill = this.getEnabledSkills().find(s => s.name === name);
    return skill?.skillContent;
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

  getSkillsDir(): string {
    return this.skillsDir;
  }
}

export function createSkillManager(skillsDir?: string): SkillManager {
  const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();
  const defaultDir = join(homeDir, '.ai-agent-cli', 'skills');
  return new SkillManager(skillsDir || defaultDir);
}
