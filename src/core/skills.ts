import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { z } from 'zod';
import chalk from 'chalk';
import { resolveOutputPath } from '../utils/path-resolution.js';
import { writeDocxDocument } from '../utils/docx-export.js';
import { writePdfDocument } from '../utils/pdf-export.js';
import { writePptxDocument } from '../utils/pptx-export.js';
import { writeXlsxDocument } from '../utils/xlsx-export.js';

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

export interface SkillLearningInput {
  originalTask: string;
  stepDescriptions: string[];
  stepResults: string[];
  completedSteps: number;
  totalSteps: number;
  refinement?: SkillCandidateRefinement;
}

export interface SkillCandidateRefinement {
  shouldCreate?: boolean;
  confidence?: number;
  refinedDescription?: string;
  whenToUse?: string;
  procedure?: string[];
  verification?: string[];
  tags?: string[];
  qualitySummary?: string;
  suggestedName?: string;
}

export interface SkillCandidate {
  name: string;
  description: string;
  path: string;
  createdAt: string;
  sourceTask: string;
  confidence?: number;
  qualitySummary?: string;
  tags?: string[];
}

export interface SkillCandidateSearchResult extends SkillCandidate {
  score: number;
  whenToUse: string;
  procedureSteps: string[];
  verification: string[];
}

export interface SkillLearningTodo {
  id: string;
  createdAt: string;
  sourceTask: string;
  issueSummary: string;
  suggestedSkill: string;
  blockers: string[];
  nextActions: string[];
  tags?: string[];
  confidence?: number;
  draftedCandidateName?: string;
  draftedAt?: string;
}

export interface SkillLearningTodoSearchResult extends SkillLearningTodo {
  score: number;
}

type OfficialDocumentSkillName = 'docx' | 'pdf' | 'xlsx' | 'pptx';

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
  private candidatesDir: string;
  private learningTodoFile: string;
  private enabledSkills: Set<string> = new Set();
  private readonly manifestFiles = ['skill.json', 'SKILL.md', 'package.json'];
  private readonly legacySkillOverrides: Record<string, string> = {
    'minimax-docx': 'docx',
    'minimax-pdf': 'pdf',
    'minimax-xlsx': 'xlsx',
    'pptx-generator': 'pptx',
  };

  private get shouldLogDiscovery(): boolean {
    return process.env.AI_AGENT_CLI_QUIET_SKILL_LOGS !== '1';
  }

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
    this.candidatesDir = resolve(this.skillsDir, '..', 'skill-candidates');
    this.learningTodoFile = join(this.candidatesDir, 'learning-todos.json');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.skillsDir, { recursive: true });
    await fs.mkdir(this.candidatesDir, { recursive: true });
    await this.ensureLearningTodoStore();
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
    const candidates: Array<{ name: string; path: string }> = [];

    for (const path of searchPaths) {
      try {
        candidates.push(...await this.findSkillDirectories(path, 2));
      } catch {}
    }

    const suppressedLegacySkills = this.getSuppressedLegacySkills(candidates.map(candidate => candidate.name));

    for (const candidate of candidates) {
      if (discovered.has(candidate.name)) {
        continue;
      }

      if (suppressedLegacySkills.has(candidate.name)) {
        if (this.shouldLogDiscovery) {
          const replacement = this.legacySkillOverrides[candidate.name];
          console.log(chalk.gray(`[Skill] Suppressed legacy skill: ${candidate.name}${replacement ? ` -> ${replacement}` : ''}`));
        }
        discovered.add(candidate.name);
        continue;
      }

      discovered.add(candidate.name);
      try {
        await this.loadSkill(candidate.name, candidate.path);
        if (this.shouldLogDiscovery) {
          console.log(chalk.cyan(`[Skill] Loaded: ${candidate.name}`));
        }
      } catch {
        if (this.shouldLogDiscovery) {
          console.log(chalk.gray(`[Skill] Skipped: ${candidate.name}`));
        }
      }
    }
  }

  private getSuppressedLegacySkills(candidateNames: string[]): Set<string> {
    const available = new Set(candidateNames);
    const suppressed = new Set<string>();

    for (const [legacyName, preferredName] of Object.entries(this.legacySkillOverrides)) {
      if (available.has(legacyName) && available.has(preferredName)) {
        suppressed.add(legacyName);
      }
    }

    return suppressed;
  }

  private async findSkillDirectories(rootPath: string, maxDepth: number): Promise<Array<{ name: string; path: string }>> {
    const found: Array<{ name: string; path: string }> = [];

    const walk = async (currentPath: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(currentPath, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const traversable = await this.isTraversableDirectory(currentPath, entry);
        if (!traversable) {
          continue;
        }

        const entryPath = join(currentPath, entry.name);
        const hasManifest = await this.hasSkillManifest(entryPath);

        if (hasManifest) {
          if (!this.isValidSkillName(entry.name)) {
            if (this.shouldLogDiscovery) {
              console.log(chalk.gray(`[Skill] Invalid name skipped: ${entry.name}`));
            }
          } else {
            found.push({ name: entry.name, path: entryPath });
          }
          continue;
        }

        if (depth < maxDepth) {
          await walk(entryPath, depth + 1);
        }
      }
    };

    await walk(rootPath, 1);
    return found;
  }

  private async isTraversableDirectory(rootPath: string, entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }): Promise<boolean> {
    if (entry.isDirectory()) {
      return true;
    }

    if (!entry.isSymbolicLink()) {
      return false;
    }

    try {
      const stats = await fs.stat(join(rootPath, entry.name));
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  private async hasSkillManifest(skillPath: string): Promise<boolean> {
    for (const manifestFile of this.manifestFiles) {
      try {
        await fs.access(join(skillPath, manifestFile));
        return true;
      } catch {
        continue;
      }
    }

    return false;
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
    let skillContent = '';

    try {
      const skillMdPath = join(skillPath, 'SKILL.md');
      await fs.access(skillMdPath);
      skillContent = await fs.readFile(skillMdPath, 'utf-8');
    } catch {}
    
    for (const mf of this.manifestFiles) {
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
            description: this.normalizeSkillDescription(frontmatter.description, content, name),
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
    manifest.description = this.normalizeSkillDescription(manifest.description, skillContent, name);
    skillContent = skillContent.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    
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
      skill.tools = this.createOfficialDocumentBridgeTools(skill.name);
      if (this.shouldLogDiscovery) {
        console.log(chalk.gray(`[Skill] ${name}: no entry file, using SKILL.md content${skill.tools?.length ? ' + bridge tools' : ''}`));
      }
    }
    
    this.skills.set(name, skill);
    this.enabledSkills.add(name);
  }

  private createOfficialDocumentBridgeTools(skillName: string): SkillTool[] {
    if (!this.isOfficialDocumentSkillName(skillName)) {
      return [];
    }

    switch (skillName) {
      case 'docx':
        return [this.createDocumentExportBridgeTool('docx', 'docx_create_from_text', 'Create a DOCX file using the installed docx skill bridge')];
      case 'pdf':
        return [this.createDocumentExportBridgeTool('pdf', 'pdf_create_from_text', 'Create a PDF file using the installed pdf skill bridge')];
      case 'xlsx':
        return [this.createDocumentExportBridgeTool('xlsx', 'xlsx_create_from_text', 'Create an XLSX file using the installed xlsx skill bridge')];
      case 'pptx':
        return [this.createDocumentExportBridgeTool('pptx', 'pptx_create_from_text', 'Create a PPTX file using the installed pptx skill bridge')];
      default:
        return [];
    }
  }

  private isOfficialDocumentSkillName(value: string): value is OfficialDocumentSkillName {
    return value === 'docx' || value === 'pdf' || value === 'xlsx' || value === 'pptx';
  }

  private createDocumentExportBridgeTool(
    skillName: OfficialDocumentSkillName,
    toolName: string,
    description: string,
  ): SkillTool {
    const outputProperty = skillName === 'pdf' ? 'out' : 'output';

    return {
      name: toolName,
      description,
      inputSchema: {
        type: 'object',
        properties: {
          [outputProperty]: { type: 'string', description: `Output .${skillName} path` },
          text: { type: 'string', description: 'Plain text document body' },
          title: { type: 'string', description: 'Optional document title' },
        },
        required: [outputProperty, 'text'],
      },
      handler: async (args, ctx) => {
        const outputArg = skillName === 'pdf' ? args.out : args.output;
        if (typeof outputArg !== 'string' || !outputArg.trim()) {
          throw new Error(`Missing ${outputProperty} for ${toolName}`);
        }

        const resolvedPath = resolveOutputPath(outputArg, {
          workspace: ctx.workspace,
          artifactOutputDir: typeof ctx.config.artifactOutputDir === 'string' ? ctx.config.artifactOutputDir : undefined,
          documentOutputDir: typeof ctx.config.documentOutputDir === 'string' ? ctx.config.documentOutputDir : undefined,
        });

        const text = typeof args.text === 'string' ? args.text : '';
        const title = typeof args.title === 'string' ? args.title : undefined;

        if (skillName === 'docx') {
          await writeDocxDocument(resolvedPath, text, title);
          return { content: [{ type: 'text', text: `Created report document: ${resolvedPath}` }] };
        }

        if (skillName === 'pdf') {
          await writePdfDocument(resolvedPath, text, title);
          return { content: [{ type: 'text', text: `Created PDF document: ${resolvedPath}` }] };
        }

        if (skillName === 'xlsx') {
          await writeXlsxDocument(resolvedPath, text, title);
          return { content: [{ type: 'text', text: `Created spreadsheet document: ${resolvedPath}` }] };
        }

        await writePptxDocument(resolvedPath, text, title);
        return { content: [{ type: 'text', text: `Created presentation document: ${resolvedPath}` }] };
      },
    };
  }
  
  private parseFrontmatter(content: string): Record<string, any> {
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
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

  private normalizeSkillDescription(description: unknown, skillContent: string, name: string): string {
    const raw = typeof description === 'string' ? description.trim() : '';
    if (raw.length > 0) {
      const cleaned = this.cleanMarkdownText(raw);
      if (cleaned.length > 0) {
        return this.summarizeDescription(cleaned).slice(0, 1024);
      }
    }

    const inferred = this.extractDescriptionFromContent(skillContent);
    if (inferred.length > 0) {
      return inferred.slice(0, 1024);
    }

    return `Skill: ${name}`;
  }

  private extractDescriptionFromContent(skillContent: string): string {
    const body = skillContent.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    const lines = body.split(/\r?\n/);
    const paragraphs: string[] = [];
    let currentParagraph: string[] = [];
    let inCodeFence = false;

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();

      if (/^(```|~~~)/.test(trimmed)) {
        inCodeFence = !inCodeFence;
        continue;
      }

      if (inCodeFence) {
        continue;
      }

      if (trimmed.length === 0) {
        if (currentParagraph.length > 0) {
          paragraphs.push(currentParagraph.join(' '));
          currentParagraph = [];
        }
        continue;
      }

      if (this.isSkippableDescriptionLine(trimmed)) {
        if (currentParagraph.length > 0) {
          paragraphs.push(currentParagraph.join(' '));
          currentParagraph = [];
        }
        continue;
      }

      const cleaned = this.cleanMarkdownText(trimmed);
      if (cleaned.length === 0 || this.looksLikeStandaloneHeading(cleaned)) {
        if (currentParagraph.length > 0) {
          paragraphs.push(currentParagraph.join(' '));
          currentParagraph = [];
        }
        continue;
      }

      currentParagraph.push(cleaned);
    }

    if (currentParagraph.length > 0) {
      paragraphs.push(currentParagraph.join(' '));
    }

    for (const paragraph of paragraphs) {
      const summary = this.summarizeDescription(paragraph);
      if (summary.length > 0) {
        return summary;
      }
    }

    return '';
  }

  private isSkippableDescriptionLine(line: string): boolean {
    return /^#{1,6}\s+/.test(line)
      || /^>\s*/.test(line)
      || /^[-*+]\s+/.test(line)
      || /^\d+[.)]\s+/.test(line)
      || /^\|.*\|$/.test(line)
      || /^([-*_]\s*){3,}$/.test(line)
      || /^<!--.*-->$/.test(line);
  }

  private looksLikeStandaloneHeading(line: string): boolean {
    return line.length <= 24 && /[:：]$/.test(line);
  }

  private cleanMarkdownText(text: string): string {
    return text
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/[*_~#>]+/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/\s*([，。！？；：])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private summarizeDescription(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return '';
    }

    const sentenceMatch = normalized.match(/^(.+?[。！？!?；;.])(?:\s|$)/);
    const candidate = sentenceMatch?.[1]?.trim() || normalized;
    return candidate.length > 220 ? `${candidate.slice(0, 217).trim()}...` : candidate;
  }

  async listSkills(): Promise<Array<{ name: string; version: string; description: string; enabled: boolean }>> {
    return this.getAllSkills()
      .map(skill => ({
        name: skill.name,
        version: skill.version,
        description: skill.description,
        enabled: this.enabledSkills.has(skill.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
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

  getSkillCandidatesDir(): string {
    return this.candidatesDir;
  }

  async maybeCreateCandidateFromExecution(input: SkillLearningInput): Promise<SkillCandidate | null> {
    if (input.completedSteps !== input.totalSteps) {
      return null;
    }

    if (input.totalSteps < 2 && input.stepResults.length < 2) {
      return null;
    }

    if (input.refinement?.shouldCreate === false) {
      return null;
    }

    const confidence = this.normalizeCandidateConfidence(input.refinement?.confidence);
    if (confidence !== undefined && confidence < 0.35) {
      return null;
    }

    const description = input.refinement?.refinedDescription?.trim() || this.buildLearnedSkillDescription(input.originalTask);
    const candidateName = await this.allocateCandidateName(input.refinement?.suggestedName || input.originalTask);
    const createdAt = new Date().toISOString();
    const candidateDir = join(this.candidatesDir, candidateName);
    const skillMdPath = join(candidateDir, 'SKILL.md');
    const content = this.buildCandidateSkillContent(candidateName, description, createdAt, input);

    await fs.mkdir(candidateDir, { recursive: true });
    await fs.writeFile(skillMdPath, content, 'utf-8');

    return {
      name: candidateName,
      description,
      path: skillMdPath,
      createdAt,
      sourceTask: input.originalTask,
      confidence,
      qualitySummary: input.refinement?.qualitySummary?.trim() || undefined,
      tags: this.normalizeCandidateTags(input.refinement?.tags),
    };
  }

  async listSkillCandidates(): Promise<SkillCandidate[]> {
    const entries = await fs.readdir(this.candidatesDir, { withFileTypes: true }).catch(() => []);
    const candidates: SkillCandidate[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillMdPath = join(this.candidatesDir, entry.name, 'SKILL.md');
      try {
        const content = await fs.readFile(skillMdPath, 'utf-8');
        const parsed = this.parseSkillCandidateDocument(content, entry.name);
        const stats = await fs.stat(skillMdPath);
        candidates.push({
          name: parsed.name,
          description: parsed.description,
          path: skillMdPath,
          createdAt: stats.mtime.toISOString(),
          sourceTask: parsed.sourceTask,
          confidence: parsed.confidence,
          qualitySummary: parsed.qualitySummary,
          tags: parsed.tags,
        });
      } catch {
        continue;
      }
    }

    return candidates.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async searchSkillCandidates(query: string, limit = 5): Promise<SkillCandidateSearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const entries = await fs.readdir(this.candidatesDir, { withFileTypes: true }).catch(() => []);
    const results: SkillCandidateSearchResult[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillMdPath = join(this.candidatesDir, entry.name, 'SKILL.md');
      try {
        const content = await fs.readFile(skillMdPath, 'utf-8');
        const parsed = this.parseSkillCandidateDocument(content, entry.name);
        const score = this.computeCandidateRelevance(normalizedQuery, parsed);
        if (score < 0.18) {
          continue;
        }

        const stats = await fs.stat(skillMdPath);
        results.push({
          name: parsed.name,
          description: parsed.description,
          path: skillMdPath,
          createdAt: stats.mtime.toISOString(),
          sourceTask: parsed.sourceTask,
          confidence: parsed.confidence,
          qualitySummary: parsed.qualitySummary,
          tags: parsed.tags,
          whenToUse: parsed.whenToUse,
          procedureSteps: parsed.procedureSteps,
          verification: parsed.verification,
          score,
        });
      } catch {
        continue;
      }
    }

    return results
      .sort((left, right) => right.score - left.score || right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async listLearningTodos(): Promise<SkillLearningTodo[]> {
    await this.ensureLearningTodoStore();
    try {
      const content = await fs.readFile(this.learningTodoFile, 'utf-8');
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .filter((item): item is SkillLearningTodo => !!item && typeof item.id === 'string' && typeof item.sourceTask === 'string')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch {
      return [];
    }
  }

  async searchLearningTodos(query: string, limit = 5): Promise<SkillLearningTodoSearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return [];
    }

    const todos = await this.listLearningTodos();
    return todos
      .map(todo => ({
        ...todo,
        score: this.computeLearningTodoRelevance(normalizedQuery, todo),
      }))
      .filter(todo => todo.score >= 0.18)
      .sort((left, right) => right.score - left.score || right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async addLearningTodo(input: Omit<SkillLearningTodo, 'id' | 'createdAt'>): Promise<SkillLearningTodo> {
    await this.ensureLearningTodoStore();
    const existing = await this.listLearningTodos();
    const todo: SkillLearningTodo = {
      id: `todo_${Date.now()}`,
      createdAt: new Date().toISOString(),
      sourceTask: input.sourceTask,
      issueSummary: input.issueSummary,
      suggestedSkill: input.suggestedSkill,
      blockers: input.blockers,
      nextActions: input.nextActions,
      tags: input.tags,
      confidence: input.confidence,
    };
    const deduped = [todo, ...existing.filter(item => !(item.sourceTask === todo.sourceTask && item.suggestedSkill === todo.suggestedSkill))];
    await fs.writeFile(this.learningTodoFile, JSON.stringify(deduped, null, 2), 'utf-8');
    return todo;
  }

  async createCandidateFromTodo(reference: string): Promise<SkillCandidate> {
    const normalizedReference = reference.trim();
    if (!normalizedReference) {
      throw new Error('Missing todo reference');
    }

    const todos = await this.listLearningTodos();
    const todo = this.resolveLearningTodoReference(normalizedReference, todos);
    if (!todo) {
      throw new Error(`Learning todo not found: ${reference}`);
    }

    const candidateName = await this.allocateCandidateName(todo.suggestedSkill || todo.sourceTask);
    const createdAt = new Date().toISOString();
    const candidateDir = join(this.candidatesDir, candidateName);
    const skillMdPath = join(candidateDir, 'SKILL.md');
    const description = `Draft candidate created from learning todo: ${todo.issueSummary.replace(/\s+/g, ' ').trim()}`.slice(0, 240);
    const content = this.buildCandidateFromTodoContent(candidateName, description, createdAt, todo);

    await fs.mkdir(candidateDir, { recursive: true });
    await fs.writeFile(skillMdPath, content, 'utf-8');

    const updatedTodos = todos.map(item => item.id === todo.id ? {
      ...item,
      draftedCandidateName: candidateName,
      draftedAt: createdAt,
    } : item);
    await fs.writeFile(this.learningTodoFile, JSON.stringify(updatedTodos, null, 2), 'utf-8');

    return {
      name: candidateName,
      description,
      path: skillMdPath,
      createdAt,
      sourceTask: todo.sourceTask,
      confidence: this.normalizeCandidateConfidence(todo.confidence),
      qualitySummary: `Seeded from learning todo ${todo.id}`,
      tags: this.normalizeCandidateTags(todo.tags),
    };
  }

  async adoptCandidate(name: string): Promise<void> {
    const candidateDir = join(this.candidatesDir, name);
    const targetDir = join(this.skillsDir, name);

    await fs.access(join(candidateDir, 'SKILL.md'));
    await fs.rm(targetDir, { recursive: true, force: true });
    await this.copyDirectory(candidateDir, targetDir);
    await this.loadSkill(name, targetDir);
    this.enableSkill(name);
  }

  private buildLearnedSkillDescription(task: string): string {
    const normalized = task.replace(/\s+/g, ' ').trim();
    const shortened = normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
    return `Auto-generated draft skill learned from task: ${shortened}`;
  }

  private buildCandidateFromTodoContent(name: string, description: string, createdAt: string, todo: SkillLearningTodo): string {
    const confidence = this.normalizeCandidateConfidence(todo.confidence);
    const tags = this.normalizeCandidateTags(todo.tags);
    const procedureLines = todo.nextActions.length > 0
      ? todo.nextActions.map((step, index) => `${index + 1}. ${step.replace(/\s+/g, ' ').trim()}`)
      : [
          '1. 重现这个能力缺口对应的失败场景。',
          '2. 选定需要补齐的 skill 或转换流程。',
          '3. 实现后补验证步骤并回填这个草稿。',
        ];
    const verificationLines = [
      ...todo.blockers.map(item => `- 解除阻塞: ${item.replace(/^[-*+]\s*/, '').trim()}`),
      '- 验证目标输出文件或目标副作用真实产生。',
      '- 确认回复文案会如实说明成功、降级或失败。',
    ];

    return [
      '---',
      `name: ${name}`,
      `description: ${description.replace(/\r?\n/g, ' ')}`,
      'version: 0.1.0',
      `sourceTask: ${JSON.stringify(todo.sourceTask)}`,
      `createdAt: ${createdAt}`,
      `sourceTodoId: ${todo.id}`,
      confidence !== undefined ? `confidence: ${confidence.toFixed(2)}` : undefined,
      tags.length > 0 ? `tags: ${tags.join(', ')}` : undefined,
      `qualitySummary: ${JSON.stringify(`Seeded from known gap: ${todo.issueSummary}`)}`,
      '---',
      '',
      `# ${name}`,
      '',
      '## Status',
      'This draft was seeded from a learning todo. It represents a known capability gap and still needs implementation details before reuse.',
      '',
      '## Assessment',
      todo.issueSummary,
      '',
      '## When to Use',
      `Use this skill when the user asks for a workflow similar to: ${todo.sourceTask}`,
      '',
      '## Procedure',
      procedureLines.join('\n'),
      '',
      '## Verification',
      verificationLines.join('\n'),
      '',
      '## Known Blockers',
      ...(todo.blockers.length > 0 ? todo.blockers.map(item => `- ${item.replace(/^[-*+]\s*/, '').trim()}`) : ['- 暂无补充阻塞信息。']),
      '',
      '## Source Todo Snapshot',
      `Todo ID: ${todo.id}`,
      `Suggested skill: ${todo.suggestedSkill}`,
      `Created at: ${todo.createdAt}`,
      ...(todo.nextActions.length > 0 ? ['', 'Next actions:', ...todo.nextActions.map(item => `- ${item}`)] : []),
      '',
    ].filter((line): line is string => typeof line === 'string').join('\n');
  }

  private buildCandidateSkillContent(name: string, description: string, createdAt: string, input: SkillLearningInput): string {
    const refinement = input.refinement;
    const whenToUse = refinement?.whenToUse?.trim() || input.originalTask.replace(/\s+/g, ' ').trim();
    const procedureLines = refinement?.procedure && refinement.procedure.length > 0
      ? refinement.procedure.map((step, index) => `${index + 1}. ${step.replace(/\s+/g, ' ').trim()}`)
      : input.stepDescriptions.map((step, index) => {
      const preview = (input.stepResults[index] || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);
      return `${index + 1}. ${step}${preview ? `\n   - Observed result: ${preview}` : ''}`;
    });
    const verificationLines = refinement?.verification && refinement.verification.length > 0
      ? refinement.verification.map(item => `- ${item.replace(/^[-*+]\s*/, '').trim()}`)
      : [
          '- Verify the produced output matches the expected artifacts or side effects from the original task.',
          '- If any step was environment-specific, patch this draft before regular reuse.',
        ];
    const tags = this.normalizeCandidateTags(refinement?.tags);
    const confidence = this.normalizeCandidateConfidence(refinement?.confidence);
    const qualitySummary = refinement?.qualitySummary?.replace(/\r?\n/g, ' ').trim();

    return [
      '---',
      `name: ${name}`,
      `description: ${description.replace(/\r?\n/g, ' ')}`,
      'version: 0.1.0',
      `sourceTask: ${JSON.stringify(input.originalTask)}`,
      `createdAt: ${createdAt}`,
      confidence !== undefined ? `confidence: ${confidence.toFixed(2)}` : undefined,
      tags.length > 0 ? `tags: ${tags.join(', ')}` : undefined,
      qualitySummary ? `qualitySummary: ${JSON.stringify(qualitySummary)}` : undefined,
      '---',
      '',
      `# ${name}`,
      '',
      '## Status',
      'This is an auto-generated draft skill candidate. Review and refine it before relying on it as a stable workflow.',
      '',
      '## Assessment',
      qualitySummary || 'Auto-generated after self-review. Validate the procedure before repeated reuse.',
      confidence !== undefined ? `Confidence: ${confidence.toFixed(2)}` : undefined,
      tags.length > 0 ? `Tags: ${tags.join(', ')}` : undefined,
      '',
      '## When to Use',
      `Use this skill when the user asks for a similar workflow to: ${whenToUse}`,
      '',
      '## Procedure',
      procedureLines.join('\n'),
      '',
      '## Verification',
      verificationLines.join('\n'),
      '',
      '## Source Task Snapshot',
      `Original task: ${input.originalTask}`,
      `Completed steps: ${input.completedSteps}/${input.totalSteps}`,
      '',
    ].filter((line): line is string => typeof line === 'string').join('\n');
  }

  private async allocateCandidateName(task: string): Promise<string> {
    const base = this.slugify(task).slice(0, 48) || 'learned-workflow';
    let candidate = base;
    let counter = 2;

    while (await this.skillNameExists(candidate)) {
      candidate = `${base}-${counter}`;
      counter++;
    }

    return candidate;
  }

  private async skillNameExists(name: string): Promise<boolean> {
    if (this.skills.has(name)) {
      return true;
    }

    try {
      await fs.access(join(this.candidatesDir, name, 'SKILL.md'));
      return true;
    } catch {
      return false;
    }
  }

  private slugify(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-');
  }

  private normalizeCandidateConfidence(confidence: number | undefined): number | undefined {
    if (typeof confidence !== 'number' || Number.isNaN(confidence)) {
      return undefined;
    }

    return Math.max(0, Math.min(1, confidence));
  }

  private normalizeCandidateTags(tags: string[] | undefined): string[] {
    return (tags || [])
      .map(tag => tag.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 12);
  }

  private parseSkillCandidateDocument(content: string, fallbackName: string): {
    name: string;
    description: string;
    sourceTask: string;
    confidence?: number;
    qualitySummary?: string;
    tags: string[];
    whenToUse: string;
    procedureSteps: string[];
    verification: string[];
  } {
    const frontmatter = this.parseFrontmatter(content);
    const description = this.normalizeSkillDescription(frontmatter.description, content, fallbackName);
    return {
      name: typeof frontmatter.name === 'string' ? frontmatter.name : fallbackName,
      description,
      sourceTask: typeof frontmatter.sourceTask === 'string' ? frontmatter.sourceTask : '',
      confidence: this.parseConfidence(frontmatter.confidence),
      qualitySummary: typeof frontmatter.qualitySummary === 'string' ? frontmatter.qualitySummary : this.extractSection(content, 'Assessment').split(/\r?\n/)[0]?.trim() || undefined,
      tags: this.parseTags(frontmatter.tags),
      whenToUse: this.extractSection(content, 'When to Use').replace(/\s+/g, ' ').trim(),
      procedureSteps: this.extractListSection(content, 'Procedure'),
      verification: this.extractListSection(content, 'Verification'),
    };
  }

  private parseConfidence(value: unknown): number | undefined {
    if (typeof value === 'number') {
      return this.normalizeCandidateConfidence(value);
    }

    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      return this.normalizeCandidateConfidence(parsed);
    }

    return undefined;
  }

  private parseTags(value: unknown): string[] {
    if (Array.isArray(value)) {
      return this.normalizeCandidateTags(value.filter((item): item is string => typeof item === 'string'));
    }

    if (typeof value === 'string') {
      return this.normalizeCandidateTags(value.split(','));
    }

    return [];
  }

  private extractSection(content: string, heading: string): string {
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = body.match(new RegExp(`##\\s+${escaped}\\r?\\n([\\s\\S]*?)(?=\\r?\\n##\\s+|$)`, 'i'));
    return match?.[1]?.trim() || '';
  }

  private extractListSection(content: string, heading: string): string[] {
    const section = this.extractSection(content, heading);
    if (!section) {
      return [];
    }

    return section
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => line.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
      .filter(Boolean);
  }

  private computeCandidateRelevance(query: string, candidate: {
    name: string;
    description: string;
    sourceTask: string;
    whenToUse: string;
    procedureSteps: string[];
    verification: string[];
    tags: string[];
    confidence?: number;
  }): number {
    const haystack = [
      candidate.name,
      candidate.description,
      candidate.sourceTask,
      candidate.whenToUse,
      candidate.procedureSteps.join(' '),
      candidate.verification.join(' '),
      candidate.tags.join(' '),
    ].join(' ').toLowerCase();
    const queryTerms = this.extractRelevanceTerms(query.toLowerCase());
    if (queryTerms.length === 0) {
      return 0;
    }

    const hitCount = queryTerms.filter(term => haystack.includes(term)).length;
    const overlapScore = hitCount / queryTerms.length;
    const exactBonus = haystack.includes(query.toLowerCase().trim()) ? 0.25 : 0;
    const confidenceBonus = (candidate.confidence || 0) * 0.15;
    return Math.min(1, overlapScore + exactBonus + confidenceBonus);
  }

  private computeLearningTodoRelevance(query: string, todo: SkillLearningTodo): number {
    const haystack = [
      todo.sourceTask,
      todo.issueSummary,
      todo.suggestedSkill,
      todo.blockers.join(' '),
      todo.nextActions.join(' '),
      (todo.tags || []).join(' '),
    ].join(' ').toLowerCase();
    const queryTerms = this.extractRelevanceTerms(query.toLowerCase());
    if (queryTerms.length === 0) {
      return 0;
    }

    const hitCount = queryTerms.filter(term => haystack.includes(term)).length;
    const overlapScore = hitCount / queryTerms.length;
    const exactBonus = haystack.includes(query.toLowerCase().trim()) ? 0.25 : 0;
    const confidenceBonus = (todo.confidence || 0) * 0.12;
    return Math.min(1, overlapScore + exactBonus + confidenceBonus);
  }

  private resolveLearningTodoReference(reference: string, todos: SkillLearningTodo[]): SkillLearningTodo | null {
    const normalized = reference.trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    return todos.find(todo => todo.id.toLowerCase() === normalized)
      || todos.find(todo => todo.suggestedSkill.toLowerCase() === normalized)
      || todos.find(todo => todo.draftedCandidateName?.toLowerCase() === normalized)
      || null;
  }

  private extractRelevanceTerms(input: string): string[] {
    const baseTerms = input.match(/[a-z0-9]+|[\u4e00-\u9fff]{2,}/g) || [];
    const expanded = new Set<string>();

    for (const term of baseTerms) {
      expanded.add(term);
      if (/^[\u4e00-\u9fff]+$/.test(term) && term.length >= 4) {
        for (let index = 0; index < term.length - 1; index++) {
          expanded.add(term.slice(index, index + 2));
        }
      }
    }

    return Array.from(expanded).filter(term => term.length >= 2);
  }

  private async ensureLearningTodoStore(): Promise<void> {
    try {
      await fs.access(this.learningTodoFile);
    } catch {
      await fs.writeFile(this.learningTodoFile, '[]', 'utf-8');
    }
  }
}

export function createSkillManager(skillsDir?: string): SkillManager {
  const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();
  const defaultDir = join(homeDir, '.ai-agent-cli', 'skills');
  return new SkillManager(skillsDir || defaultDir);
}
