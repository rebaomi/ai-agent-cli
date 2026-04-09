import { promises as fs } from 'fs';
import * as path from 'path';
import chalk from 'chalk';

export type PermissionType = 
  | 'file_read'
  | 'file_write'
  | 'file_delete'
  | 'file_copy'
  | 'file_move'
  | 'directory_create'
  | 'directory_list'
  | 'command_execute'
  | 'env_read'
  | 'process_list'
  | 'network_request'
  | 'browser_open'
  | 'browser_automation'
  | 'mcp_access'
  | 'tool_execute'
  | 'clipboard_read'
  | 'clipboard_write';

export interface Permission {
  type: PermissionType;
  resource?: string;
  granted: boolean;
  grantedAt?: number;
  expiresAt?: number;
  group?: string;
}

export interface PermissionGroup {
  id: string;
  name: string;
  description: string;
  permissions: PermissionType[];
}

export interface PermissionConfig {
  autoGrantDangerous: boolean;
  askForPermissions: boolean;
  trustedCommands: string[];
  allowedPaths: string[];
  deniedPaths: string[];
  groups: PermissionGroup[];
}

export interface PermissionRequest {
  id: string;
  type: PermissionType;
  resource?: string;
  description: string;
  isDangerous: boolean;
  timestamp: number;
}

export interface AuditLogEntry {
  id: string;
  timestamp: number;
  action: 'grant' | 'deny' | 'revoke' | 'expire' | 'auto_grant';
  type: PermissionType;
  resource?: string;
  granted: boolean;
  reason?: string;
}

export class PermissionManager {
  private config: PermissionConfig;
  private grantedPermissions: Map<string, Permission> = new Map();
  private pendingRequests: PermissionRequest[] = [];
  private configDir: string;
  private configFile: string;
  private auditFile: string;
  private listeners: ((request: PermissionRequest) => Promise<boolean>)[] = [];

  constructor(configDir?: string) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();
    this.configDir = configDir || path.join(homeDir, '.ai-agent-cli', 'permissions');
    this.configFile = path.join(this.configDir, 'config.json');
    this.auditFile = path.join(this.configDir, 'audit.json');
    
    this.config = {
      autoGrantDangerous: false,
      askForPermissions: true,
      trustedCommands: ['git', 'npm', 'node', 'tsx', 'tsc', 'python', 'pnpm', 'yarn', 'docker', 'code'],
      allowedPaths: [process.cwd(), path.join(homeDir, 'projects'), path.join(homeDir, 'code')],
      deniedPaths: ['/etc', '/sys', '/root', '/var', 'C:\\Windows', 'C:\\Program Files'],
      groups: this.getDefaultGroups(),
    };
  }

  private getDefaultGroups(): PermissionGroup[] {
    return [
      {
        id: 'file_ops',
        name: '文件操作',
        description: '读写文件的基础权限组',
        permissions: ['file_read', 'file_write', 'directory_list', 'directory_create'],
      },
      {
        id: 'file_dangerous',
        name: '危险文件操作',
        description: '删除、复制、移动文件',
        permissions: ['file_delete', 'file_copy', 'file_move'],
      },
      {
        id: 'network',
        name: '网络操作',
        description: '网络请求和浏览器操作',
        permissions: ['network_request', 'browser_open', 'browser_automation'],
      },
      {
        id: 'system',
        name: '系统操作',
        description: '命令执行、环境变量、进程',
        permissions: ['command_execute', 'env_read', 'process_list'],
      },
    ];
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true });
    await this.loadConfig();
    await this.cleanExpiredPermissions();
  }

  private async loadConfig(): Promise<void> {
    try {
      const content = await fs.readFile(this.configFile, 'utf-8');
      const saved = JSON.parse(content);
      this.config = { ...this.config, ...saved, groups: this.config.groups };
      
      if (saved.grantedPermissions) {
        for (const [key, perm] of Object.entries(saved.grantedPermissions)) {
          this.grantedPermissions.set(key, perm as Permission);
        }
      }
    } catch {}
  }

  private async saveConfig(): Promise<void> {
    const grantedObj: Record<string, Permission> = {};
    for (const [key, perm] of this.grantedPermissions) {
      grantedObj[key] = perm;
    }
    
    await fs.writeFile(this.configFile, JSON.stringify({
      ...this.config,
      grantedPermissions: grantedObj,
    }, null, 2), 'utf-8');
  }

  private async logAudit(entry: AuditLogEntry): Promise<void> {
    try {
      let logs: AuditLogEntry[] = [];
      try {
        const content = await fs.readFile(this.auditFile, 'utf-8');
        logs = JSON.parse(content);
      } catch {}
      
      logs.push(entry);
      if (logs.length > 1000) {
        logs = logs.slice(-500);
      }
      
      await fs.writeFile(this.auditFile, JSON.stringify(logs, null, 2), 'utf-8');
    } catch {}
  }

  async getAuditLog(limit = 50): Promise<AuditLogEntry[]> {
    try {
      const content = await fs.readFile(this.auditFile, 'utf-8');
      const logs: AuditLogEntry[] = JSON.parse(content);
      return logs.slice(-limit).reverse();
    } catch {
      return [];
    }
  }

  private async cleanExpiredPermissions(): Promise<void> {
    const now = Date.now();
    let changed = false;
    
    for (const [key, perm] of this.grantedPermissions) {
      if (perm.granted && perm.expiresAt && perm.expiresAt < now) {
        perm.granted = false;
        changed = true;
        await this.logAudit({
          id: `expire_${Date.now()}`,
          timestamp: now,
          action: 'expire',
          type: perm.type,
          resource: perm.resource,
          granted: false,
        });
      }
    }
    
    if (changed) {
      await this.saveConfig();
    }
  }

  setAutoGrantDangerous(enabled: boolean): void {
    this.config.autoGrantDangerous = enabled;
    this.saveConfig();
  }

  setAskForPermissions(enabled: boolean): void {
    this.config.askForPermissions = enabled;
    this.saveConfig();
  }

  addTrustedCommand(command: string): void {
    if (!this.config.trustedCommands.includes(command)) {
      this.config.trustedCommands.push(command);
      this.saveConfig();
    }
  }

  addAllowedPath(path: string): void {
    if (!this.config.allowedPaths.includes(path)) {
      this.config.allowedPaths.push(path);
      this.saveConfig();
    }
  }

  addDeniedPath(pathStr: string): void {
    if (!this.config.deniedPaths.includes(pathStr)) {
      this.config.deniedPaths.push(pathStr);
      this.saveConfig();
    }
  }

  grantGroup(groupId: string, expiresInMs?: number): void {
    const group = this.config.groups.find(g => g.id === groupId);
    if (!group) return;

    for (const permType of group.permissions) {
      this.grantPermission(permType, undefined, expiresInMs, groupId);
    }
  }

  revokeGroup(groupId: string): void {
    const group = this.config.groups.find(g => g.id === groupId);
    if (!group) return;

    for (const permType of group.permissions) {
      this.revokePermission(permType);
    }
  }

  getGroups(): PermissionGroup[] {
    return this.config.groups;
  }

  private getPermissionKey(type: PermissionType, resource?: string): string {
    return resource ? `${type}:${resource}` : type;
  }

  isGranted(type: PermissionType, resource?: string): boolean {
    const key = this.getPermissionKey(type, resource);
    
    if (this.config.autoGrantDangerous) {
      return true;
    }

    const globalKey = type;
    const globalPerm = this.grantedPermissions.get(globalKey);
    if (globalPerm?.granted) {
      if (globalPerm.expiresAt && globalPerm.expiresAt < Date.now()) {
        this.grantedPermissions.delete(globalKey);
        return false;
      }
      return true;
    }

    const specificPerm = this.grantedPermissions.get(key);
    if (specificPerm?.granted) {
      if (specificPerm.expiresAt && specificPerm.expiresAt < Date.now()) {
        this.grantedPermissions.delete(key);
        return false;
      }
      return true;
    }

    return false;
  }

  isDangerous(type: PermissionType, resource?: string): boolean {
    const dangerousTypes: PermissionType[] = [
      'command_execute',
      'file_delete',
      'file_move',
      'network_request',
      'browser_automation',
    ];

    if (dangerousTypes.includes(type)) {
      if (type === 'command_execute' && resource) {
        const parts = resource.split(' ');
        const cmd = parts[0] || '';
        if (cmd && this.config.trustedCommands.includes(cmd)) {
          return false;
        }
      }
      return true;
    }

    if (type === 'file_write' || type === 'file_delete') {
      if (resource) {
        for (const denied of this.config.deniedPaths) {
          if (resource.startsWith(denied)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  async requestPermission(
    type: PermissionType,
    resource?: string,
    description?: string
  ): Promise<boolean> {
    if (this.isGranted(type, resource)) {
      await this.logAudit({
        id: `check_${Date.now()}`,
        timestamp: Date.now(),
        action: 'auto_grant',
        type,
        resource,
        granted: true,
        reason: 'already_granted',
      });
      return true;
    }

    if (this.isDangerous(type, resource) && !this.config.autoGrantDangerous) {
      if (!this.config.askForPermissions) {
        await this.logAudit({
          id: `deny_${Date.now()}`,
          timestamp: Date.now(),
          action: 'deny',
          type,
          resource,
          granted: false,
          reason: 'ask_disabled',
        });
        return false;
      }

      const request: PermissionRequest = {
        id: `req_${Date.now()}`,
        type,
        resource,
        description: description || this.getDefaultDescription(type, resource),
        isDangerous: true,
        timestamp: Date.now(),
      };

      this.pendingRequests.push(request);

      for (const listener of this.listeners) {
        const granted = await listener(request);
        if (granted) {
          this.grantPermission(type, resource);
          await this.logAudit({
            id: `grant_${Date.now()}`,
            timestamp: Date.now(),
            action: 'grant',
            type,
            resource,
            granted: true,
          });
          this.pendingRequests = this.pendingRequests.filter(r => r.id !== request.id);
          return true;
        } else {
          await this.logAudit({
            id: `deny_${Date.now()}`,
            timestamp: Date.now(),
            action: 'deny',
            type,
            resource,
            granted: false,
          });
          this.pendingRequests = this.pendingRequests.filter(r => r.id !== request.id);
          return false;
        }
      }

      return false;
    }

    if (!this.isGranted(type, resource)) {
      this.grantPermission(type, resource);
      await this.logAudit({
        id: `auto_${Date.now()}`,
        timestamp: Date.now(),
        action: 'auto_grant',
        type,
        resource,
        granted: true,
        reason: 'non_dangerous',
      });
    }
    return true;
  }

  private getDefaultDescription(type: PermissionType, resource?: string): string {
    const descriptions: Record<PermissionType, string> = {
      file_read: `读取文件: ${resource || '未指定'}`,
      file_write: `写入文件: ${resource || '未指定'}`,
      file_delete: `删除文件: ${resource || '未指定'}`,
      file_copy: `复制文件: ${resource || '未指定'}`,
      file_move: `移动文件: ${resource || '未指定'}`,
      directory_create: `创建目录: ${resource || '未指定'}`,
      directory_list: `列出目录: ${resource || '未指定'}`,
      command_execute: `执行命令: ${resource || '未指定'}`,
      env_read: `读取环境变量: ${resource || '未指定'}`,
      process_list: `查看进程列表`,
      network_request: `发起网络请求: ${resource || '未指定'}`,
      browser_open: `打开浏览器: ${resource || '未指定'}`,
      browser_automation: `自动操作浏览器: ${resource || '未指定'}`,
      mcp_access: `访问 MCP 服务: ${resource || '未指定'}`,
      tool_execute: `执行工具: ${resource || '未指定'}`,
      clipboard_read: `读取剪贴板`,
      clipboard_write: `写入剪贴板`,
    };
    return descriptions[type];
  }

  grantPermission(type: PermissionType, resource?: string, expiresInMs?: number, group?: string): void {
    const key = this.getPermissionKey(type, resource);
    const permission: Permission = {
      type,
      resource,
      granted: true,
      grantedAt: Date.now(),
      expiresAt: expiresInMs ? Date.now() + expiresInMs : undefined,
      group,
    };
    this.grantedPermissions.set(key, permission);
    this.saveConfig();
  }

  revokePermission(type: PermissionType, resource?: string): void {
    const key = this.getPermissionKey(type, resource);
    const perm = this.grantedPermissions.get(key);
    if (perm) {
      perm.granted = false;
      this.saveConfig();
      this.logAudit({
        id: `revoke_${Date.now()}`,
        timestamp: Date.now(),
        action: 'revoke',
        type,
        resource,
        granted: false,
      });
    }
  }

  revokeAll(): void {
    this.grantedPermissions.clear();
    this.saveConfig();
  }

  onPermissionRequest(callback: (request: PermissionRequest) => Promise<boolean>): void {
    this.listeners.push(callback);
  }

  getPendingRequests(): PermissionRequest[] {
    return [...this.pendingRequests];
  }

  getGrantedPermissions(): Permission[] {
    return Array.from(this.grantedPermissions.values()).filter(p => p.granted);
  }

  getConfig(): PermissionConfig {
    return { ...this.config };
  }

  printPermissions(): void {
    console.log(chalk.bold('\n🔐 权限设置\n'));
    
    console.log(`全局设置:`);
    console.log(`  自动授权危险操作: ${chalk[this.config.autoGrantDangerous ? 'green' : 'gray'](this.config.autoGrantDangerous ? '是' : '否')}`);
    console.log(`  询问授权: ${chalk[this.config.askForPermissions ? 'green' : 'gray'](this.config.askForPermissions ? '是' : '否')}`);
    
    console.log(chalk.gray('\n--- 已授权的权限 ---'));
    const granted = this.getGrantedPermissions();
    if (granted.length === 0) {
      console.log(chalk.gray('  暂无'));
    } else {
      for (const perm of granted) {
        const now = Date.now();
        let status: string;
        let statusColor: 'green' | 'yellow' | 'red';
        
        if (!perm.expiresAt) {
          status = '永久';
          statusColor = 'green';
        } else if (perm.expiresAt > now) {
          const remaining = Math.ceil((perm.expiresAt - now) / 60000);
          if (remaining < 60) {
            status = `${remaining}分钟后过期`;
          } else {
            status = `${Math.ceil(remaining / 60)}小时后过期`;
          }
          statusColor = remaining < 10 ? 'red' : 'yellow';
        } else {
          status = '已过期';
          statusColor = 'red';
        }
        
        const groupInfo = perm.group ? ` [${perm.group}]` : '';
        console.log(`  ${chalk.green('✓')} ${perm.type}${perm.resource ? `: ${perm.resource}` : ''}${groupInfo}`);
        console.log(`     ${chalk[statusColor](status)}`);
      }
    }
    
    console.log(chalk.gray('\n--- 权限组 ---'));
    for (const group of this.config.groups) {
      const hasAll = group.permissions.every(p => this.isGranted(p));
      const hasSome = group.permissions.some(p => this.isGranted(p));
      const status = hasAll ? chalk.green('✓') : hasSome ? chalk.yellow('◐') : chalk.gray('○');
      console.log(`  ${status} ${group.name} - ${group.description}`);
    }
    
    console.log(chalk.gray('\n--- 可信命令 ---'));
    console.log(`  ${this.config.trustedCommands.join(', ')}`);
    
    console.log(chalk.gray('\n--- 允许路径 ---'));
    for (const p of this.config.allowedPaths) {
      console.log(`  ${chalk.green('+')} ${p}`);
    }
    
    console.log(chalk.gray('\n--- 禁止路径 ---'));
    for (const p of this.config.deniedPaths) {
      console.log(`  ${chalk.red('-')} ${p}`);
    }
    
    console.log();
  }

  async printAuditLog(limit = 20): Promise<void> {
    const logs = await this.getAuditLog(limit);
    
    console.log(chalk.bold('\n📋 权限审计日志\n'));
    
    if (logs.length === 0) {
      console.log(chalk.gray('  暂无记录'));
    } else {
      for (const log of logs) {
        const time = new Date(log.timestamp).toLocaleString();
        const actionColor = log.granted ? 'green' : 'red';
        const actionText = log.action === 'grant' ? '授权' : 
                          log.action === 'deny' ? '拒绝' : 
                          log.action === 'revoke' ? '撤销' : 
                          log.action === 'expire' ? '过期' : '自动';
        
        console.log(`${chalk.gray(time)} ${chalk[actionColor](actionText.padEnd(4))} ${log.type}${log.resource ? ` (${log.resource})` : ''}`);
      }
    }
    console.log();
  }

  showPermissionRequest(request: PermissionRequest): string {
    const warning = request.isDangerous ? chalk.yellow('⚠️ 危险操作') : '';
    
    let msg = `\n${chalk.bold('🔐 权限请求')}\n\n`;
    msg += `${warning}\n`;
    msg += `操作类型: ${chalk.cyan(request.type)}\n`;
    if (request.resource) {
      msg += `资源: ${chalk.cyan(request.resource)}\n`;
    }
    msg += `说明: ${request.description}\n`;
    msg += `\n输入:\n`;
    msg += `  ${chalk.green('yes')}  - 授权本次\n`;
    msg += `  ${chalk.green('all')}  - 永久授权此类操作\n`;
    msg += `  ${chalk.cyan('10m')} - 授权10分钟\n`;
    msg += `  ${chalk.cyan('1h')}  - 授权1小时\n`;
    msg += `  ${chalk.cyan('24h')} - 授权24小时\n`;
    msg += `  ${chalk.red('no')}  - 拒绝\n`;
    
    return msg;
  }

  parsePermissionAnswer(answer: string): { granted: boolean; expiresInMs?: number; permanent?: boolean } {
    const lower = answer.toLowerCase().trim();
    
    if (lower === 'yes' || lower === 'y') {
      return { granted: true };
    }
    
    if (lower === 'all') {
      return { granted: true, permanent: true };
    }
    
    if (lower === 'no' || lower === 'n') {
      return { granted: false };
    }
    
    const timeMatch = lower.match(/^(\d+)(m|min|h|hour|d|day)s?$/);
    if (timeMatch && timeMatch[1] && timeMatch[2]) {
      const value = parseInt(timeMatch[1]);
      const unit = timeMatch[2];
      
      let ms: number;
      if (unit === 'm' || unit === 'min') {
        ms = value * 60 * 1000;
      } else if (unit === 'h' || unit === 'hour') {
        ms = value * 60 * 60 * 1000;
      } else if (unit === 'd' || unit === 'day') {
        ms = value * 24 * 60 * 60 * 1000;
      } else {
        return { granted: false };
      }
      
      return { granted: true, expiresInMs: ms };
    }
    
    return { granted: false };
  }
}

export const permissionManager = new PermissionManager();
