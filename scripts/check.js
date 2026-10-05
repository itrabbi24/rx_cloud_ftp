// Fast sanity checks run locally (npm run check) and in CI:
//  - every JavaScript file parses
//  - the server modules load without throwing
//  - launcher/LauncherGui.cs is pure ASCII (the C# 5 compiler reads BOM-less
//    files in the system code page and mangles anything else)
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
let failed = 0;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'vendor' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js') && entry.name !== 'assets-bundle.js') out.push(full);
  }
  return out;
}

for (const file of walk(root)) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    failed++;
    console.error(`[check] syntax error in ${path.relative(root, file)}\n${res.stderr}`);
  }
}

try {
  require(path.join(root, 'src', 'permissions.js'));
  require(path.join(root, 'src', 'server.js'));
} catch (err) {
  failed++;
  console.error(`[check] server modules failed to load: ${err.message}`);
}

const gui = fs.readFileSync(path.join(root, 'launcher', 'LauncherGui.cs'));
const nonAscii = gui.filter(b => b > 127).length;
if (nonAscii) {
  failed++;
  console.error(`[check] launcher/LauncherGui.cs contains ${nonAscii} non-ASCII byte(s); use \\uXXXX escapes instead.`);
}

if (failed) {
  console.error(`[check] ${failed} problem(s) found`);
  process.exit(1);
}
console.log('[check] all checks passed');
process.exit(0);
