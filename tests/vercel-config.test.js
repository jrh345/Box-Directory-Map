const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const vercelConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, 'vercel.json'), 'utf8'));

test('vercel config serves index.html for the app root', () => {
  assert.ok(Array.isArray(vercelConfig.routes), 'expected routes array');
  const rootRoute = vercelConfig.routes.find((entry) => entry.src === '/(.*)');
  assert.ok(rootRoute, 'expected a root route');
  assert.equal(rootRoute.dest, '/index.html');
});

test('vercel config routes API paths to the API handlers', () => {
  const apiRoute = vercelConfig.routes.find((entry) => entry.src === '/api/(.*)');
  assert.ok(apiRoute, 'expected an API route');
  assert.equal(apiRoute.dest, '/api/$1');
});
