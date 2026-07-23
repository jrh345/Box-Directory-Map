const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const vercelConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'vercel.json'), 'utf8'));

test('vercel config uses functions (not builds)', () => {
  assert.ok(vercelConfig.functions && typeof vercelConfig.functions === 'object', 'expected functions config');
  assert.equal(vercelConfig.builds, undefined, 'builds must be omitted when functions is present');
});

test('tree-data function includes sqlite files', () => {
  const treeDataFn = vercelConfig.functions['api/tree-data.js'];
  assert.ok(treeDataFn, 'expected api/tree-data.js function config');
  assert.equal(treeDataFn.includeFiles, 'data/**');
});
