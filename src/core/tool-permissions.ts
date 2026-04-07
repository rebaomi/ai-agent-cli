import type { PermissionType } from './permission-manager.js';

export interface ToolPermissionMapping {
  toolPattern: RegExp;
  permissionType: PermissionType;
  resourceExtractor?: (args: Record<string, unknown>) => string | undefined;
}

const toolPermissionMappings: ToolPermissionMapping[] = [
  {
    toolPattern: /^read_file$/,
    permissionType: 'file_read',
    resourceExtractor: (args) => args.path as string | undefined,
  },
  {
    toolPattern: /^write_file$/,
    permissionType: 'file_write',
    resourceExtractor: (args) => args.path as string | undefined,
  },
  {
    toolPattern: /^edit_file$/,
    permissionType: 'file_write',
    resourceExtractor: (args) => args.filePath as string | undefined,
  },
  {
    toolPattern: /^delete_file$/,
    permissionType: 'file_delete',
    resourceExtractor: (args) => args.path as string | undefined,
  },
  {
    toolPattern: /^copy_file$/,
    permissionType: 'file_copy',
    resourceExtractor: (args) => args.source as string | undefined,
  },
  {
    toolPattern: /^move_file$/,
    permissionType: 'file_move',
    resourceExtractor: (args) => args.source as string | undefined,
  },
  {
    toolPattern: /^list_directory$/,
    permissionType: 'directory_list',
    resourceExtractor: (args) => args.path as string | undefined,
  },
  {
    toolPattern: /^create_directory$/,
    permissionType: 'directory_create',
    resourceExtractor: (args) => args.path as string | undefined,
  },
  {
    toolPattern: /^execute_command$/,
    permissionType: 'command_execute',
    resourceExtractor: (args) => args.command as string | undefined,
  },
  {
    toolPattern: /^grep$/,
    permissionType: 'file_read',
    resourceExtractor: (args) => args.path as string | undefined,
  },
  {
    toolPattern: /^glob$/,
    permissionType: 'directory_list',
    resourceExtractor: (args) => args.path as string | undefined,
  },
  {
    toolPattern: /^web_search$/,
    permissionType: 'network_request',
  },
  {
    toolPattern: /^fetch_url$/,
    permissionType: 'network_request',
    resourceExtractor: (args) => args.url as string | undefined,
  },
  {
    toolPattern: /^open_browser$/,
    permissionType: 'browser_open',
    resourceExtractor: (args) => args.url as string | undefined,
  },
  {
    toolPattern: /^get_current_time$/,
    permissionType: 'tool_execute',
  },
  {
    toolPattern: /^calculate$/,
    permissionType: 'tool_execute',
  },
  {
    toolPattern: /^file_info$/,
    permissionType: 'file_read',
    resourceExtractor: (args) => args.path as string | undefined,
  },
  {
    toolPattern: /^(agent_send_message|task_create|task_get_list|task_update|task_stop|task_output|team_create|team_delete|list_peers|todo_write|cron_create|cron_delete|cron_list|config|skill_config)$/,
    permissionType: 'tool_execute',
  },
  {
    toolPattern: /^(mcp_list|mcp_resources|read_mcp_resource|mcp_auth)$/,
    permissionType: 'mcp_access',
    resourceExtractor: (args) => (args.server as string | undefined) || (args.uri as string | undefined),
  },
];

export interface PermissionCheck {
  allowed: boolean;
  permissionType?: PermissionType;
  resource?: string;
  reason?: string;
}

export function getToolPermission(toolName: string): { permissionType: PermissionType; resourceExtractor?: (args: Record<string, unknown>) => string | undefined } | null {
  for (const mapping of toolPermissionMappings) {
    if (mapping.toolPattern.test(toolName)) {
      return {
        permissionType: mapping.permissionType,
        resourceExtractor: mapping.resourceExtractor,
      };
    }
  }
  
  if (toolName.includes('_')) {
    const parts = toolName.split('_');
    const server = parts[0];
    if (server && parts.length > 1) {
      return {
        permissionType: 'mcp_access',
        resourceExtractor: () => server,
      };
    }
  }
  
  return null;
}

export function extractResource(toolName: string, args: Record<string, unknown>): string | undefined {
  const mapping = getToolPermission(toolName);
  if (mapping?.resourceExtractor) {
    return mapping.resourceExtractor(args);
  }
  return undefined;
}
