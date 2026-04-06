#!/usr/bin/env node

import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

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

function findScriptPath() {
  const distPath = join(__dirname, '..', 'dist', 'cli', 'index.js');
  const srcPath = join(__dirname, '..', 'src', 'cli', 'index.ts');
  
  if (existsSync(distPath)) {
    return { path: distPath, isTs: false };
  }
  
  if (existsSync(srcPath)) {
    return { path: srcPath, isTs: true };
  }
  
  return null;
}

if (args.length === 0 || args[0] === 'run' || args[0] === 'chat') {
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
AI Agent CLI - Your intelligent coding assistant

Usage:
  ai                 Start interactive CLI
  ai run [model]     Start with specific model
  ai run --help      Show this help

Commands in CLI:
  /?          Show this help
  /help       Show all commands
  /quit       Exit
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
  ai run --config my.yaml Start with custom config
`);
} else {
  console.error(`Unknown command: ${args[0]}`);
  console.error('Run "ai --help" for usage information.');
  process.exit(1);
}
