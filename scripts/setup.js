#!/usr/bin/env node

import { spawn, execSync } from 'child_process';
import { existsSync, chmodSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';

console.log('\n========================================');
console.log('  coolAI Setup Script');
console.log('========================================\n');

function run(command, args = []) {
  return new Promise((resolve, reject) => {
    console.log(`> ${command} ${args.join(' ')}`);
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: isWindows,
    });
    child.on('close', (code) => {
      if (code === 0) resolve(code);
      else reject(new Error(`Command failed with code ${code}`));
    });
    child.on('error', reject);
  });
}

async function main() {
  try {
    console.log('[1/4] Checking Node.js...');
    try {
      execSync('node --version', { stdio: 'pipe' });
      console.log('  ✓ Node.js found');
    } catch {
      console.error('  ✗ Node.js not found. Please install from https://nodejs.org');
      process.exit(1);
    }

    console.log('\n[2/4] Installing dependencies...');
    await run('npm', ['install']);

    console.log('\n[3/4] Building TypeScript...');
    await run('npm', ['run', 'build']);

    console.log('\n[4/4] Creating global command...');
    try {
      await run('npm', ['link']);
    } catch {
      console.log('  Note: Run "sudo npm link" manually if this failed');
    }

    console.log('\n========================================');
    console.log('  Setup Complete!');
    console.log('========================================\n');
    console.log('Run "coolAI" to start the application.\n');

    if (!existsSync(join(__dirname, '..', 'dist'))) {
      console.log('⚠️  dist folder not found. Please check if build succeeded.');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n✗ Setup failed:', error.message);
    process.exit(1);
  }
}

main();
