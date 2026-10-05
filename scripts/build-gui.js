// Compiles the Windows launcher (launcher/LauncherGui.cs) into dist/RxCloude.exe
// with the server engine embedded as a resource. Uses the C# compiler that
// ships with the .NET Framework 4.x, so no Visual Studio is needed.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const windir = process.env.WINDIR || 'C:\\Windows';
const candidates = [
  path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];
const csc = candidates.find(p => fs.existsSync(p));
if (!csc) {
  console.error('[gui] csc.exe not found. Install the .NET Framework 4.x (included in Windows 10/11).');
  process.exit(1);
}

const engine = path.join(root, 'dist', 'RxCloudeEngine.exe');
if (!fs.existsSync(engine)) {
  console.error('[gui] dist/RxCloudeEngine.exe is missing. Run "npm run build:engine" first.');
  process.exit(1);
}

const args = [
  '/nologo',
  '/target:winexe',
  `/win32icon:${path.join(root, 'assets', 'app.ico')}`,
  `/resource:${engine},RxCloude.Engine.exe`,
  `/out:${path.join(root, 'dist', 'RxCloude.exe')}`,
  path.join(root, 'launcher', 'LauncherGui.cs'),
];

const result = spawnSync(csc, args, { stdio: 'inherit' });
if (result.status !== 0) {
  console.error('[gui] compilation failed');
  process.exit(result.status || 1);
}
console.log('[gui] dist/RxCloude.exe built');
