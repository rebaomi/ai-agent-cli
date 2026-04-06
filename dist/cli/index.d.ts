export declare class CLI {
    private agent?;
    private ollama?;
    private mcpManager;
    private lspManager;
    private sandbox;
    private skillManager;
    private builtInTools?;
    private workspace;
    private running;
    private history;
    private historyIndex;
    constructor();
    initialize(): Promise<void>;
    run(): Promise<void>;
    private prompt;
    private handleCommand;
    private handleMessage;
    private showQuickHelp;
    private showHelp;
    private showHistory;
    private showTools;
    private showConfig;
    private changeModel;
    private handleMCPCommand;
    private handleLSPCommand;
    private handleSkillCommand;
    shutdown(): Promise<void>;
}
export declare function runCLI(): Promise<void>;
//# sourceMappingURL=index.d.ts.map