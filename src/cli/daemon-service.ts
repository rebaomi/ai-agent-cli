import os from 'os';
import path from 'path';
import { configManager } from '../core/config.js';
import { BackgroundDaemonManager } from '../core/background-daemon.js';
import { createCronManager } from '../core/cron-manager.js';
import { MCPManager } from '../mcp/client.js';
import { LSPManager } from '../lsp/client.js';
import { Sandbox } from '../sandbox/executor.js';
import { BuiltInTools } from '../tools/builtin.js';
import { getArtifactOutputDir } from '../utils/path-resolution.js';
import type { BackgroundServiceConnection } from '../core/background-daemon.js';

export async function runBackgroundDaemonService(): Promise<void> {
  const config = configManager.getAgentConfig();
  const workspace = config.workspace || process.cwd();
  const appBaseDir = config.appBaseDir || path.join(os.homedir(), '.ai-agent-cli');
  const daemonManager = new BackgroundDaemonManager(appBaseDir);
  const mcpManager = new MCPManager();
  const lspManager = new LSPManager();
  const cronManager = createCronManager();

  await daemonManager.registerCurrentProcess({
    pid: process.pid,
    configPath: configManager.getConfigPath(),
    workspace,
    cronSchedulerRunning: false,
    mcpServers: [],
    lspServers: [],
  });

  await cronManager.initialize();

  const artifactOutputDir = getArtifactOutputDir({
    workspace,
    appBaseDir: config.appBaseDir,
    artifactOutputDir: config.artifactOutputDir,
    documentOutputDir: config.documentOutputDir,
  });
  const cronStoreDir = cronManager.getStoreDir();
  const sandboxConfig = {
    enabled: config.sandbox?.enabled ?? true,
    allowedPaths: Array.from(new Set([
      workspace,
      artifactOutputDir,
      cronStoreDir,
      ...(config.sandbox?.allowedPaths || []),
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0))),
    deniedPaths: config.sandbox?.deniedPaths,
    timeout: config.sandbox?.timeout ?? 30000,
    maxMemory: config.sandbox?.maxMemory,
    allowCommandExecution: config.sandbox?.allowCommandExecution ?? true,
    allowBash: config.sandbox?.allowBash ?? (process.platform !== 'win32'),
    allowPowerShell: config.sandbox?.allowPowerShell ?? (process.platform === 'win32'),
    commandExecutionMode: config.sandbox?.commandExecutionMode ?? 'shell',
    commandAllowlist: config.sandbox?.commandAllowlist ?? [],
    allowNetworkRequests: config.sandbox?.allowNetworkRequests ?? true,
    allowBrowserOpen: config.sandbox?.allowBrowserOpen ?? true,
    allowBrowserAutomation: config.sandbox?.allowBrowserAutomation ?? true,
  };

  const sandbox = new Sandbox(sandboxConfig);
  await sandbox.initialize();

  const builtInTools = new BuiltInTools(sandbox, lspManager, {
    mcpManager,
    cronManager,
    workspace,
    config: config as unknown as Record<string, unknown>,
  });
  const mcpServers: BackgroundServiceConnection[] = [];
  const lspServers: BackgroundServiceConnection[] = [];

  if (config.mcp && config.mcp.length > 0) {
    for (const mcpConfig of config.mcp) {
      try {
        await mcpManager.addServer(mcpConfig);
        mcpServers.push({ name: mcpConfig.name, status: 'connected' });
        console.log(`[daemon] MCP server ready: ${mcpConfig.name}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        mcpServers.push({ name: mcpConfig.name, status: 'failed', detail });
        console.error(`[daemon] MCP server ${mcpConfig.name} failed: ${detail}`);
      }
    }
  }

  if (config.lsp && config.lsp.length > 0) {
    for (const lspConfig of config.lsp) {
      try {
        await lspManager.addServer(lspConfig, `file://${workspace}`);
        lspServers.push({ name: lspConfig.name, status: 'connected' });
        console.log(`[daemon] LSP server ready: ${lspConfig.name}`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        lspServers.push({ name: lspConfig.name, status: 'failed', detail });
        console.error(`[daemon] LSP server ${lspConfig.name} failed: ${detail}`);
      }
    }
  }

  cronManager.setExecutor((toolName, args, job) => builtInTools.executeToolForCronJob(toolName, args, job.name));
  cronManager.setNotifier(async ({ job, result }) => {
    const output = result.output || '(无输出)';
    const prefix = `[daemon cron] ${job.name} -> ${job.toolName}`;
    if (result.is_error) {
      console.error(`${prefix}\n${output}\n`);
      return;
    }

    console.log(`${prefix}\n${output}\n`);
  });

  cronManager.start();

  await daemonManager.registerCurrentProcess({
    pid: process.pid,
    configPath: configManager.getConfigPath(),
    workspace,
    cronSchedulerRunning: true,
    mcpServers,
    lspServers,
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    cronManager.stop();
    await daemonManager.clearState();
    await mcpManager.disconnectAll();
    await lspManager.disconnectAll();
    await sandbox.cleanup();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });

  await new Promise<void>(() => {});
}