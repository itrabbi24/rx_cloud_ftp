const path = require('path');

// The data layer (./db) resolves its data directory from RX_CLOUDE_ROOT the
// moment it is required, so the root MUST be established here, before any
// local module is loaded. Previously ./server was required on the first line
// and the root was applied afterwards, which silently ignored --root and made
// the server read and write the data of whatever directory it was started from.
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') {
      result.port = Number(args[++i]);
    } else if (args[i] === '--dir' || args[i] === '-d') {
      result.folder = args[++i];
    } else if (args[i] === '--root' || args[i] === '-r') {
      result.root = args[++i];
    } else if (args[i] === '--https') {
      result.scheme = 'https';
    } else if (args[i] === '--http') {
      result.scheme = 'http';
    }
  }
  return result;
}

// Paths can arrive with surrounding quotes (copied from Explorer/PowerShell) or
// a trailing backslash, and a stray quote used to end up inside the path and
// crash with ENOENT: mkdir 'C:\dir"\data'. Strip the noise before use.
function cleanPathInput(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^"+|"+$/g, '').trim().replace(/[\\/]+$/, '');
}

const cliArgs = parseArgs();

// Environment variables win: the GUI passes paths this way, which avoids
// Windows command-line quoting entirely.
const envRoot = cleanPathInput(process.env.RX_CLOUDE_ROOT);
const envFolder = cleanPathInput(process.env.RX_CLOUDE_DIR);
const argRoot = cleanPathInput(cliArgs.root);
const appRoot = envRoot || argRoot || (process.pkg ? path.dirname(process.execPath) : process.cwd());
process.env.RX_CLOUDE_ROOT = appRoot;

const portFromEnv = Number(process.env.RX_CLOUDE_PORT);
if (!Number.isFinite(portFromEnv) || portFromEnv <= 0) delete process.env.RX_CLOUDE_PORT;

const { startServer } = require('./server');
const { getConfig, saveConfig, DATA_DIR } = require('./db');

const cfg = getConfig();
const port = Number(process.env.RX_CLOUDE_PORT) || cliArgs.port || cfg.port || 8080;
const folder = path.resolve(envFolder || cleanPathInput(cliArgs.folder) || cfg.sharedFolder || path.join(appRoot, 'shared_files'));

// Scheme: plain HTTP by default. Browsers treat a bare "192.168.1.5:8080" in the
// address bar as http://, and against an HTTPS-only port Chrome shows
// ERR_EMPTY_RESPONSE, so HTTPS has to be an explicit choice.
let scheme = String(process.env.RX_CLOUDE_SCHEME || 'http').toLowerCase();
if (scheme !== 'https') scheme = 'http';
if (/^https$/i.test(String(cliArgs.scheme || ''))) scheme = 'https';
process.env.RX_CLOUDE_SCHEME = scheme;

cfg.port = port;
cfg.sharedFolder = folder;
cfg.scheme = scheme;
saveConfig(cfg);

// Printed before startServer so a bad path is obvious in the log instead of
// appearing as an ENOENT deep inside the data layer.
console.log(`[Server] Starting: version v${require('./server').APP_VERSION}, port ${port}, scheme ${scheme.toUpperCase()}`);
console.log(`[Server] App root: ${appRoot}`);
console.log(`[Server] Data folder: ${DATA_DIR}`);
console.log(`[Server] Shared folder: ${folder}`);
console.log(`[Server] Open in a browser: ${scheme}://localhost:${port}`);

startServer(port, folder, (err, info) => {
  if (err) {
    console.error(`[Error] ${err.message}`);
    process.exit(1);
  }
  console.log(`[Server] Rx Cloude v${info.version || 'unknown'} ONLINE on port ${info.port}`);
  console.log(`[Server] Storage folder: ${info.sharedFolder}`);
  console.log(`[Server] Data folder: ${DATA_DIR}`);
  console.log(`[Server] Local URL: http://localhost:${info.port}`);
  if (info.certExpiresAt) {
    console.log(`[Server] HTTPS certificate valid until: ${new Date(info.certExpiresAt).toISOString()}`);
  }
  if (info.ips && info.ips.length) {
    info.ips.forEach(ip => {
      console.log(`[Server] Network URL: http://${ip}:${info.port}`);
    });
  }
});
