import chalk from 'chalk';

export const APP_VERSION = '1.3.0';

export function buildCliLogo(): string {
  return `
╔═══════════════════════════════════════════════════╗
║           AI Agent CLI v${APP_VERSION}                     ║
║   Your intelligent coding assistant                 ║
╚═══════════════════════════════════════════════════╝
`;
}

export function getQuickHelpText(): string {
  return `
${chalk.bold('Quick Commands:')}
  ${chalk.cyan('/?')}        ${chalk.gray('Show this help')}
  ${chalk.cyan('/q')}        ${chalk.gray('Exit this CLI, keep background daemon running')}
  ${chalk.cyan('/exit')}     ${chalk.gray('Stop background daemon and exit completely')}
  ${chalk.cyan('/tools')}    ${chalk.gray('List tools')}
  ${chalk.cyan('/news')}     ${chalk.gray('Tencent news shortcuts')}
  ${chalk.cyan('/browser')}  ${chalk.gray('Open or automate browser pages')}
  ${chalk.cyan('/mode')}     ${chalk.gray('Switch active input source: cli or feishu')}
  ${chalk.cyan('/split')}    ${chalk.gray('Toggle split view for output/process panes')}
  ${chalk.cyan('/relay')}    ${chalk.gray('Show/reconnect Lark relay')}
  ${chalk.cyan('/config')}   ${chalk.gray('Show/reload/edit config')}
  ${chalk.cyan('/model')}    ${chalk.gray('Show/change model')}
  ${chalk.cyan('/sessions')} ${chalk.gray('Show sessions')}
  ${chalk.cyan('/cron')}     ${chalk.gray('Manage cron jobs')}
  ${chalk.cyan('/daemon')}   ${chalk.gray('Show/control background daemon')}
  ${chalk.cyan('/reset')}    ${chalk.gray('Clear chat')}
`;
}

export function getFullHelpText(): string {
  return `
${chalk.bold('Available Commands:')}

${chalk.cyan('/?, /？')}           Show quick help
${chalk.cyan('/help, /h')}         Show full help
${chalk.cyan('/q, /quit, /bye')}   Exit current CLI only, keep background daemon running
${chalk.cyan('/exit')}             Stop background daemon and exit completely
${chalk.cyan('/clear, /cls')}      Clear the screen
${chalk.cyan('/history, /hi')}      Show command history
${chalk.cyan('/tools, /t')}        List available tools
${chalk.cyan('/config, /c')}       Show current configuration
${chalk.cyan('/config edit')}       Open terminal editor for config file (/save, /q)
${chalk.cyan('/config update')}     Reload config from file and refresh runtime
${chalk.cyan('/config reload')}     Alias of /config update
${chalk.cyan('/mode status')}       Show current input mode and relay status
${chalk.cyan('/mode switch')} <name> Switch active input source (cli or feishu)
${chalk.cyan('/split status')}      Show split view status
${chalk.cyan('/split on')}          Enable split view: left=result, right=process
${chalk.cyan('/split off')}         Disable split view
${chalk.cyan('/relay status')}      Show relay status and subscribe occupancy
${chalk.cyan('/relay start')}       Start current relay if config allows it
${chalk.cyan('/relay stop')}        Stop only the current CLI relay
${chalk.cyan('/relay reconnect')}   Confirm and reconnect current relay
${chalk.cyan('/model, /m')} [name]     Show or change model
${chalk.cyan('/model switch')} <name> Switch default provider (deepseek 会启用 chat/reasoner 自动路由)
${chalk.cyan('/workspace, /w')}    Show or change workspace
${chalk.cyan('/reset, /r')}        Reset conversation
${chalk.cyan('/new')}              Create new session (archive old)
${chalk.cyan('/wipe')}             Reset user data (restart onboarding)
${chalk.cyan('/sessions')}         List conversation sessions
${chalk.cyan('/load')} <id>        Load a previous session
${chalk.cyan('/mcp')}              Manage MCP servers
${chalk.cyan('/lsp')}              Manage LSP servers
${chalk.cyan('/skill')}            Manage skills
${chalk.cyan('/news')}             Tencent news shortcuts (hot/search/morning/evening)
${chalk.cyan('/browser')}          Open or automate browser pages
${chalk.cyan('/cron')}             Manage cron jobs
${chalk.cyan('/daemon')}           Show/control background daemon
${chalk.cyan('/org, /team')}        Manage organization/team (view, load, mode)
`;
}

export function isQuickHelpShortcut(value?: string | null): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '/?' || normalized === '/？';
}

export function isFullHelpShortcut(value?: string | null): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === '/help' || normalized === '/h';
}