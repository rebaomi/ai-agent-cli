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
    content: Array<{
        type: 'text';
        text: string;
    }>;
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
export declare class SkillManager {
    private skills;
    private skillsDir;
    private enabledSkills;
    constructor(skillsDir: string);
    initialize(): Promise<void>;
    installSkill(source: string): Promise<void>;
    private installFromNpm;
    private installFromGit;
    private installFromLocal;
    private copyDirectory;
    private extractSkillName;
    uninstallSkill(name: string): Promise<void>;
    loadSkill(name: string): Promise<void>;
    listSkills(): Promise<Array<{
        name: string;
        version: string;
        description: string;
        enabled: boolean;
    }>>;
    getSkill(name: string): Skill | undefined;
    getAllSkills(): Skill[];
    getEnabledSkills(): Skill[];
    getCommands(): Array<{
        skill: string;
        name: string;
        description: string;
    }>;
    getTools(): Array<{
        skill: string;
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
    }>;
    executeCommand(name: string, args: string[], ctx: SkillContext): Promise<string>;
    executeTool(name: string, args: Record<string, unknown>, ctx: SkillContext): Promise<SkillToolResult>;
    runHook(hookName: keyof NonNullable<Skill['hooks']>, ctx: SkillContext, ...args: unknown[]): Promise<unknown[]>;
    enableSkill(name: string): void;
    disableSkill(name: string): void;
}
export declare function createSkillManager(skillsDir?: string): SkillManager;
//# sourceMappingURL=skills.d.ts.map