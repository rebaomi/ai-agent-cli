import type { AgentConfig, BrowserAgentConfig } from '../types/index.js';
import type { BrowserAgentRunResult, BrowserAgentTask } from './domain/types.js';
import { BrowserAgentModelRouter } from './model/browser-agent-model-router.js';
import { BrowserAgentRunner } from './runner/browser-agent-runner.js';
import { BrowserWorkflowService } from './workflows/browser-workflow-service.js';

export class BrowserAgentService {
  constructor(private readonly config: AgentConfig, private readonly browserAgentConfig: BrowserAgentConfig) {}

  async run(task: BrowserAgentTask): Promise<BrowserAgentRunResult> {
    const workflowService = new BrowserWorkflowService({
      workspace: this.config.workspace,
      appBaseDir: this.config.appBaseDir,
      workflowDir: this.browserAgentConfig.workflowDir,
      autoMatch: this.browserAgentConfig.autoMatchWorkflows,
    });
    const resolved = await workflowService.resolveTask(task);
    const modelRouter = new BrowserAgentModelRouter(this.config, this.browserAgentConfig);
    const plannerClient = await modelRouter.createPlannerClient();
    const extractorClient = await modelRouter.createExtractorClient();
    const runner = new BrowserAgentRunner({
      plannerClient,
      extractorClient,
      browserAgentConfig: this.browserAgentConfig,
      workflowResolution: resolved.resolution,
      workspace: this.config.workspace,
      appBaseDir: this.config.appBaseDir,
      artifactOutputDir: this.config.artifactOutputDir,
      documentOutputDir: this.config.documentOutputDir,
    });
    return runner.run(resolved.task);
  }
}
