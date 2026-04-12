#!/usr/bin/env node

import { spawn, spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'fs';
import os from 'os';
import { parse } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const args = process.argv.slice(2);

function showBanner() {
  console.log(`
╔═══════════════════════════════════════════════════╗
║              AI Agent CLI v1.0.0                 ║
║   Type /? for commands, or ask me anything!       ║
╚═══════════════════════════════════════════════════╝
`);
}

function getDefaultAppBaseDir() {
  return join(os.homedir(), '.ai-agent-cli');
}

function getDefaultConfigPath() {
  return join(getDefaultAppBaseDir(), 'config.yaml');
}

function loadRuntimeConfig() {
  const configPath = getDefaultConfigPath();
  let parsed = null;

  try {
    parsed = parse(readFileSync(configPath, 'utf8'));
  } catch {
    parsed = null;
  }

  return {
    configPath,
    appBaseDir: typeof parsed?.appBaseDir === 'string' && parsed.appBaseDir.trim()
      ? parsed.appBaseDir.trim()
      : getDefaultAppBaseDir(),
    workspace: typeof parsed?.workspace === 'string' && parsed.workspace.trim()
      ? parsed.workspace.trim()
      : undefined,
  };
}

function getDaemonPaths() {
  const runtime = loadRuntimeConfig();
  const runtimeDir = join(runtime.appBaseDir, 'runtime');
  return {
    ...runtime,
    runtimeDir,
    statePath: join(runtimeDir, 'daemon.json'),
    logPath: join(runtimeDir, 'daemon.log'),
  };
}

function readDaemonState() {
  const paths = getDaemonPaths();

  try {
    const state = JSON.parse(readFileSync(paths.statePath, 'utf8'));
    if (!state || typeof state.pid !== 'number' || state.pid <= 0) {
      return { paths, state: null };
    }

    return { paths, state };
  } catch {
    return { paths, state: null };
  }
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    sleep(200);
  }

  return !isProcessRunning(pid);
}

function clearDaemonState(statePath) {
  try {
    rmSync(statePath, { force: true });
  } catch {
  }
}

function stopDaemon() {
  const { paths, state } = readDaemonState();

  if (!state || !isProcessRunning(state.pid)) {
    clearDaemonState(paths.statePath);
    return { stopped: false, pid: state?.pid || 0 };
  }

  try {
    process.kill(state.pid, 'SIGTERM');
  } catch {
    clearDaemonState(paths.statePath);
    return { stopped: false, pid: state.pid };
  }

  if (!waitForExit(state.pid, 4000)) {
    try {
      process.kill(state.pid, 'SIGKILL');
    } catch {
    }
    waitForExit(state.pid, 1500);
  }

  clearDaemonState(paths.statePath);
  return { stopped: true, pid: state.pid };
}

function startDaemon() {
  const scriptInfo = findScriptPath();
  if (!scriptInfo) {
    console.error('Error: Cannot find script. Please run: npm install && npm run build');
    process.exit(1);
  }

  const { configPath, runtimeDir, workspace } = getDaemonPaths();
  mkdirSync(runtimeDir, { recursive: true });

  const nodeArgs = scriptInfo.isTs
    ? ['--import', 'tsx', scriptInfo.path, '--daemon-service']
    : [scriptInfo.path, '--daemon-service'];

  if (existsSync(configPath)) {
    nodeArgs.push('--config', configPath);
  }

  if (workspace) {
    nodeArgs.push('--workspace', workspace);
  }

  const child = spawn(process.execPath, nodeArgs, {
    cwd: workspace || process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      AI_AGENT_CLI_DAEMON: '1',
    },
    windowsHide: true,
  });

  child.unref();
  return { pid: child.pid || 0 };
}

function collectProcessStatus() {
  if (process.platform === 'win32') {
    const script = [
      '$matches = Get-CimInstance Win32_Process | Where-Object {',
      "  $_.Name -eq 'node.exe' -and (",
      "    $_.CommandLine -match 'ai-agent-cli' -or",
      "    $_.CommandLine -match 'dist[\\/]+cli[\\/]+index\\.js' -or",
      "    $_.CommandLine -match 'src[\\/]+cli[\\/]+index\\.ts' -or",
      "    $_.CommandLine -match 'daemon-service' -or",
      "    $_.CommandLine -match 'lark-bridge'",
      '  )',
      '}',
      'if (-not $matches) {',
      '  Write-Output "coolAI 后台未检测到相关进程。"',
      '  exit 0',
      '}',
      '$matches | Select-Object ProcessId, ParentProcessId, @{Name="Role";Expression={',
      '  if ($_.CommandLine -match "--daemon-service") { "daemon" }',
      '  elseif ($_.CommandLine -match "lark-bridge") { "bridge" }',
      '  elseif ($_.CommandLine -match "src[\\/]+cli[\\/]+index\\.ts|dist[\\/]+cli[\\/]+index\\.js") { "cli" }',
      '  else { "node" }',
      '}}, CommandLine | Format-Table -AutoSize | Out-String -Width 220',
    ].join('\n');

    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (result.error) {
      return {
        ok: false,
        stdout: '',
        stderr: `Failed to inspect coolAI processes: ${result.error.message}`,
      };
    }

    return {
      ok: (result.status ?? 0) === 0,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }

  const script = [
    "ps -ax -o pid=,ppid=,command= | grep -E 'ai-agent-cli|dist/cli/index.js|src/cli/index.ts|daemon-service|lark-bridge' | grep -v grep",
  ].join(' ');
  const result = spawnSync('sh', ['-lc', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    return {
      ok: false,
      stdout: '',
      stderr: `Failed to inspect coolAI processes: ${result.error.message}`,
    };
  }

  return {
    ok: true,
    stdout: result.stdout?.trim() ? result.stdout : 'coolAI 后台未检测到相关进程。\n',
    stderr: result.stderr || '',
  };
}

function showProcessStatus(jsonMode = false) {
  const processStatus = collectProcessStatus();
  const { paths, state } = readDaemonState();
  const running = Boolean(state?.pid && isProcessRunning(state.pid));
  const payload = {
    running,
    pid: running ? state.pid : 0,
    startedAt: running ? state.startedAt || 0 : 0,
    logFile: state?.logFile || paths.logPath,
    configPath: state?.configPath || paths.configPath,
    workspace: state?.workspace || paths.workspace || null,
    cronSchedulerRunning: typeof state?.cronSchedulerRunning === 'boolean' ? state.cronSchedulerRunning : null,
    mcpServers: Array.isArray(state?.mcpServers) ? state.mcpServers : [],
    lspServers: Array.isArray(state?.lspServers) ? state.lspServers : [],
    processTable: processStatus.stdout.trimEnd(),
  };

  if (jsonMode) {
    console.log(JSON.stringify(payload, null, 2));
    process.exit(processStatus.ok ? 0 : 1);
  }

  if (processStatus.stderr?.trim()) {
    console.error(processStatus.stderr.trimEnd());
  }

  console.log(processStatus.stdout.trimEnd());
  console.log('');
  console.log(`Daemon state file: ${paths.statePath}`);
  console.log(`Log file: ${payload.logFile}`);
  console.log(`Config: ${payload.configPath}`);
  console.log(`Workspace: ${payload.workspace || '(none)'}`);
  process.exit(processStatus.ok ? 0 : 1);
}

function findScriptPath() {
  const distPath = join(__dirname, '..', 'dist', 'cli', 'index.js');
  const srcPath = join(__dirname, '..', 'src', 'cli', 'index.ts');

  if (existsSync(distPath) && existsSync(srcPath)) {
    const distStat = statSync(distPath);
    const srcStat = statSync(srcPath);
    if (srcStat.mtimeMs > distStat.mtimeMs) {
      return { path: srcPath, isTs: true };
    }
    return { path: distPath, isTs: false };
  }

  if (existsSync(distPath)) {
    return { path: distPath, isTs: false };
  }

  if (existsSync(srcPath)) {
    return { path: srcPath, isTs: true };
  }
  
  return null;
}

if (args[0] === 'status' || args[0] === 'ps') {
  showProcessStatus(args.includes('--json'));
} else if (args[0] === 'start') {
  const { state } = readDaemonState();
  if (state?.pid && isProcessRunning(state.pid)) {
    console.log(`coolAI 后台 daemon 已在运行 (pid=${state.pid})`);
    process.exit(0);
  }

  const result = startDaemon();
  console.log(result.pid ? `coolAI 后台 daemon 已启动 (pid=${result.pid})` : 'coolAI 后台 daemon 已启动');
  process.exit(0);
} else if (args[0] === 'stop') {
  const result = stopDaemon();
  console.log(result.stopped ? `coolAI 后台 daemon 已停止 (pid=${result.pid})` : 'coolAI 后台 daemon 当前未运行。');
  process.exit(0);
} else if (args[0] === 'restart') {
  const stopped = stopDaemon();
  const started = startDaemon();
  console.log(stopped.stopped
    ? `coolAI 后台 daemon 已重启 (oldPid=${stopped.pid}, newPid=${started.pid || 'unknown'})`
    : `coolAI 后台 daemon 已启动 (pid=${started.pid || 'unknown'})`);
  process.exit(0);
} else if (args.length === 0 || args[0] === 'run' || args[0] === 'chat') {
  showBanner();
  
  const scriptInfo = findScriptPath();
  
  if (!scriptInfo) {
    console.error('Error: Cannot find script. Please run: npm install && npm run build');
    process.exit(1);
  }
  
  const nodePath = process.execPath;
  let nodeArgs;
  
  if (scriptInfo.isTs) {
    nodeArgs = ['--import', 'tsx', scriptInfo.path];
  } else {
    nodeArgs = [scriptInfo.path];
  }
  
  if (args[0] === 'run' || args[0] === 'chat') {
    nodeArgs.push(...args.slice(1));
  }
  
  console.log(`\n\x1b[36mRunning from: ${scriptInfo.isTs ? 'source' : 'dist'}\x1b[0m\n`);
  
  const child = spawn(nodePath, nodeArgs, {
    stdio: 'inherit',
    env: { ...process.env },
    cwd: process.cwd(),
  });
  
  child.on('exit', (code) => {
    process.exit(code || 0);
  });
  
  child.on('error', (err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
} else if (args[0] === '--help' || args[0] === '-h') {
  console.log(`
AI Agent CLI - Your intelligent AI assistant

Usage:
  ai                 Start interactive CLI
  ai run [model]     Start with specific model
  coolAI status      Show coolAI background processes
  coolAI start       Start coolAI background daemon
  coolAI stop        Stop coolAI background daemon
  coolAI restart     Restart coolAI background daemon
  ai run --help      Show this help

Commands in CLI:
  /?          Show this help
  /help       Show all commands
  /q          Exit current shell, keep background daemon running
  /exit       Stop background daemon and exit completely
  /tools      List available tools
  /model      Show/change model
  /config     Show configuration
  /skill      Manage skills
  /mcp        Manage MCP servers
  /lsp        Manage LSP servers

Configuration:
  Config file: ~/.ai-agent-cli/config.yaml
  Skills dir:  ~/.ai-agent-cli/skills/

Examples:
  ai                      Start CLI
  ai run llama3.2         Start with specific model
  coolAI status           Inspect daemon and bridge processes
  coolAI status --json    Show daemon status as JSON
  coolAI stop             Stop background daemon
  ai run --config my.yaml Start with custom config
`);
} else {
  console.error(`Unknown command: ${args[0]}`);
  console.error('Run "ai --help" for usage information.');
  process.exit(1);
}
