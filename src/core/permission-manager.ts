import { promises as fs } from 'fs';
import * as path from 'path';
import chalk from 'chalk';

export type PermissionType = 
  | 'file_read'
  | 'file_write'
  | 'file_delete'
  | 'command_execute'
  | 'network_request'
  | 'browser_open'
  | 'mcp_access'
  | 'tool_execute';

export interface Permission {
  type: PermissionType;
  resource?: string;
  granted: boolean;
  grantedAt?: number;
  expiresAt?: number;
}

export interface PermissionConfig {
  autoGrantDangerous: boolean;
  askForPermissions: boolean;
  trustedCommands: string[];
  allowedPaths: string[];
  deniedPaths: string[];
}

export interface PermissionRequest {
  id: string;
  type: PermissionType;
  resource?: string;
  description: string;
  isDangerous: boolean;
  timestamp: number;
}

export class PermissionManager {
  private config: PermissionConfig;
  private grantedPermissions: Map<string, Permission> = new Map();
  private pendingRequests: PermissionRequest[] = [];
  private configDir: string;
  private configFile: string;
  private listeners: ((request: PermissionRequest) => Promise<boolean>)[] = [];

  constructor(configDir?: string) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || process.cwd();
    this.configDir = configDir || path.join(homeDir, '.ai-agent-cli', 'permissions');
    this.configFile = path.join(this.configDir, 'config.json');
    
    this.config = {
      autoGrantDangerous: false,
      askForPermissions: true,
      trustedCommands: ['git', 'npm', 'node', 'tsx', 'tsc', 'python'],
      allowedPaths: [process.cwd(), path.join(homeDir, 'projects')],
      deniedPaths: ['/etc', '/sys', '/root', '/var'],
    };
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true });
    await this.loadConfig();
  }

  private async loadConfig(): Promise<void> {
    try {
      const content = await fs.readFile(this.configFile, 'utf-8');
      const saved = JSON.parse(content);
      this.config = { ...this.config, ...saved };
      
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
        return false;
      }
      return true;
    }

    const specificPerm = this.grantedPermissions.get(key);
    if (specificPerm?.granted) {
      if (specificPerm.expiresAt && specificPerm.expiresAt < Date.now()) {
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
      'network_request',
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
      return true;
    }

    if (this.isDangerous(type, resource) && !this.config.autoGrantDangerous) {
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
          this.pendingRequests = this.pendingRequests.filter(r => r.id !== request.id);
          return true;
        } else {
          this.pendingRequests = this.pendingRequests.filter(r => r.id !== request.id);
          return false;
        }
      }

      return false;
    }

    this.grantPermission(type, resource);
    return true;
  }

  private getDefaultDescription(type: PermissionType, resource?: string): string {
    const descriptions: Record<PermissionType, string> = {
      file_read: `读取文件: ${resource || '未指定'}`,
      file_write: `写入文件: ${resource || '未指定'}`,
      file_delete: `删除文件: ${resource || '未指定'}`,
      command_execute: `执行命令: ${resource || '未指定'}`,
      network_request: `发起网络请求: ${resource || '未指定'}`,
      browser_open: `打开浏览器: ${resource || '未指定'}`,
      mcp_access: `访问 MCP 服务: ${resource || '未指定'}`,
      tool_execute: `执行工具: ${resource || '未指定'}`,
    };
    return descriptions[type];
  }

  grantPermission(type: PermissionType, resource?: string, expiresInMs?: number): void {
    const key = this.getPermissionKey(type, resource);
    const permission: Permission = {
      type,
      resource,
      granted: true,
      grantedAt: Date.now(),
      expiresAt: expiresInMs ? Date.now() + expiresInMs : undefined,
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
    
    console.log(chalk.gray('\n已授权的权限:'));
    const granted = this.getGrantedPermissions();
    if (granted.length === 0) {
      console.log(chalk.gray('  暂无'));
    } else {
      for (const perm of granted) {
        const status = perm.expiresAt ? 
          (perm.expiresAt > Date.now() ? '有效' : '已过期') : 
          '永久';
        console.log(`  ${chalk.green('✓')} ${perm.type}${perm.resource ? `: ${perm.resource}` : ''} ${chalk.gray(`(${status})`)}`);
      }
    }
    
    console.log(chalk.gray('\n可信命令:'));
    console.log(`  ${this.config.trustedCommands.join(', ')}`);
    
    console.log(chalk.gray('\n允许路径:'));
    for (const p of this.config.allowedPaths) {
      console.log(`  ${chalk.green('+')} ${p}`);
    }
    
    console.log(chalk.gray('\n禁止路径:'));
    for (const p of this.config.deniedPaths) {
      console.log(`  ${chalk.red('-')} ${p}`);
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
    msg += `说明: ${request.description}\n\n`;
    msg += `输入 ${chalk.green('yes')} 授权, ${chalk.red('no')} 拒绝, ${chalk.cyan('all')} 授权所有此类操作\n`;
    
    return msg;
  }
}

export const permissionManager = new PermissionManager();
