import type { AgentConfig, MCPConfig } from '../types/index.js';

function isFilesystemMcpServer(server: MCPConfig): boolean {
  const command = server.command || '';
  const args = server.args || [];
  return /server-filesystem/i.test(command) || args.some(arg => /server-filesystem/i.test(arg));
}

function normalizeVaultPath(rawPath: string): string {
  return rawPath.replace(/^['"]|['"]$/g, '').trim();
}

export function extractObsidianVaultPath(config: Partial<AgentConfig> | Record<string, unknown>): string | null {
  const mcpServers = Array.isArray((config as AgentConfig).mcp) ? (config as AgentConfig).mcp as MCPConfig[] : [];
  const obsidianServer = mcpServers.find(server => server.name === 'obsidian');
  if (!obsidianServer) {
    return null;
  }

  if (obsidianServer.env?.ROOT_DIR) {
    return normalizeVaultPath(obsidianServer.env.ROOT_DIR);
  }

  if (isFilesystemMcpServer(obsidianServer)) {
    const candidate = [...(obsidianServer.args || [])]
      .reverse()
      .find(arg => !!arg && !arg.startsWith('-') && !/server-filesystem/i.test(arg));
    if (candidate) {
      return normalizeVaultPath(candidate);
    }
  }

  return null;
}
