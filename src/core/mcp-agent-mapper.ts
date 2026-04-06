import { promises as fs } from 'fs';
import * as path from 'path';
import type { Tool } from '../types/index.js';

export interface MCPMemoryEntry {
  id: string;
  timestamp: number;
  topic: string;
  summary: string;
  keyPoints: string[];
  relatedTools: string[];
  contextUsed: number;
}

export interface MCPAgentBinding {
  mcpServerName: string;
  agentId?: string;
  agentRole?: string;
  memoryFile: string;
  enabled: boolean;
  lastUsed: number;
  usageCount: number;
}

export class MCPAgentMapper {
  private bindings: Map<string, MCPAgentBinding> = new Map();
  private memories: Map<string, MCPMemoryEntry[]> = new Map();
  private memoryDir: string;

  constructor(memoryDir?: string) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();
    this.memoryDir = memoryDir || path.join(homeDir, '.ai-agent-cli', 'mcp-memory');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.memoryDir, { recursive: true });
    await this.loadBindings();
  }

  async loadBindings(): Promise<void> {
    const bindingsFile = path.join(this.memoryDir, 'bindings.json');
    try {
      const content = await fs.readFile(bindingsFile, 'utf-8');
      const data = JSON.parse(content);
      for (const [serverName, binding] of Object.entries(data)) {
        this.bindings.set(serverName, binding as MCPAgentBinding);
      }
    } catch {}
  }

  async saveBindings(): Promise<void> {
    const bindingsFile = path.join(this.memoryDir, 'bindings.json');
    const data: Record<string, MCPAgentBinding> = {};
    for (const [serverName, binding] of this.bindings) {
      data[serverName] = binding;
    }
    await fs.writeFile(bindingsFile, JSON.stringify(data, null, 2), 'utf-8');
  }

  registerMCP(mcpServerName: string, agentId?: string, agentRole?: string): MCPAgentBinding {
    const binding: MCPAgentBinding = {
      mcpServerName,
      agentId,
      agentRole,
      memoryFile: path.join(this.memoryDir, `${mcpServerName}.json`),
      enabled: true,
      lastUsed: Date.now(),
      usageCount: 0,
    };
    this.bindings.set(mcpServerName, binding);
    this.saveBindings();
    return binding;
  }

  bindToAgent(mcpServerName: string, agentId: string, agentRole?: string): void {
    const binding = this.bindings.get(mcpServerName);
    if (binding) {
      binding.agentId = agentId;
      binding.agentRole = agentRole;
      this.saveBindings();
    }
  }

  getBinding(mcpServerName: string): MCPAgentBinding | undefined {
    return this.bindings.get(mcpServerName);
  }

  getAllBindings(): MCPAgentBinding[] {
    return Array.from(this.bindings.values());
  }

  async addMemory(mcpServerName: string, entry: Omit<MCPMemoryEntry, 'id' | 'timestamp'>): Promise<void> {
    const binding = this.bindings.get(mcpServerName);
    if (!binding) return;

    const memories = await this.loadMCPMemory(mcpServerName);
    const newEntry: MCPMemoryEntry = {
      ...entry,
      id: `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
    };
    memories.push(newEntry);
    
    if (memories.length > 100) {
      memories.splice(0, memories.length - 100);
    }
    
    await this.saveMCPMemory(mcpServerName, memories);
    binding.lastUsed = Date.now();
    binding.usageCount++;
    this.saveBindings();
  }

  async loadMCPMemory(mcpServerName: string): Promise<MCPMemoryEntry[]> {
    const binding = this.bindings.get(mcpServerName);
    if (!binding) return [];
    
    if (this.memories.has(mcpServerName)) {
      return this.memories.get(mcpServerName)!;
    }

    try {
      const content = await fs.readFile(binding.memoryFile, 'utf-8');
      const memories = JSON.parse(content);
      this.memories.set(mcpServerName, memories);
      return memories;
    } catch {
      return [];
    }
  }

  async saveMCPMemory(mcpServerName: string, memories: MCPMemoryEntry[]): Promise<void> {
    const binding = this.bindings.get(mcpServerName);
    if (!binding) return;
    
    await fs.writeFile(binding.memoryFile, JSON.stringify(memories, null, 2), 'utf-8');
    this.memories.set(mcpServerName, memories);
  }

  async getContextSummary(mcpServerName: string, maxEntries = 10): Promise<string> {
    const memories = await this.loadMCPMemory(mcpServerName);
    const recent = memories.slice(-maxEntries);
    
    if (recent.length === 0) {
      return '';
    }

    let summary = `MCP ${mcpServerName} 最近使用记录：\n`;
    for (const mem of recent) {
      summary += `- [${mem.topic}] ${mem.summary}\n`;
    }
    return summary;
  }

  async getToolsSummary(tools: Tool[], maxTools = 20): Promise<string> {
    if (tools.length <= maxTools) {
      return '';
    }

    const toolNames = tools.map(t => t.name).join(', ');
    return `可用工具（共${tools.length}个）: ${toolNames}...`;
  }

  async optimizeContext(
    mcpServerName: string,
    tools: Tool[],
    maxContextLength = 6000
  ): Promise<{ tools: Tool[]; context: string }> {
    const summary = await this.getContextSummary(mcpServerName);
    const summaryLength = summary.length;
    const availableForTools = maxContextLength - summaryLength;

    let selectedTools = tools;
    if (tools.length > 20) {
      selectedTools = tools.slice(0, 20);
    }

    const toolDescriptions = selectedTools.map(t => 
      `- ${t.name}: ${t.description}`
    ).join('\n');

    const toolsText = `工具列表:\n${toolDescriptions}`;
    
    return {
      tools: selectedTools,
      context: summary ? `${summary}\n\n${toolsText}` : toolsText,
    };
  }

  disableMCP(mcpServerName: string): void {
    const binding = this.bindings.get(mcpServerName);
    if (binding) {
      binding.enabled = false;
      this.saveBindings();
    }
  }

  enableMCP(mcpServerName: string): void {
    const binding = this.bindings.get(mcpServerName);
    if (binding) {
      binding.enabled = true;
      this.saveBindings();
    }
  }

  getStatistics(): {
    totalMCPs: number;
    activeMCPs: number;
    boundMCPs: number;
    totalMemoryEntries: number;
  } {
    let activeMCPs = 0;
    let boundMCPs = 0;
    let totalMemoryEntries = 0;

    for (const binding of this.bindings.values()) {
      if (binding.enabled) activeMCPs++;
      if (binding.agentId) boundMCPs++;
    }

    for (const memories of this.memories.values()) {
      totalMemoryEntries += memories.length;
    }

    return {
      totalMCPs: this.bindings.size,
      activeMCPs,
      boundMCPs,
      totalMemoryEntries,
    };
  }
}

export const mcpAgentMapper = new MCPAgentMapper();
