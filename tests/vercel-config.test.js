const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const vercelConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'vercel.json'), 'utf8'));

test('vercel config uses builds (not functions)', () => {
  assert.ok(Array.isArray(vercelConfig.builds), 'expected builds config');
  assert.equal(vercelConfig.functions, undefined, 'functions must be omitted when builds is present');
});

test('tree-data build includes sqlite files', () => {
  const treeDataBuild = vercelConfig.builds.find((entry) => entry.src === 'api/tree-data.js');
  assert.ok(treeDataBuild, 'expected api/tree-data.js build config');
  assert.equal(treeDataBuild.config?.includeFiles, 'data/**');
});

test('vercel config routes root to index.html', () => {
  assert.ok(Array.isArray(vercelConfig.routes), 'expected routes array');
  const rootRoute = vercelConfig.routes.find((entry) => entry.src === '/(.*)');
  assert.ok(rootRoute, 'expected root route');
  assert.equal(rootRoute.dest, '/index.html');
});
