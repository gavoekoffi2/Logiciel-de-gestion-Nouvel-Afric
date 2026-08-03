const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync(require.resolve('../src/app'), 'utf8');

test('the public root serves the company landing while agency login stays isolated', () => {
  assert.match(source, /sendFile\(path\.join\(PUBLIC_DIR, 'landing\.html'\)\)/);
  assert.match(source, /app\.get\('\/e\/:slug', \(req, res\) => res\.sendFile\(path\.join\(PUBLIC_DIR, 'login\.html'\)\)\)/);
});
