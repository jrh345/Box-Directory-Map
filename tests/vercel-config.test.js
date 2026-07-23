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
  const apiBuild = vercelConfig.builds.find((entry) => entry.src === 'api/**/*.js');
  assert.ok(apiBuild, 'expected api/**/*.js build config');
  assert.equal(apiBuild.config?.includeFiles, 'data/**');
});

test('vercel config routes root to index.html', () => {
  assert.ok(Array.isArray(vercelConfig.routes), 'expected routes array');
  const rootRoute = vercelConfig.routes.find((entry) => entry.src === '/(.*)');
  assert.ok(rootRoute, 'expected root route');
  assert.equal(rootRoute.dest, '/index.html');
});

test('vercel config routes api paths to .js files', () => {
  const apiRoute = vercelConfig.routes.find((entry) => entry.src === '/api/(.*)');
  assert.ok(apiRoute, 'expected api route');
  assert.equal(apiRoute.dest, '/api/$1.js');
});
