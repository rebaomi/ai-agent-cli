import { runCLI } from './dist/cli/index.js';

console.log('Starting...');
runCLI().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
