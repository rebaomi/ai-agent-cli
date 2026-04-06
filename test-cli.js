console.log('Starting CLI test...');

import('./dist/cli/index.js').catch(err => {
  console.error('Import error:', err);
});
