import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';
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
    skills = new Map();
    skillsDir;
    enabledSkills = new Set();
    constructor(skillsDir) {
        this.skillsDir = skillsDir;
    }
    async initialize() {
        await fs.mkdir(this.skillsDir, { recursive: true });
    }
    async installSkill(source) {
        const skillName = this.extractSkillName(source);
        const skillPath = join(this.skillsDir, skillName);
        await fs.mkdir(skillPath, { recursive: true });
        if (source.startsWith('npm:')) {
            await this.installFromNpm(source.slice(4), skillPath);
        }
        else if (source.startsWith('github:') || source.startsWith('https://')) {
            await this.installFromGit(source, skillPath);
        }
        else if (source.startsWith('./') || source.startsWith('/') || /^[a-zA-Z]:/.test(source)) {
            await this.installFromLocal(source, skillPath);
        }
        else {
            await this.installFromNpm(source, skillPath);
        }
        await this.loadSkill(skillName);
    }
    async installFromNpm(packageName, targetPath) {
        const { execSync } = await import('child_process');
        try {
            execSync(`npm pack ${packageName}`, { cwd: targetPath, stdio: 'pipe' });
            const { execSync: exec2 } = await import('child_process');
            const tarball = exec2(`npm pack ${packageName} --json`, { cwd: targetPath, encoding: 'utf-8' });
            const info = JSON.parse(tarball);
            if (info[0]?.filename) {
                execSync(`tar -xzf ${info[0].filename}`, { cwd: targetPath });
            }
        }
        catch (error) {
            throw new Error(`Failed to install from npm: ${error}`);
        }
    }
    async installFromGit(url, targetPath) {
        const { execSync } = await import('child_process');
        try {
            execSync(`git clone ${url} "${targetPath}"`, { stdio: 'pipe' });
        }
        catch (error) {
            throw new Error(`Failed to clone from git: ${error}`);
        }
    }
    async installFromLocal(source, targetPath) {
        const srcPath = resolve(source);
        await this.copyDirectory(srcPath, targetPath);
    }
    async copyDirectory(src, dest) {
        await fs.mkdir(dest, { recursive: true });
        const entries = await fs.readdir(src, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = join(src, entry.name);
            const destPath = join(dest, entry.name);
            if (entry.isDirectory()) {
                await this.copyDirectory(srcPath, destPath);
            }
            else {
                await fs.copyFile(srcPath, destPath);
            }
        }
    }
    extractSkillName(source) {
        if (source.startsWith('npm:')) {
            const name = source.slice(4).split('@')[0] || '';
            const parts = name.split('/');
            return parts.pop() || 'unknown';
        }
        const match = source.match(/([^/]+?)(?:\.git)?$/);
        return match?.[1] || 'unknown';
    }
    async uninstallSkill(name) {
        const skillPath = join(this.skillsDir, name);
        await fs.rm(skillPath, { recursive: true, force: true });
        this.skills.delete(name);
        this.enabledSkills.delete(name);
    }
    async loadSkill(name) {
        const skillPath = join(this.skillsDir, name);
        const manifestPath = join(skillPath, 'skill.json');
        let manifest;
        try {
            const content = await fs.readFile(manifestPath, 'utf-8');
            manifest = skillManifestSchema.parse(JSON.parse(content));
        }
        catch (error) {
            throw new Error(`Invalid skill manifest: ${error}`);
        }
        const skill = {
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
        }
        catch (error) {
            console.warn(`Failed to load skill ${name}: ${error}`);
        }
        this.skills.set(name, skill);
        this.enabledSkills.add(name);
    }
    async listSkills() {
        const entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
        const skills = [];
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
                }
                catch {
                    skills.push({ name: entry.name, version: 'unknown', description: '', enabled: false });
                }
            }
        }
        return skills;
    }
    getSkill(name) {
        return this.skills.get(name);
    }
    getAllSkills() {
        return Array.from(this.skills.values());
    }
    getEnabledSkills() {
        return Array.from(this.skills.values()).filter(s => this.enabledSkills.has(s.name));
    }
    getCommands() {
        const commands = [];
        for (const skill of this.getEnabledSkills()) {
            for (const cmd of skill.commands || []) {
                commands.push({ skill: skill.name, name: cmd.name, description: cmd.description });
            }
        }
        return commands;
    }
    getTools() {
        const tools = [];
        for (const skill of this.getEnabledSkills()) {
            for (const tool of skill.tools || []) {
                tools.push({ skill: skill.name, name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
            }
        }
        return tools;
    }
    async executeCommand(name, args, ctx) {
        const skill = this.getEnabledSkills().find(s => s.commands?.some(c => c.name === name));
        if (!skill)
            throw new Error(`Command not found: ${name}`);
        const cmd = skill.commands?.find(c => c.name === name);
        if (!cmd)
            throw new Error(`Command not found: ${name}`);
        if (cmd.handler) {
            return cmd.handler(args, ctx);
        }
        throw new Error(`Command handler not implemented: ${name}`);
    }
    async executeTool(name, args, ctx) {
        const skill = this.getEnabledSkills().find(s => s.tools?.some(t => t.name === name));
        if (!skill)
            throw new Error(`Tool not found: ${name}`);
        const tool = skill.tools?.find(t => t.name === name);
        if (!tool)
            throw new Error(`Tool not found: ${name}`);
        if (tool.handler) {
            return tool.handler(args, ctx);
        }
        throw new Error(`Tool handler not implemented: ${name}`);
    }
    async runHook(hookName, ctx, ...args) {
        const results = [];
        for (const skill of this.getEnabledSkills()) {
            const hook = skill.hooks?.[hookName];
            if (hook) {
                try {
                    const result = await hook(ctx, ...args);
                    if (result !== null && result !== undefined) {
                        results.push(result);
                    }
                }
                catch (error) {
                    console.warn(`Hook ${hookName} failed for ${skill.name}: ${error}`);
                }
            }
        }
        return results;
    }
    enableSkill(name) {
        this.enabledSkills.add(name);
    }
    disableSkill(name) {
        this.enabledSkills.delete(name);
    }
}
export function createSkillManager(skillsDir) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();
    const defaultDir = join(homeDir, '.ai-agent-cli', 'skills');
    return new SkillManager(skillsDir || defaultDir);
}
//# sourceMappingURL=skills.js.map