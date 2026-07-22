const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const vercelConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'vercel.json'), 'utf8'));

test('vercel config rewrites the root to index.html', () => {
  assert.ok(Array.isArray(vercelConfig.rewrites), 'expected rewrites array');
  const rootRewrite = vercelConfig.rewrites.find((entry) => entry.source === '/(.*)');
  assert.ok(rootRewrite, 'expected a root rewrite');
  assert.equal(rootRewrite.destination, '/index.html');
});

test('vercel config routes API paths to API handlers', () => {
  const apiRewrite = vercelConfig.rewrites.find((entry) => entry.source === '/api/(.*)');
  assert.ok(apiRewrite, 'expected an API rewrite');
  assert.equal(apiRewrite.destination, '/api/$1');
});
