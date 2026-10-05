const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mime = require('mime-types');
const { WebSocketServer } = require('ws');
const os = require('os');
const crypto = require('crypto');
const { getConfig, saveConfig, getUsers, saveUsers, normalizePermissions, getShares, saveShares, getUserMetadata, updateFileMeta, getVaultInfo, setVaultPin, verifyVaultPin, updateVaultInfo, getSessionDays, getUploadByteLimit, applyConfigUpdate, ABSOLUTE_MAX_UPLOAD_BYTES, ensureUsersExist, clearFirstLoginFile, FIRST_LOGIN_FILE } = require('./db');
const AdmZip = require('adm-zip');
const unzipper = require('unzipper');
const selfsigned = require('selfsigned');
const { isAdmin, hasPermission, publicUser } = require('./permissions');

// Single source of truth for the build version. package.json is bundled into
// the pkg snapshot because it is listed in the pkg.scripts/assets config.
let APP_VERSION = '1.3.0';
try {
  const pkgJson = require('../package.json');
  if (pkgJson && pkgJson.version) APP_VERSION = pkgJson.version;
} catch (err) {
  console.warn(`[Version] Falling back to ${APP_VERSION}: ${err.message}`);
}

// One bad request (a stream error, a locked file) must not take the whole
// server down for every user. Log it and keep serving.
process.on('uncaughtException', (err) => {
  console.error(`[Error] Unexpected: ${err && err.stack ? err.stack.split('\n')[0] : err}`);
});
process.on('unhandledRejection', (err) => {
  console.error(`[Error] Unhandled: ${err && err.message ? err.message : err}`);
});

// --- Update check ---------------------------------------------------------
// Looks up the newest GitHub release once at start and then daily. Failure
// (an offline LAN server) is silent; the feature simply stays hidden.
const UPDATE_REPO = 'itrabbi24/rx_cloud_ftp';
let latestRelease = null;

function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split(/[.+-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split(/[.+-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function checkLatestRelease() {
  const req = https.get({
    host: 'api.github.com',
    path: `/repos/${UPDATE_REPO}/releases/latest`,
    headers: { 'User-Agent': `RxCloude/${APP_VERSION}`, Accept: 'application/vnd.github+json' },
    timeout: 10000
  }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', chunk => { if (body.length < 512 * 1024) body += chunk; });
    res.on('end', () => {
      try {
        if (res.statusCode !== 200) return;
        const data = JSON.parse(body);
        const version = String(data.tag_name || '').replace(/^v/i, '');
        if (!version) return;
        latestRelease = { version, url: data.html_url || `https://github.com/${UPDATE_REPO}/releases/latest` };
        if (compareVersions(version, APP_VERSION) > 0) {
          broadcastLog('info', `Update available: Rx Cloude v${version} (running v${APP_VERSION}). Use the Update button in the launcher.`);
        }
      } catch (e) {}
    });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => {});
}

let app = express();
let server = null;
let wss = null;
let wsClients = new Set();
let isRunning = false;
let resolvedPublicDir = path.join(__dirname, '..', 'public');
const authAttempts = new Map();
const vaultSessions = new Map();
const usageCache = new Map();

// Packaged builds (pkg) cannot embed the web UI as an asset: its pkg.assets
// config is silently ignored for this project, so __dirname inside the
// snapshot contains no HTML/CSS/JS. The UI is embedded as base64 in
// assets-bundle.js instead and written to a writable folder on first run.
function loadAssetsBundle() {
  try {
    return require('./assets-bundle.js');
  } catch (err) {
    return null;
  }
}

function resolvePublicDir(version) {
  const diskPublic = path.join(__dirname, '..', 'public');
  if (fs.existsSync(path.join(diskPublic, 'index.html'))) {
    return { dir: diskPublic, source: 'disk' };
  }

  const bundle = loadAssetsBundle();
  if (!bundle || !bundle.FILES) return { dir: diskPublic, source: 'missing' };

  const target = path.join(require('./db').DATA_DIR, 'web');
  const stampFile = path.join(target, '.bundle-version');
  let currentStamp = null;
  try { currentStamp = fs.readFileSync(stampFile, 'utf8').trim(); } catch (err) {}

  // if (currentStamp !== bundle.VERSION) {
  const bundleStamp = bundle.HASH ? `${bundle.VERSION}+${bundle.HASH}` : bundle.VERSION;
  if (currentStamp !== bundleStamp) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (err) {}
    fs.mkdirSync(target, { recursive: true });
    for (const [rel, base64] of Object.entries(bundle.FILES)) {
      // Bundle keys are 'public/app.js' / 'launcher.html'; on disk the web root
      // is the folder that directly contains index.html and app.js.
      const relative = rel.startsWith('public/') ? rel.slice('public/'.length) : rel;
      const dest = path.join(target, relative);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(base64, 'base64'));
    }
    // fs.writeFileSync(stampFile, bundle.VERSION, 'utf8');
    fs.writeFileSync(stampFile, bundleStamp, 'utf8');
    console.log(`[Assets] Web UI extracted to ${target} (version ${bundle.VERSION})`);
  }
  return { dir: target, source: 'bundle' };
}

function rateLimited(key, limit = 8, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const old = authAttempts.get(key);
  if (!old || now - old.started > windowMs) {
    authAttempts.set(key, { started: now, count: 1 });
    return false;
  }
  old.count++;
  return old.count > limit;
}

function isVaultPath(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized === '.vault' || normalized.startsWith('.vault/') || normalized.includes('/.vault/') || normalized.endsWith('/.vault');
}

function deriveVaultKey(pin) { return crypto.createHash('sha256').update(`rx-cloude-vault:${pin}`).digest(); }

function encryptFile(source, destination, key) {
  return new Promise((resolve, reject) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const out = fs.createWriteStream(destination);
    out.write(Buffer.concat([Buffer.from('RXV1'), iv]));
    fs.createReadStream(source).on('error', reject).pipe(cipher).pipe(out);
    out.on('finish', () => { try { fs.appendFileSync(destination, cipher.getAuthTag()); resolve(); } catch (e) { reject(e); } });
    cipher.on('error', reject);
  });
}

function decryptVaultStream(file, key, res) {
  const fd = fs.openSync(file, 'r');
  const header = Buffer.alloc(16); fs.readSync(fd, header, 0, 16, 0); fs.closeSync(fd);
  if (header.subarray(0, 4).toString() !== 'RXV1') throw new Error('Invalid vault file');
  const stat = fs.statSync(file);
  const tag = Buffer.alloc(16); const tagFd = fs.openSync(file, 'r'); fs.readSync(tagFd, tag, 0, 16, stat.size - 16); fs.closeSync(tagFd);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(4, 16)); decipher.setAuthTag(tag);
  // return fs.createReadStream(file, { start: 16, end: stat.size - 17 }).pipe(decipher).pipe(res);
  // A wrong key or damaged file makes the decipher emit 'error'; unhandled, that
  // terminated the whole server process.
  const source = fs.createReadStream(file, { start: 16, end: stat.size - 17 });
  const fail = (err) => {
    source.destroy();
    if (typeof res.headersSent === 'boolean' && !res.headersSent) {
      res.status(500).json({ error: 'Vault file could not be decrypted' });
    } else if (res.destroy) {
      res.destroy(err);
    }
  };
  source.on('error', fail);
  decipher.on('error', fail);
  return source.pipe(decipher).pipe(res);
}

// Decrypt a vault file to a plain file on disk. Resolves once fully written.
function decryptVaultToFile(file, key, destination) {
  return new Promise((resolve, reject) => {
    let out;
    try {
      out = fs.createWriteStream(destination);
      out.on('error', reject);
      out.on('finish', resolve);
      decryptVaultStream(file, key, out);
    } catch (err) {
      if (out) out.destroy();
      reject(err);
    }
    if (out) out.on('close', () => { if (!out.writableFinished) reject(new Error('Vault file could not be decrypted')); });
  });
}

// Broadcaster for real-time logs to launcher
function broadcastLog(type, message, meta = {}) {
  const logEntry = {
    timestamp: new Date().toLocaleTimeString(),
    type,
    message,
    meta
  };
  // Print live activity directly to terminal
  console.log(`[${logEntry.timestamp}] [${type.toUpperCase()}] ${message}`);

  const payload = JSON.stringify({ event: 'log', data: logEntry });
  for (const client of wsClients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

// Helper to get local network IPv4 addresses
function getNetworkIPs() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

// Calculate folder size recursively
function getFolderSize(dirPath) {
  let total = 0;
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dirPath, item.name);
      if (item.name === '.trash' || item.name === '.vault' || item.name === '.trash_meta' || item.name === '.vault_meta') continue;
      if (item.isDirectory()) {
        total += getFolderSize(full);
      } else if (item.isFile()) {
        total += fs.statSync(full).size;
      }
    }
  } catch (e) {}
  return total;
}

// Non-blocking folder size (yields to other requests between directories).
async function getFolderSizeAsync(dirPath) {
  let total = 0;
  const stack = [dirPath];
  while (stack.length) {
    const dir = stack.pop();
    let items;
    try { items = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const item of items) {
      if (item.name === '.trash' || item.name === '.vault' || item.name === '.trash_meta' || item.name === '.vault_meta') continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) stack.push(full);
      else if (item.isFile()) {
        try { total += (await fs.promises.stat(full)).size; } catch (e) {}
      }
    }
  }
  return total;
}

const usageScansRunning = new Set();
function refreshUsageInBackground(cacheKey, rootPath) {
  if (usageScansRunning.has(cacheKey)) return null;
  usageScansRunning.add(cacheKey);
  return getFolderSizeAsync(rootPath)
    .then(bytes => usageCache.set(cacheKey, { bytes, at: Date.now() }))
    .catch(() => {})
    .finally(() => usageScansRunning.delete(cacheKey));
}

// Recursively collect all files under dirPath (excluding hidden folders like .trash, .vault)
function collectAllFiles(dirPath, rootPath = dirPath) {
  let results = [];
  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith('.trash') || item.name.startsWith('.vault')) continue;
      const full = path.join(dirPath, item.name);
      if (item.isDirectory()) {
        results = results.concat(collectAllFiles(full, rootPath));
      } else if (item.isFile()) {
        try {
          const stats = fs.statSync(full);
          const rel = path.relative(rootPath, full).replace(/\\/g, '/');
          results.push({
            name: item.name,
            path: rel,
            fullPath: full,
            size: stats.size,
            updatedAt: stats.mtime
          });
        } catch (e) {}
      }
    }
  } catch (e) {}
  return results;
}

// Compute fast MD5 hash of a file
function getFileHash(filePath) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => resolve(null));
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Path resolver ensuring jail/chroot isolation
function resolveSafePath(baseRoot, userScope, requestedSubPath) {
  const userRoot = path.resolve(baseRoot, userScope || '');
  const targetPath = path.resolve(userRoot, requestedSubPath ? requestedSubPath.replace(/^[\\\/]+/, '') : '');

  // Protection against Path Traversal (e.g. ../../)
  const relative = path.relative(userRoot, targetPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }

  // Existing symbolic links must resolve inside the same user root.
  try {
    const realRoot = fs.realpathSync(userRoot);
    const realTarget = fs.realpathSync(targetPath);
    const realRelative = path.relative(realRoot, realTarget);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      return null;
    }
  } catch (err) {
    // The target may not exist yet (for a new upload/folder). The lexical
    // path check above still protects non-existing destinations.
  }
  return { userRoot, targetPath };
}

// Password policy. Kept low (4) so it matches what the app itself uses for
// vault PINs and share links, and so an account can always be changed. It is
// enforced on every path that sets a password, including the first admin login.
const MIN_PASSWORD_LENGTH = 4;
const PASSWORD_LENGTH_ERROR = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;

function isPasswordLongEnough(value) {
  return String(value === undefined || value === null ? '' : value).length >= MIN_PASSWORD_LENGTH;
}

// Share-link password policy: at least SHARE_PASSWORD_MIN digits. Applied on the
// server so it holds no matter which client sends the request.
const SHARE_PASSWORD_MIN = 3;
const SHARE_PASSWORD_ERROR = `Share link password must be at least ${SHARE_PASSWORD_MIN} digits`;

function isValidSharePassword(value) {
  return String(value).trim().length >= SHARE_PASSWORD_MIN;
}

// Usernames become folder names (users/<name>), so they must be safe on disk.
// A name like "..." passed the old check and Windows strips trailing dots,
// which pointed the new account at the shared users/ folder itself.
const USERNAME_ERROR = 'Username must be 3-32 characters: letters, numbers, dot, dash or underscore, not starting with a dot';
function isValidUsername(value) {
  const name = String(value || '');
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]{2,31}$/.test(name) && !/\.$/.test(name);
}

// Folder scopes are relative paths inside the storage folder. Returns '' for
// "whole drive", the normalised path, or null when it tries to escape.
function cleanFolderScope(value) {
  if (value === undefined || value === null) return '';
  const normalized = path.posix.normalize(String(value).replace(/\\/g, '/').trim()).replace(/^\/+|\/+$/g, '');
  if (normalized === '.' || normalized === '') return '';
  if (normalized === '..' || normalized.startsWith('../') || /^[A-Za-z]:/.test(normalized)) return null;
  return normalized;
}

// A single path segment typed by a user (new folder, rename target).
function isValidItemName(value) {
  const name = String(value || '').trim();
  if (!name || name === '.' || name === '..') return false;
  if (/[\\/:*?"<>|\x00-\x1f]/.test(name)) return false;
  return name.length <= 255;
}

// Trash ids are generated by the server and are always a bare file name.
function isValidTrashId(value) {
  const id = String(value || '');
  return !!id && id === path.basename(id) && id !== '.' && id !== '..' && !/[\\/]/.test(id);
}

// RFC 6266 Content-Disposition that keeps non-ASCII names readable. The old
// header put a percent-encoded name inside quotes, so "My file.pdf" was saved
// as "My%20file.pdf".
function contentDisposition(type, fileName) {
  const fallback = String(fileName).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

// Inline previews are served from the app's own origin, where the login token
// lives in localStorage. An uploaded .html/.svg opened in preview could run
// script with the viewer's session, so active types are sandboxed.
function setSafePreviewHeaders(res, contentType) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (/html|svg|xml|javascript/i.test(String(contentType))) {
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'");
  }
}

function createServerApp() {
  const currentApp = express();
  currentApp.use(cors());
  // currentApp.use(express.json());
  // The default 100 KB body limit made the built-in note/code editor fail
  // with "request entity too large" on any file over 100 KB.
  currentApp.use(express.json({ limit: '50mb' }));
  currentApp.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Static files for the Web Drive UI
  currentApp.use(express.static(resolvedPublicDir));

  // Auth Middleware
  function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;

    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }

    const cfg = getConfig();
    jwt.verify(token, cfg.jwtSecret, (err, decoded) => {
      if (err) {
        return res.status(403).json({ error: 'Invalid or expired session' });
      }
      const users = getUsers();
      const user = users.find(u => u.id === decoded.id);
      if (!user) {
        return res.status(403).json({ error: 'User not found' });
      }
      req.user = user;
      if (user.mustChangePassword && req.path !== '/api/auth/change-password') {
        return res.status(428).json({ error: 'Password change required', mustChangePassword: true });
      }
      next();
    });
  }

  // --- API: AUTHENTICATION ---
  currentApp.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const attemptKey = `${req.ip}:${String(username || '').toLowerCase()}`;
    if (rateLimited(attemptKey)) return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    const users = getUsers();
    const user = users.find(u => u.username.toLowerCase() === (username || '').toLowerCase());

    if (!user || user.status === 'inactive' || !bcrypt.compareSync(password, user.passwordHash)) {
      broadcastLog('warning', `Failed login attempt for user: "${username}" from IP: ${req.ip}`);
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const cfg = getConfig();
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      cfg.jwtSecret,
      { expiresIn: `${getSessionDays(cfg)}d` }
    );

    broadcastLog('success', `User logged in: "${user.username}" [Role: ${user.role}]`);
    res.json({
      token,
      user: {
        ...publicUser(user)
      }
    });
  });

  // Change Password for Current Logged In User
  currentApp.post('/api/auth/change-password', authenticateToken, (req, res) => {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: 'Both current password and new password are required' });
    }
    // if (newPassword.length < 12) {
    //   return res.status(400).json({ error: 'New password must be at least 12 characters' });
    // }
    // The rest of the app (UI hint, admin user creation) disagreed on 12 vs 4;
    // one constant now drives every password check.
    if (!isPasswordLongEnough(newPassword)) {
      return res.status(400).json({ error: PASSWORD_LENGTH_ERROR });
    }
    if (String(newPassword) === String(oldPassword)) {
      return res.status(400).json({ error: 'New password must be different from the current one' });
    }

    const users = getUsers();
    const userIndex = users.findIndex(u => u.id === req.user.id);
    if (userIndex === -1) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!bcrypt.compareSync(oldPassword, users[userIndex].passwordHash)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    users[userIndex].passwordHash = bcrypt.hashSync(newPassword, 10);
    users[userIndex].mustChangePassword = false;
    saveUsers(users);
    if (users[userIndex].id === 'admin_1') clearFirstLoginFile();
    broadcastLog('info', `User "${req.user.username}" changed their password successfully.`);
    res.json({ success: true, message: 'Password updated successfully' });
  });

  // --- API: SERVER CONFIG & GLOBAL SETTINGS ---
  // Public endpoint: the login page calls this before authentication, so it
  // must never expose the storage path, port or any credential material.
  currentApp.get('/api/config', (req, res) => {
    const cfg = getConfig();
    res.json({
      version: APP_VERSION,
      maxUploadMB: cfg.maxUploadMB !== undefined ? cfg.maxUploadMB : 1024,
      allowRegistration: !!cfg.allowRegistration
    });
  });

  // Build/version information so clients can detect what they are talking to.
  currentApp.get('/api/version', (req, res) => {
    // res.json({ name: 'Rx Cloude', version: APP_VERSION, node: process.version });
    res.json({
      name: 'Rx Cloude',
      version: APP_VERSION,
      node: process.version,
      // Newest GitHub release (null when unknown or offline); the web UI
      // shows an update banner to admins when it is newer than `version`.
      latest: latestRelease ? latestRelease.version : null,
      releaseUrl: latestRelease ? latestRelease.url : null
    });
  });

  currentApp.put('/api/config', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin permission required' });
    }
    const { maxUploadMB, allowRegistration, sessionDays } = req.body;
    const cfg = applyConfigUpdate(getConfig(), { maxUploadMB, allowRegistration, sessionDays });

    saveConfig(cfg);
    broadcastLog('info', `Admin updated server settings: Global Max Upload = ${cfg.maxUploadMB > 0 ? cfg.maxUploadMB + ' MB' : 'Unlimited'}, Public Registration = ${cfg.allowRegistration ? 'Enabled' : 'Disabled'}, Session Days = ${getSessionDays(cfg)}`);
    res.json({
      success: true,
      config: {
        maxUploadMB: cfg.maxUploadMB,
        allowRegistration: cfg.allowRegistration,
        sessionDays: getSessionDays(cfg),
        port: cfg.port,
        sharedFolder: cfg.sharedFolder
      }
    });
  });

  // --- API: USER SELF-REGISTRATION ---
  currentApp.post('/api/auth/register', (req, res) => {
    const cfg = getConfig();
    if (!cfg.allowRegistration) {
      return res.status(403).json({ error: 'Public registration is disabled by administrator' });
    }

    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (username.length < 3 || /[\\/:*?"<>|\s]/.test(username)) {
      return res.status(400).json({ error: 'Username must be at least 3 characters without spaces or symbols' });
    }
    // if (password.length < 12) {
    //   return res.status(400).json({ error: 'Password must be at least 12 characters' });
    // }
    if (!isPasswordLongEnough(password)) {
      return res.status(400).json({ error: PASSWORD_LENGTH_ERROR });
    }
    if (!isValidUsername(username)) {
      return res.status(400).json({ error: USERNAME_ERROR });
    }

    const users = getUsers();
    if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
      return res.status(400).json({ error: 'Username is already taken' });
    }

    const newUserId = 'usr_' + Date.now().toString(36);
    const userFolder = `users/${username}`;
    const newUser = {
      id: newUserId,
      username,
      passwordHash: bcrypt.hashSync(password, 10),
      role: 'user',
      accessMode: 'own',
      permissions: {
        canView: true,
        canPreview: true,
        canUpload: true,
        canDownload: true,
        canCreateFolder: true,
        canRename: true,
        canMove: true,
        canCopy: true,
        canDelete: true,
        canRestore: true,
        canShare: true,
        canManagePermissions: false,
        canEdit: true,
        canViewActivity: false
      },
      folderScope: userFolder,
      folderPermissions: [],
      quotaMB: 1024, // 1GB default quota
      createdAt: new Date().toISOString()
    };

    users.push(newUser);
    saveUsers(users);

    // Create user's personal home folder
    fs.mkdirSync(path.join(cfg.sharedFolder, userFolder), { recursive: true });

    broadcastLog('success', `New user registered: "${username}" [Folder: ${userFolder}]`);

    const token = jwt.sign(
      { id: newUser.id, username: newUser.username, role: newUser.role },
      cfg.jwtSecret,
      { expiresIn: `${getSessionDays(cfg)}d` }
    );

    res.status(201).json({
      success: true,
      token,
      user: publicUser(newUser)
    });
  });

  // --- API: USER MANAGEMENT (Admin Only) ---
  currentApp.get('/api/users', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin permission required' });
    }
    const users = getUsers().map(publicUser);
    res.json(users);
  });

  currentApp.post('/api/users', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin permission required' });
    }

    const { username, password, role, permissions, accessMode, folderScope, folderPermissions, quotaMB } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    // if (password.length < 12) return res.status(400).json({ error: 'Password must be at least 12 characters' });
    if (!isPasswordLongEnough(password)) return res.status(400).json({ error: PASSWORD_LENGTH_ERROR });
    if (!isValidUsername(username)) return res.status(400).json({ error: USERNAME_ERROR });
    const cleanScope = cleanFolderScope(folderScope);
    if (cleanScope === null) return res.status(400).json({ error: 'Invalid folder scope path' });
    const users = getUsers();
    if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const newUserId = 'usr_' + Date.now().toString(36);
    const newUser = {
      id: newUserId,
      username,
      passwordHash: bcrypt.hashSync(password, 10),
      role: role === 'admin' ? 'admin' : 'user',
      accessMode: ['own', 'global', 'custom'].includes(accessMode) ? accessMode : 'own',
      permissions: normalizePermissions(permissions, role === 'admin' ? 'admin' : 'user'),
      // folderScope: folderScope || (accessMode === 'global' ? '' : `users/${newUserId}`),
      folderScope: cleanScope || (accessMode === 'global' ? '' : `users/${username}`),
      folderPermissions: Array.isArray(folderPermissions) ? folderPermissions : [],
      quotaMB: Number(quotaMB) || 0,
      createdAt: new Date().toISOString()
    };

    users.push(newUser);
    saveUsers(users);
    if (newUser.folderScope) {
      const cfg = getConfig();
      fs.mkdirSync(path.join(cfg.sharedFolder, newUser.folderScope), { recursive: true });
    }
    broadcastLog('info', `Admin created new user: "${username}" [Role: ${newUser.role}]`);
    res.status(201).json({ success: true, user: publicUser(newUser) });
  });

  currentApp.put('/api/users/:id', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin permission required' });
    }
    const { id } = req.params;
    const { password, role, permissions, accessMode, folderScope, folderPermissions, quotaMB, status } = req.body;

    const users = getUsers();
    const index = users.findIndex(u => u.id === id);
    if (index === -1) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (password && password.trim()) {
      // if (password.trim().length < 12) return res.status(400).json({ error: 'Password must be at least 12 characters' });
      if (!isPasswordLongEnough(password.trim())) return res.status(400).json({ error: PASSWORD_LENGTH_ERROR });
      users[index].passwordHash = bcrypt.hashSync(password, 10);
      users[index].mustChangePassword = false;
    }
    if (role) users[index].role = role === 'admin' ? 'admin' : 'user';
    if (accessMode && ['own', 'global', 'custom'].includes(accessMode)) users[index].accessMode = accessMode;
    if (permissions) users[index].permissions = normalizePermissions(permissions, users[index].role);
    // if (folderScope !== undefined) users[index].folderScope = folderScope;
    if (folderScope !== undefined) {
      const cleanScope = cleanFolderScope(folderScope);
      if (cleanScope === null) return res.status(400).json({ error: 'Invalid folder scope path' });
      users[index].folderScope = cleanScope;
    }
    // Never lock the server out: the last active admin cannot be demoted or disabled.
    const activeAdmins = users.filter(u => u.role === 'admin' && u.status !== 'inactive');
    if (activeAdmins.length === 0) {
      return res.status(400).json({ error: 'At least one active administrator is required' });
    }
    if (Array.isArray(folderPermissions)) users[index].folderPermissions = folderPermissions;
    if (status && ['active', 'inactive'].includes(status)) users[index].status = status;
    if (quotaMB !== undefined) users[index].quotaMB = Number(quotaMB);

    saveUsers(users);
    broadcastLog('info', `Admin updated permissions for user: "${users[index].username}"`);
    res.json({ success: true, user: publicUser(users[index]) });
  });

  currentApp.delete('/api/users/:id', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin permission required' });
    }
    const { id } = req.params;
    let users = getUsers();
    const target = users.find(u => u.id === id);

    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.username === 'admin') {
      return res.status(400).json({ error: 'Default admin cannot be deleted' });
    }

    users = users.filter(u => u.id !== id);
    saveUsers(users);
    broadcastLog('warning', `Admin deleted user: "${target.username}"`);
    res.json({ success: true });
  });

  // --- API: FILE SYSTEM / DRIVE ENDPOINTS ---

  // 1. List Files and Folders
  currentApp.get('/api/files', authenticateToken, async (req, res) => {
    const cfg = getConfig();
    const subPath = req.query.path || '';
    if (isVaultPath(subPath)) return res.status(403).json({ error: 'Vault files require vault authentication' });
    if (!hasPermission(req.user, 'view', subPath)) {
      return res.status(403).json({ error: 'View permission denied' });
    }
    const safe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, subPath);

    if (!safe || !fs.existsSync(safe.targetPath)) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    try {
      const userMeta = getUserMetadata(req.user.id);
      const items = fs.readdirSync(safe.targetPath, { withFileTypes: true });
      const files = items
        .filter(item => item.name !== '.trash' && !item.name.startsWith('.trash_meta') && item.name !== '.vault' && !item.name.startsWith('.vault_meta'))
        .map(item => {
          const full = path.join(safe.targetPath, item.name);
        try {
          const stats = fs.statSync(full);
          const itemRelPath = path.relative(safe.userRoot, full).replace(/\\/g, '/');
          const meta = userMeta[itemRelPath] || {};
          return {
            name: item.name,
            isDirectory: item.isDirectory(),
            size: item.isDirectory() ? null : stats.size,
            updatedAt: stats.mtime,
            mime: item.isDirectory() ? 'folder' : (mime.lookup(item.name) || 'application/octet-stream'),
            starred: !!meta.starred,
            color: meta.color || null
          };
        } catch (e) {
          return null;
        }
      }).filter(Boolean);

      // Relative path for client breadcrumbs
      const relPath = path.relative(safe.userRoot, safe.targetPath).replace(/\\/g, '/');

      // Calculate storage usage
      const cacheKey = req.user.id;
      const cached = usageCache.get(cacheKey);
      // const usedBytes = cached && Date.now() - cached.at < 10000 ? cached.bytes : getFolderSize(safe.userRoot);
      // usageCache.set(cacheKey, { bytes: usedBytes, at: Date.now() });
      // The synchronous walk of the WHOLE drive ran on every folder open (cache
      // was only 10 s) and froze the server for everyone on large drives. Use
      // the cached figure and refresh it in the background without blocking.
      let usedBytes = cached ? cached.bytes : null;
      if (!cached || Date.now() - cached.at > 30000) {
        const scan = refreshUsageInBackground(cacheKey, safe.userRoot);
        // First visit: wait briefly so small drives show their usage at once.
        if (!cached && scan) {
          await Promise.race([scan, new Promise(r => setTimeout(r, 1500))]);
          const fresh = usageCache.get(cacheKey);
          if (fresh) usedBytes = fresh.bytes;
        }
      }

      res.json({
        currentPath: relPath ? '/' + relPath : '/',
        files,
        quota: {
          limitMB: req.user.quotaMB,
          usedBytes
        }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Upload names arrive as latin1-decoded bytes (busboy default); restore UTF-8
  // and normalise to a clean relative path with no "..", drive letters or
  // leading slashes.
  function uploadRelativeName(file) {
    if (file._rxRelName) return file._rxRelName;
    const raw = Buffer.from(String(file.originalname || ''), 'latin1').toString('utf8').replace(/\\/g, '/');
    const parts = raw.split('/').map(p => p.trim()).filter(p => p && p !== '.' && p !== '..' && !/^[A-Za-z]:$/.test(p));
    file._rxRelName = parts.length ? parts.join('/') : 'upload';
    return file._rxRelName;
  }

  // 2. Multer Upload Setup with Quota Check
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const cfg = getConfig();
      const subPath = (req.query.path || req.body?.path || '').replace(/^[\\\/]+/, '');
      if (!hasPermission(req.user, 'upload', subPath)) return cb(new Error('Upload permission denied'));
      // Folder uploads send "Folder/sub/file.txt" as the name; recreate the
      // sub-folders under the current path instead of flattening them.
      const relDir = path.posix.dirname(uploadRelativeName(file));
      const safe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, relDir === '.' ? subPath : path.join(subPath, relDir));
      if (!safe) return cb(new Error('Invalid destination path'));
      if (isVaultPath(path.relative(safe.userRoot, safe.targetPath))) return cb(new Error('Invalid destination path'));
      if (!fs.existsSync(safe.targetPath)) {
        fs.mkdirSync(safe.targetPath, { recursive: true });
      }
      cb(null, safe.targetPath);
    },
    filename: (req, file, cb) => {
      // Preserve original file name
      // cb(null, Buffer.from(file.originalname, 'latin1').toString('utf8'));
      const name = path.posix.basename(uploadRelativeName(file));
      if (!isValidItemName(name)) return cb(new Error('Invalid file name'));
      cb(null, name);
    }
  });

  // Enforce the global limit at multer level so oversized payloads are
  // rejected before they are streamed to disk. The limit is read per request
  // so an admin change takes effect without a restart.
  // const upload = multer({
  //   storage,
  //   limits: {
  //     fileSize: Math.max(getUploadByteLimit(getConfig()), 1024 * 1024),
  //     files: 50
  //   }
  // });
  // The limit above was computed once at startup (despite the comment), and
  // getUploadByteLimit takes the larger of maxUploadMB and the 50 GB
  // maxUploadBytes, so oversized files were always written to disk in full
  // before being deleted. Build the limiter per request from the MB setting.
  function makeUploader() {
    const cfg = getConfig();
    const fromMB = Number(cfg.maxUploadMB) > 0 ? Number(cfg.maxUploadMB) * 1024 * 1024 : ABSOLUTE_MAX_UPLOAD_BYTES;
    return multer({
      storage,
      preservePath: true,
      limits: { fileSize: Math.min(fromMB, ABSOLUTE_MAX_UPLOAD_BYTES), files: 500 }
    });
  }

  currentApp.post('/api/files/upload', authenticateToken, (req, res) => {
    const targetSubPath = (req.query.path || req.body?.path || '').replace(/^[\\\/]+/, '');
    if (!hasPermission(req.user, 'upload', targetSubPath)) {
      return res.status(403).json({ error: 'Upload permission denied' });
    }

    // Quota check
    if (req.user.quotaMB > 0) {
      const cfg = getConfig();
      const safe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, '');
      if (safe) {
        const usedBytes = getFolderSize(safe.userRoot);
        if (usedBytes >= req.user.quotaMB * 1024 * 1024) {
          return res.status(400).json({ error: 'Storage quota exceeded!' });
        }
      }
    }

    makeUploader().array('files')(req, res, (err) => {
      if (err) {
        // A rejected batch must not leave half-written files behind.
        for (const f of req.files || []) {
          try { fs.unlinkSync(f.path); } catch (e) {}
        }
        // Reject oversized uploads with a 4xx instead of a generic 500, and
        // report the configured limit so the client can react to it.
        const cfg = getConfig();
        const isTooLarge = err.code === 'LIMIT_FILE_SIZE';
        broadcastLog('warning', `Upload rejected for "${req.user.username}": ${isTooLarge ? `file exceeds the global limit of ${cfg.maxUploadMB > 0 ? cfg.maxUploadMB + ' MB' : '50 GB'}` : err.message}`);
        return res.status(isTooLarge ? 413 : (/permission/i.test(err.message) ? 403 : 400)).json({
          error: isTooLarge
            ? `Upload rejected: file exceeds the global upload limit of ${cfg.maxUploadMB > 0 ? cfg.maxUploadMB + ' MB' : '50 GB'}`
            : err.message,
          maxUploadMB: cfg.maxUploadMB
        });
      }

      // Second safety net: enforce both the MB setting and the raw byte ceiling
      // in case the stored config was edited between requests.
      const cfg = getConfig();
      const maxBytes = cfg.maxUploadMB > 0 ? cfg.maxUploadMB * 1024 * 1024 : ABSOLUTE_MAX_UPLOAD_BYTES;
      const oversized = (req.files || []).find(f => f.size > maxBytes);
      if (oversized) {
        // Remove the whole batch so a rejected upload leaves nothing behind.
        for (const f of req.files || []) {
          try { fs.unlinkSync(f.path); } catch(e) {}
        }
        broadcastLog('warning', `Upload rejected for "${req.user.username}": "${oversized.originalname}" (${Math.round(oversized.size / (1024*1024))} MB) exceeded global max limit of ${cfg.maxUploadMB > 0 ? cfg.maxUploadMB + ' MB' : '50 GB'}`);
        return res.status(413).json({
          error: `File "${oversized.originalname}" exceeds the global upload limit of ${cfg.maxUploadMB > 0 ? cfg.maxUploadMB + ' MB' : '50 GB'}!`,
          maxUploadMB: cfg.maxUploadMB
        });
      }

      const fileNames = req.files ? req.files.map(f => f.filename).join(', ') : '';
      broadcastLog('upload', `User "${req.user.username}" uploaded: ${fileNames}`);
      res.json({ success: true, count: req.files ? req.files.length : 0 });
    });
  });

  // 3. Download or Preview File
  currentApp.get('/api/files/download', authenticateToken, (req, res) => {
    const filePath = req.query.path || '';
    if (isVaultPath(filePath)) return res.status(403).json({ error: 'Vault files require vault authentication' });
    const operation = req.query.preview === 'true' ? 'preview' : 'download';
    if (!hasPermission(req.user, operation, filePath)) {
      return res.status(403).json({ error: 'Download permission denied' });
    }

    const cfg = getConfig();
    const isPreview = req.query.preview === 'true';
    const safe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, filePath);

    if (!safe || !fs.existsSync(safe.targetPath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const stat = fs.statSync(safe.targetPath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Cannot download folder directly without zip' });
    }

    broadcastLog('download', `User "${req.user.username}" ${isPreview ? 'previewed' : 'downloaded'}: ${path.basename(safe.targetPath)}`);

    if (isPreview) {
      let contentType = mime.lookup(safe.targetPath) || 'application/octet-stream';
      const ext = path.extname(safe.targetPath).toLowerCase();
      if (ext === '.pdf') {
        contentType = 'application/pdf';
      }
      res.setHeader('Content-Type', contentType);
      // res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(path.basename(safe.targetPath))}"`);
      res.setHeader('Content-Disposition', contentDisposition('inline', path.basename(safe.targetPath)));
      setSafePreviewHeaders(res, contentType);
      // sendFile supports HTTP Range requests, which phones need to seek in
      // and play video/audio; a bare stream pipe did not.
      return res.sendFile(safe.targetPath, { dotfiles: 'allow', headers: { 'Content-Type': contentType } });
    }

    res.download(safe.targetPath, path.basename(safe.targetPath), { dotfiles: 'allow' });
  });

  // 4. Batch Download as ZIP
  currentApp.post('/api/files/download-zip', authenticateToken, async (req, res) => {
    if (!hasPermission(req.user, 'download', req.body?.currentPath || '')) {
      return res.status(403).json({ error: 'Download permission denied' });
    }

    const { items, currentPath } = req.body;
    if (!items || !items.length) {
      return res.status(400).json({ error: 'No items selected' });
    }

    const cfg = getConfig();
    const zipName = `download_${Date.now()}.zip`;
    res.attachment(zipName);

    const archiverModule = await import('archiver');
    const archive = (archiverModule.default || archiverModule)('zip', { zlib: { level: 6 } });
    archive.pipe(res);

    for (const item of items) {
      const targetSub = path.join(currentPath || '', item);
      const safe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, targetSub);
      if (safe && fs.existsSync(safe.targetPath)) {
        const stat = fs.statSync(safe.targetPath);
        if (stat.isDirectory()) {
          archive.directory(safe.targetPath, item);
        } else {
          archive.file(safe.targetPath, { name: item });
        }
      }
    }

    broadcastLog('download', `User "${req.user.username}" downloaded batch ZIP (${items.length} items)`);
    archive.finalize();
  });

  // 5. Create Directory
  currentApp.post('/api/files/mkdir', authenticateToken, (req, res) => {
    if (!hasPermission(req.user, 'createFolder', req.body?.currentPath || '')) {
      return res.status(403).json({ error: 'Create folder permission denied' });
    }

    const { currentPath } = req.body;
    const folderName = String(req.body.folderName || '').trim();
    // if (!folderName || /[\\/:*?"<>|]/.test(folderName)) {
    if (!isValidItemName(folderName) || isVaultPath(folderName) || folderName.startsWith('.trash')) {
      return res.status(400).json({ error: 'Invalid folder name' });
    }

    const cfg = getConfig();
    const safe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, path.join(currentPath || '', folderName));

    if (!safe) return res.status(400).json({ error: 'Invalid directory path' });
    if (fs.existsSync(safe.targetPath)) {
      return res.status(400).json({ error: 'Folder already exists' });
    }

    fs.mkdirSync(safe.targetPath, { recursive: true });
    broadcastLog('info', `User "${req.user.username}" created folder: "${folderName}"`);
    res.json({ success: true });
  });

  // 6. Delete File or Directory
  currentApp.delete('/api/files', authenticateToken, (req, res) => {
    if (!hasPermission(req.user, 'delete', req.body?.currentPath || '')) {
      return res.status(403).json({ error: 'Delete permission denied' });
    }

    const { items, currentPath } = req.body;
    if (!items || !items.length) {
      return res.status(400).json({ error: 'No items specified' });
    }

    const cfg = getConfig();
    const safe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, '');
    if (!safe) return res.status(400).json({ error: 'Invalid user root directory' });
    const trashDir = path.join(safe.userRoot, '.trash');
    const trashMetaDir = path.join(safe.userRoot, '.trash_meta');
    fs.mkdirSync(trashDir, { recursive: true });
    fs.mkdirSync(trashMetaDir, { recursive: true });

    let deletedCount = 0;

    for (const item of items) {
      const itemSubPath = path.join(currentPath || '', item);
      const safeItem = resolveSafePath(cfg.sharedFolder, req.user.folderScope, itemSubPath);
      // Deleting "." or "" would move the user's whole root into its own trash.
      if (safeItem && path.resolve(safeItem.targetPath) === path.resolve(safeItem.userRoot)) continue;
      if (safeItem && isVaultPath(path.relative(safeItem.userRoot, safeItem.targetPath))) continue;
      if (safeItem && fs.existsSync(safeItem.targetPath)) {
        // const trashId = `${Date.now()}_${item}`;
        // An item like "sub/file.txt" produced a trash id with a slash in it,
        // which pointed into a folder that does not exist and failed.
        const trashId = `${Date.now()}_${path.basename(String(item))}`;
        const trashDest = path.join(trashDir, trashId);
        
        // Save original metadata for restore
        const meta = {
          trashId,
          originalName: item,
          originalRelPath: itemSubPath.replace(/\\/g, '/'),
          deletedAt: new Date().toISOString()
        };
        fs.writeFileSync(path.join(trashMetaDir, `${trashId}.json`), JSON.stringify(meta), 'utf8');

        // Move to trash folder
        try {
          fs.renameSync(safeItem.targetPath, trashDest);
          deletedCount++;
        } catch (err) {
          // A file open in another program (common on Windows) cannot be moved.
          try { fs.rmSync(path.join(trashMetaDir, `${trashId}.json`), { force: true }); } catch (e) {}
          broadcastLog('warning', `Could not move "${item}" to Trash: ${err.code === 'EBUSY' || err.code === 'EPERM' ? 'the file is in use' : err.message}`);
        }
      }
    }

    broadcastLog('warning', `User "${req.user.username}" moved ${deletedCount} item(s) to Trash: ${items.join(', ')}`);
    if (deletedCount === 0) {
      return res.status(409).json({ error: 'Nothing was moved to Trash. The item may be open in another program.' });
    }
    res.json({ success: true, count: deletedCount });
  });

  // 6b. List Trash Items
  currentApp.get('/api/trash', authenticateToken, (req, res) => {
    const cfg = getConfig();
    const safe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, '');
    if (!safe) return res.status(400).json({ error: 'Invalid user root directory' });
    const trashDir = path.join(safe.userRoot, '.trash');
    const trashMetaDir = path.join(safe.userRoot, '.trash_meta');

    if (!fs.existsSync(trashDir)) {
      return res.json({ items: [] });
    }

    try {
      const files = fs.readdirSync(trashDir);
      const items = files.map(file => {
        const full = path.join(trashDir, file);
        const metaFile = path.join(trashMetaDir, `${file}.json`);
        let meta = { originalName: file, originalRelPath: file, deletedAt: new Date() };
        if (fs.existsSync(metaFile)) {
          try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch(e) {}
        }
        try {
          const stats = fs.statSync(full);
          return {
            trashId: file,
            name: meta.originalName || file,
            originalRelPath: meta.originalRelPath || file,
            isDirectory: stats.isDirectory(),
            size: stats.isDirectory() ? null : stats.size,
            deletedAt: meta.deletedAt || stats.mtime
          };
        } catch(e) {
          return null;
        }
      }).filter(Boolean);

      res.json({ items });
    } catch(err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 6c. Restore from Trash
  currentApp.post('/api/trash/restore', authenticateToken, (req, res) => {
    const { trashId } = req.body;
    if (!trashId) return res.status(400).json({ error: 'Trash ID required' });
    // trashId used to be joined straight into a path, so "../../x" could
    // restore (move) any file on the server into the drive.
    if (!isValidTrashId(trashId)) return res.status(400).json({ error: 'Invalid trash ID' });

    const cfg = getConfig();
    const safe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, '');
    if (!safe) return res.status(400).json({ error: 'Invalid user root directory' });
    const trashDir = path.join(safe.userRoot, '.trash');
    const trashMetaDir = path.join(safe.userRoot, '.trash_meta');
    const trashItem = path.join(trashDir, trashId);
    const metaFile = path.join(trashMetaDir, `${trashId}.json`);

    if (!fs.existsSync(trashItem)) {
      return res.status(404).json({ error: 'Item not found in trash' });
    }

    let originalRel = trashId.replace(/^\d+_/, '');
    if (fs.existsSync(metaFile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
        if (meta.originalRelPath) originalRel = meta.originalRelPath;
      } catch(e) {}
    }

    const restoreSafe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, originalRel);
    if (!restoreSafe) return res.status(400).json({ error: 'Invalid restore path' });

    // Ensure parent dir exists
    fs.mkdirSync(path.dirname(restoreSafe.targetPath), { recursive: true });

    // Handle name collision
    let destPath = restoreSafe.targetPath;
    if (fs.existsSync(destPath)) {
      const ext = path.extname(destPath);
      const base = path.basename(destPath, ext);
      destPath = path.join(path.dirname(destPath), `${base}_restored_${Date.now()}${ext}`);
    }

    fs.renameSync(trashItem, destPath);
    if (fs.existsSync(metaFile)) fs.rmSync(metaFile, { force: true });

    broadcastLog('info', `User "${req.user.username}" restored item: "${path.basename(destPath)}"`);
    res.json({ success: true });
  });

  // 6d. Permanently Delete from Trash or Empty Trash
  currentApp.delete('/api/trash', authenticateToken, (req, res) => {
    const { trashId, emptyAll } = req.body;
    const cfg = getConfig();
    const safe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, '');
    if (!safe) return res.status(400).json({ error: 'Invalid user root directory' });
    const trashDir = path.join(safe.userRoot, '.trash');
    const trashMetaDir = path.join(safe.userRoot, '.trash_meta');

    if (emptyAll) {
      if (fs.existsSync(trashDir)) fs.rmSync(trashDir, { recursive: true, force: true });
      if (fs.existsSync(trashMetaDir)) fs.rmSync(trashMetaDir, { recursive: true, force: true });
      broadcastLog('warning', `User "${req.user.username}" emptied their Trash`);
      return res.json({ success: true });
    }

    if (!trashId) return res.status(400).json({ error: 'Trash ID required' });
    // Without this check "../../" in trashId deleted arbitrary folders on the server.
    if (!isValidTrashId(trashId)) return res.status(400).json({ error: 'Invalid trash ID' });
    const trashItem = path.join(trashDir, trashId);
    const metaFile = path.join(trashMetaDir, `${trashId}.json`);

    if (fs.existsSync(trashItem)) fs.rmSync(trashItem, { recursive: true, force: true });
    if (fs.existsSync(metaFile)) fs.rmSync(metaFile, { force: true });

    broadcastLog('warning', `User "${req.user.username}" permanently deleted trash item: "${trashId}"`);
    res.json({ success: true });
  });

  // 7. Rename / Move
  currentApp.post('/api/files/rename', authenticateToken, (req, res) => {
    if (!hasPermission(req.user, 'rename', req.body?.currentPath || '')) {
      return res.status(403).json({ error: 'Rename permission denied' });
    }

    const { currentPath, oldName } = req.body;
    const newName = String(req.body.newName || '').trim();
    // if (!newName || /[\\/:*?"<>|]/.test(newName)) {
    if (!isValidItemName(newName) || isVaultPath(newName) || newName.startsWith('.trash')) {
      return res.status(400).json({ error: 'Invalid new name' });
    }
    if (!isValidItemName(oldName)) {
      return res.status(400).json({ error: 'Invalid item name' });
    }

    const cfg = getConfig();
    const safeOld = resolveSafePath(cfg.sharedFolder, req.user.folderScope, path.join(currentPath || '', oldName));
    const safeNew = resolveSafePath(cfg.sharedFolder, req.user.folderScope, path.join(currentPath || '', newName));

    if (!safeOld || !safeNew || !fs.existsSync(safeOld.targetPath)) {
      return res.status(404).json({ error: 'Original item not found' });
    }
    // Renaming onto an existing name silently overwrote that file. A case-only
    // change ("photo.JPG" -> "photo.jpg") is the same file on Windows and allowed.
    const caseOnly = safeOld.targetPath.toLowerCase() === safeNew.targetPath.toLowerCase();
    if (!caseOnly && fs.existsSync(safeNew.targetPath)) {
      return res.status(409).json({ error: `An item named "${newName}" already exists here` });
    }

    try {
      fs.renameSync(safeOld.targetPath, safeNew.targetPath);
    } catch (err) {
      return res.status(409).json({ error: err.code === 'EBUSY' || err.code === 'EPERM' ? 'The item is in use by another program' : `Rename failed: ${err.message}` });
    }
    const oldRel = path.relative(safeOld.userRoot, safeOld.targetPath).replace(/\\/g, '/');
    const newRel = path.relative(safeNew.userRoot, safeNew.targetPath).replace(/\\/g, '/');
    const oldMeta = getUserMetadata(req.user.id)[oldRel];
    if (oldMeta) { updateFileMeta(req.user.id, newRel, oldMeta); updateFileMeta(req.user.id, oldRel, {}); }
    broadcastLog('info', `User "${req.user.username}" renamed "${oldName}" to "${newName}"`);
    res.json({ success: true });
  });

  // 7b. Move Item(s) into Destination Folder (Drag & Drop or Action)
  currentApp.post('/api/files/move', authenticateToken, (req, res) => {
    // if (!hasPermission(req.user, 'rename', req.body?.currentPath || '')) {
    // Move has its own permission flag (canMove); only canRename was checked, so
    // users granted canMove alone were blocked. Either flag now allows a move,
    // matching the single "Rename & Move" checkbox in the admin UI.
    if (!hasPermission(req.user, 'move', req.body?.currentPath || '') && !hasPermission(req.user, 'rename', req.body?.currentPath || '')) {
      return res.status(403).json({ error: 'Move permission denied' });
    }

    const { currentPath, items, targetFolder } = req.body;
    if (!items || !items.length || !targetFolder) {
      return res.status(400).json({ error: 'Items and destination folder are required' });
    }

    const cfg = getConfig();
    const destSubPath = path.join(currentPath || '', targetFolder);
    const safeDest = resolveSafePath(cfg.sharedFolder, req.user.folderScope, destSubPath);

    if (!safeDest || !fs.existsSync(safeDest.targetPath) || !fs.statSync(safeDest.targetPath).isDirectory()) {
      return res.status(400).json({ error: 'Target directory does not exist' });
    }

    let movedCount = 0;
    const movedNames = [];

    for (const item of items) {
      if (item === targetFolder) continue; // cannot move folder into itself
      const srcSub = path.join(currentPath || '', item);
      const safeSrc = resolveSafePath(cfg.sharedFolder, req.user.folderScope, srcSub);
      // Moving a folder into one of its own subfolders throws EINVAL and used
      // to crash the request with a 500.
      if (safeSrc) {
        const inside = path.relative(safeSrc.targetPath, safeDest.targetPath);
        if (inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside))) continue;
      }
      if (safeSrc && fs.existsSync(safeSrc.targetPath)) {
        let destFile = path.join(safeDest.targetPath, item);
        // If file already exists in destination, handle renaming collision
        if (fs.existsSync(destFile)) {
          const ext = path.extname(item);
          const base = path.basename(item, ext);
          destFile = path.join(safeDest.targetPath, `${base}_${Date.now()}${ext}`);
        }
        try {
          fs.renameSync(safeSrc.targetPath, destFile);
        } catch (err) {
          broadcastLog('warning', `Could not move "${item}": ${err.message}`);
          continue;
        }
        const oldRel = path.relative(safeSrc.userRoot, safeSrc.targetPath).replace(/\\/g, '/');
        const newRel = path.relative(safeDest.userRoot, destFile).replace(/\\/g, '/');
        const oldMeta = getUserMetadata(req.user.id)[oldRel];
        if (oldMeta) { updateFileMeta(req.user.id, newRel, oldMeta); updateFileMeta(req.user.id, oldRel, {}); }
        movedCount++;
        movedNames.push(item);
      }
    }

    broadcastLog('info', `User "${req.user.username}" moved ${movedCount} item(s) to "${targetFolder}": ${movedNames.join(', ')}`);
    res.json({ success: true, count: movedCount });
  });

  // 7c. Comprehensive Storage Breakdown Analytics
  currentApp.get('/api/storage/breakdown', authenticateToken, (req, res) => {
    const cfg = getConfig();
    const safe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, '');
    if (!safe) return res.status(400).json({ error: 'Invalid user root directory' });

    const breakdown = {
      docs: { size: 0, count: 0, color: '#3B82F6', label: 'Documents' },
      images: { size: 0, count: 0, color: '#10B981', label: 'Images' },
      videos: { size: 0, count: 0, color: '#EC4899', label: 'Videos' },
      audio: { size: 0, count: 0, color: '#8B5CF6', label: 'Audio' },
      archives: { size: 0, count: 0, color: '#F59E0B', label: 'Archives' },
      others: { size: 0, count: 0, color: '#64748B', label: 'Other Files' }
    };

    let totalUsed = 0;
    let totalFiles = 0;
    let totalFolders = 0;

    function scanDir(dir) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.trash')) continue; // Skip trash
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            totalFolders++;
            scanDir(fullPath);
          } else if (entry.isFile()) {
            try {
              const stat = fs.statSync(fullPath);
              const sz = stat.size;
              const ext = (entry.name.split('.').pop() || '').toLowerCase();
              totalUsed += sz;
              totalFiles++;

              if (['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'ppt', 'pptx'].includes(ext)) {
                breakdown.docs.size += sz;
                breakdown.docs.count++;
              } else if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
                breakdown.images.size += sz;
                breakdown.images.count++;
              } else if (['mp4', 'mkv', 'webm', 'mov', 'avi', 'wmv'].includes(ext)) {
                breakdown.videos.size += sz;
                breakdown.videos.count++;
              } else if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) {
                breakdown.audio.size += sz;
                breakdown.audio.count++;
              } else if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) {
                breakdown.archives.size += sz;
                breakdown.archives.count++;
              } else {
                breakdown.others.size += sz;
                breakdown.others.count++;
              }
            } catch (e) {}
          }
        }
      } catch (e) {}
    }

    scanDir(safe.userRoot);

    res.json({
      totalUsed,
      totalFiles,
      totalFolders,
      quotaMB: req.user.quotaMB || 0,
      breakdown
    });
  });

  // 8. Save Text File Content (In-Browser Code / Text Editor)
  currentApp.post('/api/files/save-text', authenticateToken, (req, res) => {
    if (!hasPermission(req.user, 'upload', req.body?.filePath || '')) {
      return res.status(403).json({ error: 'Save/write permission denied' });
    }

    const { filePath, content } = req.body;
    const cfg = getConfig();
    const safe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, filePath || '');

    if (!safe) {
      return res.status(400).json({ error: 'Invalid file path' });
    }

    // Ensure parent directory exists (enables creating new note/code files)
    fs.mkdirSync(path.dirname(safe.targetPath), { recursive: true });
    fs.writeFileSync(safe.targetPath, content || '', 'utf8');
    broadcastLog('info', `User "${req.user.username}" saved file: "${path.basename(safe.targetPath)}"`);
    res.json({ success: true });
  });

  // --- ZIP ARCHIVE MANAGER: COMPRESS & EXTRACT ---
  // Compress items into a ZIP archive
  currentApp.post('/api/files/compress', authenticateToken, async (req, res) => {
    if (!hasPermission(req.user, 'upload', req.body?.currentPath || '')) {
      return res.status(403).json({ error: 'Compress/upload permission denied' });
    }
    const { items, currentPath, archiveName } = req.body;
    if (isVaultPath(currentPath) || (items || []).some(isVaultPath)) return res.status(403).json({ error: 'Vault files cannot be archived here' });
    if (!items || !items.length) {
      return res.status(400).json({ error: 'No items selected for compression' });
    }
    const cfg = getConfig();
    const destDirSafe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, currentPath || '');
    if (!destDirSafe || !fs.existsSync(destDirSafe.targetPath)) {
      return res.status(400).json({ error: 'Destination directory does not exist' });
    }

    let cleanName = (archiveName || 'Archive.zip').trim();
    if (!cleanName.toLowerCase().endsWith('.zip')) cleanName += '.zip';
    if (/[\\/:*?"<>|]/.test(cleanName)) cleanName = `Archive_${Date.now()}.zip`;

    const zipDest = path.join(destDirSafe.targetPath, cleanName);

    try {
      const sourceBytes = (items || []).reduce((sum, item) => {
        const itemSafe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, path.join(currentPath || '', item));
        if (!itemSafe || !fs.existsSync(itemSafe.targetPath)) return sum;
        return sum + (fs.statSync(itemSafe.targetPath).isFile() ? fs.statSync(itemSafe.targetPath).size : getFolderSize(itemSafe.targetPath));
      }, 0);
      if (req.user.quotaMB > 0 && getFolderSize(destDirSafe.userRoot) + sourceBytes > req.user.quotaMB * 1024 * 1024) {
        return res.status(413).json({ error: 'Storage quota exceeded by this archive' });
      }
      const archiverModule = await import('archiver');
      const zip = (archiverModule.default || archiverModule)('zip', { zlib: { level: 6 } });
      const output = fs.createWriteStream(zipDest);
      zip.pipe(output);
      for (const item of items) {
        const itemSafe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, path.join(currentPath || '', item));
        if (itemSafe && fs.existsSync(itemSafe.targetPath)) {
          const stat = fs.statSync(itemSafe.targetPath);
          if (stat.isDirectory()) {
            zip.directory(itemSafe.targetPath, item);
          } else {
            zip.file(itemSafe.targetPath, { name: item });
          }
        }
      }
      await zip.finalize();
      await new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); });
      broadcastLog('create', `User "${req.user.username}" created ZIP archive: "${cleanName}" (${items.length} items)`);
      res.json({ success: true, archiveName: cleanName });
    } catch (err) {
      res.status(500).json({ error: `Compression failed: ${err.message}` });
    }
  });

  // Extract a ZIP archive safely
  currentApp.post('/api/files/extract', authenticateToken, async (req, res) => {
    if (!hasPermission(req.user, 'upload', req.body?.currentPath || '')) {
      return res.status(403).json({ error: 'Extract/upload permission denied' });
    }
    const { filePath, createSubfolder } = req.body;
    if (isVaultPath(filePath)) return res.status(403).json({ error: 'Vault files require vault authentication' });
    const cfg = getConfig();
    const safeZip = resolveSafePath(cfg.sharedFolder, req.user.folderScope, filePath || '');
    if (!safeZip || !fs.existsSync(safeZip.targetPath)) {
      return res.status(404).json({ error: 'ZIP file not found' });
    }

    let destDir = path.dirname(safeZip.targetPath);
    if (createSubfolder) {
      const folderName = path.basename(safeZip.targetPath, path.extname(safeZip.targetPath));
      destDir = path.join(destDir, folderName);
    }
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    try {
      const directory = await unzipper.Open.file(safeZip.targetPath);
      const destRoot = path.resolve(destDir) + path.sep;
      const totalUnpacked = directory.files.reduce((n, entry) => n + Number(entry.uncompressedSize || 0), 0);
      if (req.user.quotaMB > 0 && getFolderSize(safeZip.userRoot) + totalUnpacked > req.user.quotaMB * 1024 * 1024) {
        return res.status(413).json({ error: 'Storage quota exceeded by extraction' });
      }
      for (const entry of directory.files) {
        const entryTarget = path.resolve(destDir, entry.path);
        if (entryTarget !== path.resolve(destDir) && !entryTarget.startsWith(destRoot)) {
          return res.status(400).json({ error: 'Malicious zip entry detected (path traversal attempt)' });
        }
        if (entry.type === 'File') {
          await new Promise((resolve, reject) => {
            fs.mkdirSync(path.dirname(entryTarget), { recursive: true });
            entry.stream().pipe(fs.createWriteStream(entryTarget)).on('finish', resolve).on('error', reject);
          });
        } else fs.mkdirSync(entryTarget, { recursive: true });
      }
      broadcastLog('create', `User "${req.user.username}" extracted ZIP: "${path.basename(safeZip.targetPath)}"`);
      res.json({ success: true, targetDir: path.relative(safeZip.userRoot, destDir).replace(/\\/g, '/') });
    } catch (err) {
      res.status(500).json({ error: `Extraction failed: ${err.message}` });
    }
  });

  // --- FILE METADATA: STARRED & COLOR TAGS ---
  currentApp.get('/api/metadata', authenticateToken, (req, res) => {
    const meta = getUserMetadata(req.user.id);
    res.json({ success: true, metadata: meta });
  });

  currentApp.post('/api/metadata', authenticateToken, (req, res) => {
    const { path: itemPath, starred, color } = req.body;
    if (!itemPath) return res.status(400).json({ error: 'Path is required' });
    const updates = {};
    if (starred !== undefined) updates.starred = Boolean(starred);
    if (color !== undefined) updates.color = color || null;
    const updated = updateFileMeta(req.user.id, itemPath, updates);
    res.json({ success: true, item: updated });
  });

  // --- SECURE VAULT WITH PIN ---
  // Helper middleware for vault actions
  function requireVaultAuth(req, res, next) {
    const vToken = req.headers['x-vault-token'] || req.query.vaultToken;
    if (!vToken) return res.status(401).json({ error: 'Vault authentication required' });
    const cfg = getConfig();
    try {
      const decoded = jwt.verify(vToken, cfg.jwtSecret);
      if (decoded.userId !== req.user.id || !decoded.vaultAccess) {
        return res.status(403).json({ error: 'Invalid vault session' });
      }
      req.vaultKey = vaultSessions.get(vToken);
      if (!req.vaultKey) return res.status(403).json({ error: 'Vault session expired. Please re-enter your PIN.' });
      next();
    } catch {
      return res.status(403).json({ error: 'Vault session expired. Please re-enter your PIN.' });
    }
  }

  currentApp.get('/api/vault/status', authenticateToken, (req, res) => {
    const vault = getVaultInfo(req.user.id);
    res.json({ hasPin: !!(vault && vault.pinHash) });
  });

  currentApp.post('/api/vault/pin', authenticateToken, async (req, res) => {
    const { pin, currentPin } = req.body;
    if (!pin || String(pin).length < 4 || String(pin).length > 8) {
      return res.status(400).json({ error: 'PIN must be between 4 and 8 digits/characters' });
    }
    const vault = getVaultInfo(req.user.id);
    if (vault && vault.pinHash) {
      if (!currentPin || !verifyVaultPin(req.user.id, currentPin)) {
        return res.status(401).json({ error: 'Current PIN is incorrect' });
      }
      // Vault files are encrypted with a key derived from the PIN. Changing the
      // PIN without re-encrypting made every existing vault file unreadable
      // forever, so re-key them first (all-or-nothing).
      const cfg = getConfig();
      const vaultSafe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, '.vault');
      if (vaultSafe && fs.existsSync(vaultSafe.targetPath) && String(currentPin) !== String(pin)) {
        const oldKey = deriveVaultKey(String(currentPin));
        const newKey = deriveVaultKey(String(pin));
        const files = fs.readdirSync(vaultSafe.targetPath).filter(n => n.endsWith('.rxv'));
        const staged = [];
        try {
          for (const name of files) {
            const src = path.join(vaultSafe.targetPath, name);
            const plain = `${src}.${process.pid}.plain`;
            const rekeyed = `${src}.${process.pid}.new`;
            await decryptVaultToFile(src, oldKey, plain);
            await encryptFile(plain, rekeyed, newKey);
            fs.rmSync(plain, { force: true });
            staged.push({ src, rekeyed });
          }
        } catch (err) {
          for (const s of staged) { try { fs.rmSync(s.rekeyed, { force: true }); } catch (e) {} }
          for (const name of fs.readdirSync(vaultSafe.targetPath)) {
            if (name.endsWith('.plain') || name.endsWith('.new')) { try { fs.rmSync(path.join(vaultSafe.targetPath, name), { force: true }); } catch (e) {} }
          }
          return res.status(500).json({ error: `PIN not changed: a vault file could not be re-encrypted (${err.message})` });
        }
        for (const s of staged) fs.renameSync(s.rekeyed, s.src);
        // Old unlock sessions hold the old key; drop them.
        for (const [token] of vaultSessions) {
          try { if (jwt.decode(token)?.userId === req.user.id) vaultSessions.delete(token); } catch (e) {}
        }
      }
    }
    setVaultPin(req.user.id, pin);
    broadcastLog('security', `User "${req.user.username}" updated their Secure Vault PIN`);
    res.json({ success: true, message: 'Vault PIN saved successfully' });
  });

  currentApp.post('/api/vault/unlock', authenticateToken, (req, res) => {
    const { pin } = req.body;
    if (!pin) return res.status(400).json({ error: 'PIN is required' });
    const attemptKey = `vault:${req.ip}:${req.user.id}`;
    if (rateLimited(attemptKey, 5, 15 * 60 * 1000)) return res.status(429).json({ error: 'Too many PIN attempts. Try again later.' });
    if (!verifyVaultPin(req.user.id, pin)) {
      return res.status(401).json({ error: 'Incorrect PIN! Access denied.' });
    }
    const cfg = getConfig();
    const vaultToken = jwt.sign(
      { userId: req.user.id, vaultAccess: true },
      cfg.jwtSecret,
      { expiresIn: '2h' }
    );
    broadcastLog('security', `User "${req.user.username}" unlocked their Secure Vault`);
    vaultSessions.set(vaultToken, deriveVaultKey(String(pin)));
    res.json({ success: true, vaultToken });
  });

  currentApp.get('/api/vault/files', authenticateToken, requireVaultAuth, (req, res) => {
    const cfg = getConfig();
    const vaultSafe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, '.vault');
    if (!vaultSafe) return res.status(500).json({ error: 'Failed to access vault' });
    if (!fs.existsSync(vaultSafe.targetPath)) {
      fs.mkdirSync(vaultSafe.targetPath, { recursive: true });
    }
    const items = fs.readdirSync(vaultSafe.targetPath, { withFileTypes: true }).filter(item => item.name.endsWith('.rxv'));
    const files = items.map(item => {
      const full = path.join(vaultSafe.targetPath, item.name);
      try {
        const stats = fs.statSync(full);
        return {
          name: (getVaultInfo(req.user.id)?.files?.[item.name]?.name) || item.name.replace(/\.rxv$/, ''),
          isDirectory: item.isDirectory(),
          size: item.isDirectory() ? null : stats.size,
          updatedAt: stats.mtime,
          mime: item.isDirectory() ? 'folder' : (mime.lookup(item.name) || 'application/octet-stream')
        };
      } catch { return null; }
    }).filter(Boolean);
    res.json({ success: true, files });
  });

  currentApp.post('/api/vault/move-in', authenticateToken, requireVaultAuth, async (req, res) => {
    const { filePath } = req.body;
    if (!filePath) return res.status(400).json({ error: 'File path required' });
    if (isVaultPath(filePath)) return res.status(400).json({ error: 'A vault file cannot be moved into the vault again' });
    const cfg = getConfig();
    const fileSafe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, filePath);
    if (!fileSafe || !fs.existsSync(fileSafe.targetPath)) {
      return res.status(404).json({ error: 'Source file not found' });
    }
    const vaultSafe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, '.vault');
    if (!fs.existsSync(vaultSafe.targetPath)) fs.mkdirSync(vaultSafe.targetPath, { recursive: true });

    const baseName = path.basename(fileSafe.targetPath);
    const sourceStat = fs.statSync(fileSafe.targetPath);
    if (!sourceStat.isFile()) return res.status(400).json({ error: 'Only files can be locked into the vault' });
    let destPath = path.join(vaultSafe.targetPath, `${crypto.randomUUID()}.rxv`);
    if (fs.existsSync(destPath)) {
      const ext = path.extname(baseName);
      const nameOnly = path.basename(baseName, ext);
      destPath = path.join(vaultSafe.targetPath, `${crypto.randomUUID()}.rxv`);
    }
    try { await encryptFile(fileSafe.targetPath, destPath, req.vaultKey); }
    catch (e) {
      try { fs.rmSync(destPath, { force: true }); } catch (err) {}
      return res.status(500).json({ error: `Vault encryption failed: ${e.message}` });
    }
    // Record the entry BEFORE deleting the original. The old code deleted the
    // source and then called statSync on it, which always threw: the request
    // failed after the file was gone and the vault lost its real name.
    const vault = getVaultInfo(req.user.id) || {};
    // vault.files = { ...(vault.files || {}), [path.basename(destPath)]: { name: baseName, size: fs.statSync(fileSafe.targetPath).size, mime: mime.lookup(baseName) || 'application/octet-stream' } };
    vault.files = { ...(vault.files || {}), [path.basename(destPath)]: { name: baseName, size: sourceStat.size, mime: mime.lookup(baseName) || 'application/octet-stream' } };
    updateVaultInfo(req.user.id, { files: vault.files });
    try { fs.rmSync(fileSafe.targetPath, { force: true }); } catch (e) {}
    broadcastLog('security', `User "${req.user.username}" secured file "${baseName}" into Vault`);
    res.json({ success: true, fileName: baseName });
  });

  currentApp.post('/api/vault/move-out', authenticateToken, requireVaultAuth, async (req, res) => {
    const { fileName, targetFolder } = req.body;
    if (!fileName) return res.status(400).json({ error: 'File name required' });
    const cfg = getConfig();
    const vaultInfo = getVaultInfo(req.user.id) || {};
    const storedName = Object.keys(vaultInfo.files || {}).find(k => vaultInfo.files[k].name === fileName) || fileName;
    const vaultSafe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, path.join('.vault', storedName.endsWith('.rxv') ? storedName : `${storedName}.rxv`));
    if (!vaultSafe || !fs.existsSync(vaultSafe.targetPath)) {
      return res.status(404).json({ error: 'Vault file not found' });
    }
    const destDirSafe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, targetFolder || '');
    if (!destDirSafe) return res.status(400).json({ error: 'Invalid destination' });
    if (!fs.existsSync(destDirSafe.targetPath)) fs.mkdirSync(destDirSafe.targetPath, { recursive: true });

    let destPath = path.join(destDirSafe.targetPath, fileName);
    if (fs.existsSync(destPath)) {
      const ext = path.extname(fileName);
      const nameOnly = path.basename(fileName, ext);
      destPath = path.join(destDirSafe.targetPath, `${nameOnly}_restored_${Date.now()}${ext}`);
    }
    const temp = `${destPath}.${process.pid}.tmp`;
    // const output = fs.createWriteStream(temp);
    // decryptVaultStream(vaultSafe.targetPath, req.vaultKey, output).on('finish', () => {
    //   fs.renameSync(temp, destPath); fs.rmSync(vaultSafe.targetPath, { force: true });
    // });
    // The response used to be sent before decryption finished (the drive list
    // then missed the file) and a decryption error crashed the server.
    try {
      await decryptVaultToFile(vaultSafe.targetPath, req.vaultKey, temp);
      fs.renameSync(temp, destPath);
      fs.rmSync(vaultSafe.targetPath, { force: true });
      const storedKey = path.basename(vaultSafe.targetPath);
      if (vaultInfo.files && vaultInfo.files[storedKey]) {
        delete vaultInfo.files[storedKey];
        updateVaultInfo(req.user.id, { files: vaultInfo.files });
      }
    } catch (err) {
      try { fs.rmSync(temp, { force: true }); } catch (e) {}
      return res.status(500).json({ error: `Could not restore file from vault: ${err.message}` });
    }
    broadcastLog('security', `User "${req.user.username}" moved file "${fileName}" from Vault back to Drive`);
    res.json({ success: true, targetPath: path.relative(destDirSafe.userRoot, destPath).replace(/\\/g, '/') });
  });

  currentApp.delete('/api/vault/file', authenticateToken, requireVaultAuth, (req, res) => {
    const { fileName } = req.body;
    if (!fileName) return res.status(400).json({ error: 'File name required' });
    const cfg = getConfig();
    const vaultInfo = getVaultInfo(req.user.id) || {};
    const storedName = Object.keys(vaultInfo.files || {}).find(k => vaultInfo.files[k].name === fileName) || fileName;
    const vaultSafe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, path.join('.vault', storedName.endsWith('.rxv') ? storedName : `${storedName}.rxv`));
    if (!vaultSafe || !fs.existsSync(vaultSafe.targetPath)) {
      return res.status(404).json({ error: 'Vault file not found' });
    }
    fs.unlinkSync(vaultSafe.targetPath);
    const storedKey = path.basename(vaultSafe.targetPath);
    if (vaultInfo.files && vaultInfo.files[storedKey]) {
      delete vaultInfo.files[storedKey];
      updateVaultInfo(req.user.id, { files: vaultInfo.files });
    }
    broadcastLog('security', `User "${req.user.username}" deleted file from Vault: "${fileName}"`);
    res.json({ success: true });
  });

  currentApp.get('/api/vault/download/:fileName', authenticateToken, requireVaultAuth, (req, res) => {
    const { fileName } = req.params;
    const cfg = getConfig();
    const vaultInfo = getVaultInfo(req.user.id) || {};
    const storedName = Object.keys(vaultInfo.files || {}).find(k => vaultInfo.files[k].name === fileName) || fileName;
    const vaultSafe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, path.join('.vault', storedName.endsWith('.rxv') ? storedName : `${storedName}.rxv`));
    if (!vaultSafe || !fs.existsSync(vaultSafe.targetPath)) {
      return res.status(404).json({ error: 'Vault file not found' });
    }
    if (req.query.preview === 'true') {
      const contentType = (vaultInfo.files?.[storedName]?.mime) || 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      // res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
      res.setHeader('Content-Disposition', contentDisposition('inline', fileName));
      setSafePreviewHeaders(res, contentType);
      return decryptVaultStream(vaultSafe.targetPath, req.vaultKey, res);
    }
    // res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', contentDisposition('attachment', fileName));
    return decryptVaultStream(vaultSafe.targetPath, req.vaultKey, res);
  });

  // --- SMART STORAGE CLEANER: DUPLICATES & LARGE FILES ---
  currentApp.get('/api/storage/duplicates', authenticateToken, async (req, res) => {
    const cfg = getConfig();
    const safe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, '');
    if (!safe || !fs.existsSync(safe.userRoot)) return res.status(404).json({ error: 'User root not found' });

    const allFiles = collectAllFiles(safe.userRoot, safe.userRoot);
    const sizeGroups = {};
    for (const f of allFiles) {
      if (f.size <= 0) continue;
      if (!sizeGroups[f.size]) sizeGroups[f.size] = [];
      sizeGroups[f.size].push(f);
    }

    const duplicates = [];
    for (const size in sizeGroups) {
      const group = sizeGroups[size];
      if (group.length > 1) {
        const hashGroups = {};
        for (const file of group) {
          const hash = await getFileHash(file.fullPath);
          if (hash) {
            if (!hashGroups[hash]) hashGroups[hash] = [];
            hashGroups[hash].push({
              path: file.path,
              name: file.name,
              size: file.size,
              updatedAt: file.updatedAt
            });
          }
        }
        for (const hash in hashGroups) {
          if (hashGroups[hash].length > 1) {
            duplicates.push({
              hash,
              size: Number(size),
              files: hashGroups[hash]
            });
          }
        }
      }
    }

    res.json({ success: true, count: duplicates.length, duplicates });
  });

  currentApp.get('/api/storage/large-files', authenticateToken, (req, res) => {
    const cfg = getConfig();
    const safe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, '');
    if (!safe || !fs.existsSync(safe.userRoot)) return res.status(404).json({ error: 'User root not found' });

    const allFiles = collectAllFiles(safe.userRoot, safe.userRoot);
    const sorted = allFiles
      .sort((a, b) => b.size - a.size)
      .slice(0, 50)
      .map(f => ({
        path: f.path,
        name: f.name,
        size: f.size,
        updatedAt: f.updatedAt,
        mime: mime.lookup(f.name) || 'application/octet-stream'
      }));

    res.json({ success: true, files: sorted });
  });

  currentApp.post('/api/storage/clean', authenticateToken, (req, res) => {
    if (!hasPermission(req.user, 'delete', '')) {
      return res.status(403).json({ error: 'Delete permission denied' });
    }
    const { paths } = req.body;
    if (!Array.isArray(paths) || !paths.length) {
      return res.status(400).json({ error: 'No files specified for cleaning' });
    }
    const cfg = getConfig();
    const rootSafe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, '');
    const trashDir = path.join(rootSafe.userRoot, '.trash');
    const trashMetaDir = path.join(rootSafe.userRoot, '.trash_meta');
    fs.mkdirSync(trashDir, { recursive: true }); fs.mkdirSync(trashMetaDir, { recursive: true });
    let deletedCount = 0;
    let freedBytes = 0;

    for (const relPath of paths) {
      const safe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, relPath);
      if (safe && fs.existsSync(safe.targetPath)) {
        try {
          const stat = fs.statSync(safe.targetPath);
          if (stat.isFile()) {
            freedBytes += stat.size;
            const trashId = `${Date.now()}_${path.basename(relPath)}`;
            fs.renameSync(safe.targetPath, path.join(trashDir, trashId));
            fs.writeFileSync(path.join(trashMetaDir, `${trashId}.json`), JSON.stringify({ trashId, originalName: path.basename(relPath), originalRelPath: relPath, deletedAt: new Date().toISOString() }));
            deletedCount++;
          }
        } catch (e) {}
      }
    }

    broadcastLog('delete', `User "${req.user.username}" cleaned ${deletedCount} files (Freed ${(freedBytes / (1024*1024)).toFixed(2)} MB)`);
    res.json({ success: true, deletedCount, freedBytes });
  });

  // 9. Create Public / Password-Protected Share Link
  currentApp.post('/api/shares', authenticateToken, (req, res) => {
    if (!hasPermission(req.user, 'share', req.body?.filePath || '')) {
      return res.status(403).json({ error: 'Share permission denied' });
    }

    const { filePath, password, expiresHours, maxDownloads, permission } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: 'File path required' });
    }
    // Share-link passwords are deliberately short and numeric (they are typed by
    // hand on a phone), but an empty or 1-character secret is no protection.
    if (password !== undefined && password !== null && String(password).trim() !== '') {
      if (!isValidSharePassword(password)) {
        return res.status(400).json({ error: SHARE_PASSWORD_ERROR });
      }
    }
    if (isVaultPath(filePath)) return res.status(403).json({ error: 'Vault files cannot be shared publicly' });

    const cfg = getConfig();
    const safe = resolveSafePath(cfg.sharedFolder, req.user.folderScope, filePath);
    if (!safe || !fs.existsSync(safe.targetPath)) {
      return res.status(404).json({ error: 'File not found on drive' });
    }

    const stat = fs.statSync(safe.targetPath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Folders cannot be shared directly via link' });
    }

    const shares = getShares();
    const shareId = 'sh_' + crypto.randomBytes(6).toString('hex');
    const hrs = Number(expiresHours);
    const expiresAt = hrs > 0 ? new Date(Date.now() + hrs * 3600 * 1000).toISOString() : null;

    const newShare = {
      id: shareId,
      filePath: filePath.replace(/^[\\\/]+/, ''),
      fileName: path.basename(safe.targetPath),
      fileSize: stat.size,
      mime: mime.lookup(safe.targetPath) || 'application/octet-stream',
      permission: permission || 'view',
      // passwordHash: password && password.trim() ? bcrypt.hashSync(password.trim(), 10) : null,
      // A numeric password sent as a JSON number crashed on .trim().
      passwordHash: password !== undefined && password !== null && String(password).trim() ? bcrypt.hashSync(String(password).trim(), 10) : null,
      expiresAt,
      maxDownloads: maxDownloads ? Number(maxDownloads) : null,
      downloadCount: 0,
      createdBy: req.user.username,
      userScope: req.user.folderScope || '',
      createdAt: new Date().toISOString()
    };

    shares.push(newShare);
    saveShares(shares);

    broadcastLog('share', `User "${req.user.username}" created ${newShare.passwordHash ? 'password-protected ' : ''}share for "${newShare.fileName}"`);

    res.json({
      success: true,
      shareId,
      shareUrl: `/share/${shareId}`
    });
  });

  // 10. Public Share Info (Unauthenticated Metadata Fetch)
  currentApp.get('/api/shares/info/:id', (req, res) => {
    const { id } = req.params;
    const shares = getShares();
    const share = shares.find(s => s.id === id);

    if (!share) {
      return res.status(404).json({ error: 'Share link not found or has been revoked' });
    }

    // Check expiration
    if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
      return res.status(410).json({ error: 'This share link has expired', isExpired: true });
    }

    // Check max downloads
    if (share.maxDownloads && share.downloadCount >= share.maxDownloads) {
      return res.status(410).json({ error: 'Download limit has been reached for this link', isExpired: true });
    }

    const cfg = getConfig();
    if (isVaultPath(share.filePath)) return res.status(403).json({ error: 'Vault files cannot be shared publicly' });
    const safe = resolveSafePath(cfg.sharedFolder, share.userScope, share.filePath);
    if (!safe || !fs.existsSync(safe.targetPath)) {
      return res.status(404).json({ error: 'Original file no longer exists' });
    }

    res.json({
      id: share.id,
      fileName: share.fileName,
      fileSize: share.fileSize,
      mime: share.mime,
      hasPassword: !!share.passwordHash,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt,
      downloadCount: share.downloadCount,
      permission: share.permission
    });
  });

  // 11. Verify Share Password
  currentApp.post('/api/shares/verify/:id', (req, res) => {
    const { id } = req.params;
    const { password } = req.body;
    const shares = getShares();
    const share = shares.find(s => s.id === id);

    if (!share) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    if (!share.passwordHash) {
      return res.json({ success: true, message: 'No password required' });
    }

    if (rateLimited(`share:${req.ip}:${id}`, 10)) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    if (!password || !bcrypt.compareSync(String(password).trim(), share.passwordHash)) {
      return res.status(401).json({ error: 'Incorrect password! Please try again.' });
    }

    const cfg = getConfig();
    const shareToken = jwt.sign(
      { shareId: share.id, access: 'granted' },
      cfg.jwtSecret,
      { expiresIn: '3h' }
    );

    res.json({ success: true, shareToken });
  });

  // 12. Public Share Download / Stream
  currentApp.get('/api/shares/download/:id', (req, res) => {
    const { id } = req.params;
    const { token, pwd, preview } = req.query;

    const shares = getShares();
    const share = shares.find(s => s.id === id);

    if (!share) {
      return res.status(404).json({ error: 'Share link not found' });
    }

    if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
      return res.status(410).json({ error: 'This share link has expired' });
    }

    if (share.maxDownloads && share.downloadCount >= share.maxDownloads) {
      return res.status(410).json({ error: 'Download limit has been reached' });
    }

    // If password protected, require valid token or matching password
    if (share.passwordHash) {
      let authorized = false;
      const cfg = getConfig();
      if (token) {
        try {
          const decoded = jwt.verify(token, cfg.jwtSecret);
          if (decoded.shareId === share.id) authorized = true;
        } catch (e) {}
      }
      if (!authorized && pwd && bcrypt.compareSync(String(pwd).trim(), share.passwordHash)) {
        authorized = true;
      }
      if (!authorized) {
        return res.status(401).json({ error: 'Password authentication required' });
      }
    }

    const cfg = getConfig();
    // Checked before any download; it used to run only for inline previews.
    if (isVaultPath(share.filePath)) return res.status(403).json({ error: 'Vault files cannot be shared publicly' });
    const safe = resolveSafePath(cfg.sharedFolder, share.userScope, share.filePath);
    if (!safe || !fs.existsSync(safe.targetPath)) {
      return res.status(404).json({ error: 'Original file no longer exists' });
    }

    if (preview !== 'true') {
      share.downloadCount = (share.downloadCount || 0) + 1;
      saveShares(shares);
      broadcastLog('download', `Public guest downloaded shared file: "${share.fileName}" (Link: ${share.id})`);
      return res.download(safe.targetPath, share.fileName, { dotfiles: 'allow' });
    }

    // if (isVaultPath(share.filePath)) return res.status(403).json({ error: 'Vault files cannot be shared publicly' });
    // Inline preview
    let contentType = mime.lookup(safe.targetPath) || 'application/octet-stream';
    if (path.extname(safe.targetPath).toLowerCase() === '.pdf') {
      contentType = 'application/pdf';
    }
    res.setHeader('Content-Type', contentType);
    // res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(share.fileName)}"`);
    // fs.createReadStream(safe.targetPath).pipe(res);
    res.setHeader('Content-Disposition', contentDisposition('inline', share.fileName));
    setSafePreviewHeaders(res, contentType);
    res.sendFile(safe.targetPath, { dotfiles: 'allow', headers: { 'Content-Type': contentType } });
  });

  // Dedicated Route for Public Share Page
  const shareHtmlPath = path.join(resolvedPublicDir, 'share.html');
  const indexHtmlPath = path.join(resolvedPublicDir, 'index.html');

  currentApp.get(['/share/:id', '/s/:id'], (req, res) => {
    res.sendFile(shareHtmlPath, (err) => {
      if (err) {
        try {
          res.type('html').send(fs.readFileSync(shareHtmlPath, 'utf8'));
        } catch {
          res.status(404).send('Share page not found');
        }
      }
    });
  });

  // Unknown API routes answered with index.html (status 200), so the client's
  // res.json() failed with "Unexpected token '<'". Return JSON instead.
  currentApp.all('/api/{*splat}', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });

  // Fallback for SPA routing
  // Express 5 uses the named wildcard syntax; `*` crashes during app setup.
  currentApp.get('/{*splat}', (req, res) => {
    res.sendFile(indexHtmlPath, (err) => {
      if (err) {
        try {
          res.type('html').send(fs.readFileSync(indexHtmlPath, 'utf8'));
        } catch {
          res.status(404).send('Index page not found');
        }
      }
    });
  });

  // Errors thrown inside routes (disk full, file locked, bad JSON body) came
  // back as Express's HTML error page; the web UI expects JSON.
  currentApp.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    let message = err.message || 'Internal server error';
    if (err.type === 'entity.too.large') message = 'Request is too large';
    else if (err.type === 'entity.parse.failed') message = 'Invalid request body';
    else if (err.code === 'EBUSY' || err.code === 'EPERM') message = 'The file is in use by another program';
    else if (err.code === 'ENOSPC') message = 'The server disk is full';
    if (status >= 500) broadcastLog('error', `${req.method} ${req.path} failed: ${err.message}`);
    res.status(status).json({ error: message });
  });

  return currentApp;
}

// Read the notAfter date of a PEM certificate, or null when unreadable.
function getCertExpiry(certPem) {
  try {
    const cert = new crypto.X509Certificate(certPem);
    const expiry = new Date(cert.validTo);
    return Number.isNaN(expiry.getTime()) ? null : expiry;
  } catch (err) {
    return null;
  }
}

// Load the HTTPS certificate, regenerating it when it is missing, unreadable,
// about to expire, or lacking the hostnames this machine actually answers on.
// The old certificate only carried the SAN "DNS:Rx Cloude LAN", so no browser
// could ever validate it for an IP address.
async function ensureTlsCertificate(certDir, { renewDays = 30, validDays = 825 } = {}) {
  fs.mkdirSync(certDir, { recursive: true });
  const keyFile = path.join(certDir, 'server.key');
  const certFile = path.join(certDir, 'server.crt');
  const bothExist = fs.existsSync(keyFile) && fs.existsSync(certFile);
  const expectedHosts = getCertificateHosts();

  if (bothExist) {
    try {
      const certPem = fs.readFileSync(certFile);
      const expiry = getCertExpiry(certPem);
      const alt = getCertificateAltNames(certPem);
      const missingHosts = expectedHosts.filter(host => !alt.some(a => a.toLowerCase().endsWith(host.toLowerCase())));
      const fresh = expiry && expiry.getTime() - Date.now() > renewDays * 24 * 60 * 60 * 1000;

      if (fresh && missingHosts.length === 0) {
        return { key: fs.readFileSync(keyFile), cert: certPem, regenerated: false, expiresAt: expiry };
      }
      if (!fresh) {
        broadcastLog('warning', `HTTPS certificate ${expiry ? `expires ${expiry.toISOString()}` : 'is unreadable'}; regenerating.`);
      } else {
        broadcastLog('info', `HTTPS certificate does not cover ${missingHosts.join(', ')}; regenerating.`);
      }
    } catch (err) {
      broadcastLog('warning', `HTTPS certificate could not be read (${err.message}); regenerating.`);
    }
  }

  // Include every address the drive can be reached on, so the browser at least
  // has a chance to accept the certificate. selfsigned expects the list under
  // `altNames` (type 2 = DNS, type 7 = IP).
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    { type: 7, ip: '::1' },
    ...getNetworkIPs().map(ip => ({ type: 7, ip })),
  ];
  if (os.hostname()) altNames.push({ type: 2, value: os.hostname() });

  const generated = await selfsigned.generate(
    [{ name: 'commonName', value: 'Rx Cloude LAN' }],
    {
      days: validDays,
      keySize: 2048,
      algorithm: 'sha256',
      // selfsigned v5 takes certificate extensions here, not in the subject
      // attributes (passing subjectAltName as an attribute fails with
      // "Cannot get OID for name type ''").
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
    }
  );
  fs.writeFileSync(keyFile, generated.private);
  fs.writeFileSync(certFile, generated.cert);
  const expiresAt = getCertExpiry(generated.cert);
  broadcastLog('info', `HTTPS certificate generated (valid until ${expiresAt ? expiresAt.toISOString() : `~${validDays} days`}, covers ${altNames.map(a => a.value || a.ip).join(', ')}).`);
  return { key: generated.private, cert: generated.cert, regenerated: true, expiresAt };
}

// Read the SAN entries out of a PEM certificate as plain strings.
function getCertificateAltNames(certPem) {
  try {
    const cert = new crypto.X509Certificate(certPem);
    const alt = cert.subjectAltName || '';
    return alt.split(',').map(part => part.trim()).filter(Boolean);
  } catch (err) {
    return [];
  }
}

// Hosts/IPs the certificate should cover.
function getCertificateHosts() {
  const hosts = ['localhost', '127.0.0.1', ...getNetworkIPs()];
  if (os.hostname()) hosts.push(os.hostname());
  return hosts;
}

// Start Server Engine
async function startServer(port, folder, callback) {
  if (isRunning) {
    if (callback) callback(new Error('Server is already running'));
    return;
  }

  const appRoot = process.env.RX_CLOUDE_ROOT || (process.pkg ? path.dirname(process.execPath) : process.cwd());
  const cfg = getConfig();
  cfg.port = port || cfg.port || 8080;
  cfg.sharedFolder = folder || cfg.sharedFolder || path.join(appRoot, 'shared_files');
  saveConfig(cfg);

  // Ensure shared folder exists
  if (!fs.existsSync(cfg.sharedFolder)) {
    fs.mkdirSync(cfg.sharedFolder, { recursive: true });
  }

  // Browsers refuse these ports outright (ERR_UNSAFE_PORT), so the server
  // would "run" but nobody could open it. List from Chromium/Firefox.
  const BROWSER_BLOCKED_PORTS = [1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080];
  if (BROWSER_BLOCKED_PORTS.includes(Number(cfg.port))) {
    const friendly = `Port ${cfg.port} is blocked by web browsers (ERR_UNSAFE_PORT). Choose another port, e.g. 8090, 8888 or 9000.`;
    broadcastLog('error', `Server could not start: ${friendly}`);
    if (callback) callback(new Error(friendly));
    setTimeout(() => process.exit(1), 150);
    return;
  }

  // Windows lets us bind 0.0.0.0:PORT even when another program (Apache, IIS,
  // XAMPP...) already owns 127.0.0.1:PORT. The launcher then said "Running"
  // while http://localhost:PORT opened the other program. Refuse such a port.
  const portTaken = await new Promise((resolve) => {
    const net = require('net');
    const probe = net.connect({ host: '127.0.0.1', port: Number(cfg.port) });
    const done = (taken) => { probe.destroy(); resolve(taken); };
    probe.setTimeout(700, () => done(false));
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
  });
  if (portTaken) {
    const friendly = `Port ${cfg.port} is already in use by another program on this computer (for example Apache/XAMPP/IIS). Choose another port.`;
    broadcastLog('error', `Server could not start: ${friendly}`);
    if (callback) callback(new Error(friendly));
    setTimeout(() => process.exit(1), 150);
    return;
  }

  // First run on this machine: create the admin account now and show the
  // credentials in the console / launcher log, instead of generating a
  // password nobody could ever see.
  const firstPassword = ensureUsersExist();
  if (firstPassword) {
    broadcastLog('security', '================ FIRST RUN ================');
    broadcastLog('security', 'Admin account created. Sign in with:');
    broadcastLog('security', '   Username: admin');
    broadcastLog('security', `   Password: ${firstPassword}`);
    broadcastLog('security', `(also saved in ${FIRST_LOGIN_FILE} until you change it)`);
    broadcastLog('security', '===========================================');
  } else if (fs.existsSync(FIRST_LOGIN_FILE)) {
    broadcastLog('security', `First-login password has not been changed yet. See ${FIRST_LOGIN_FILE}`);
  }

  // Make sure the web UI is available before any route is registered.
  const publicInfo = resolvePublicDir(APP_VERSION);
  resolvedPublicDir = publicInfo.dir;
  if (publicInfo.source === 'missing') {
    broadcastLog('error', 'Web UI assets are missing: neither public/ on disk nor the embedded bundle was found.');
  } else if (publicInfo.source === 'bundle') {
    broadcastLog('info', `Web UI served from the embedded bundle (${resolvedPublicDir}).`);
  }

  app = createServerApp();
  const useHttps = String(process.env.RX_CLOUDE_SCHEME || 'http').toLowerCase() === 'https';
  let tls = null;
  let certExpiry = null;
  if (useHttps) {
    try {
      const certDir = path.join(require('./db').DATA_DIR, 'tls');
      const certificate = await ensureTlsCertificate(certDir);
      certExpiry = certificate.expiresAt || null;
      tls = { key: certificate.key, cert: certificate.cert };
    } catch (e) { broadcastLog('warning', `HTTPS certificate unavailable; falling back to HTTP: ${e.message}`); }
  }
  server = tls ? https.createServer(tls, app) : http.createServer(app);

  // listen() reports bind failures asynchronously through the 'error' event; the
  // listen callback below never runs in that case, so the failure has to be
  // surfaced here. Without this the port-in-use case crashed the engine with a
  // raw stack trace and no explanation.
  let callbackSent = false;
  const failStartup = (err) => {
    isRunning = false;
    let friendly = err && err.message ? err.message : 'Unknown error';
    if (err && err.code === 'EADDRINUSE') {
      friendly = `Port ${cfg.port} is already in use. Close the program using it, or choose another port.`;
    } else if (err && err.code === 'EACCES') {
      friendly = `Access denied for port ${cfg.port}. Try a port above 1024.`;
    } else if (err && err.code === 'EADDRNOTAVAIL') {
      friendly = `The address for port ${cfg.port} is not available on this machine.`;
    }
    broadcastLog('error', `Server could not start: ${friendly}`);
    if (!callbackSent && callback) { callbackSent = true; callback(new Error(friendly)); }
    // No listen callback will run, so exit with a non-zero code for the launcher.
    setTimeout(() => process.exit(1), 150);
  };

  // Attach the error listener BEFORE anything else can emit on this server.
  // WebSocketServer re-emits 'error' on the underlying server, so without a
  // listener the process died with an unhandled 'error' event.
  // server.on('error', failStartup);
  // Registered alongside the IPv6-fallback handler below, this listener also
  // fired on the IPv6 failure and killed the process before the IPv4 retry
  // could bind. It now ignores the one error the fallback handles.
  let usingIpv6 = true;
  server.on('error', (err) => {
    if (usingIpv6 && err && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) return;
    failStartup(err);
  });

  // WebSocket Server for Logs & Real-Time Stats
  wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    // The live log contains usernames, IPs and file names. Anyone on the LAN
    // could open a socket and read it, so only this machine may subscribe.
    const remote = String((req && req.socket && req.socket.remoteAddress) || '');
    if (!/^(::1|127\.|::ffff:127\.)/.test(remote)) {
      ws.close(1008, 'Logs are only available on the server machine');
      return;
    }
    wsClients.add(ws);
    // Send immediate initial status
    ws.send(JSON.stringify({
      event: 'status',
      data: {
        isRunning: true,
        version: APP_VERSION,
        port: cfg.port,
        sharedFolder: cfg.sharedFolder,
        networkIPs: getNetworkIPs()
      }
    }));

    ws.on('close', () => wsClients.delete(ws));
  });

  // Fires once the port is actually bound (dual-stack or IPv4 fallback).
  const onListening = () => {
    isRunning = true;
    const ips = getNetworkIPs();
    broadcastLog('success', `Drive Server v${APP_VERSION} is ONLINE on port ${cfg.port}!`);
    const scheme = tls ? 'https' : 'http';
    broadcastLog('info', `Local: ${scheme}://localhost:${cfg.port}  (also ${scheme}://127.0.0.1:${cfg.port})`);
    ips.forEach(ip => broadcastLog('info', `Network (WiFi/LAN): ${scheme}://${ip}:${cfg.port}`));
    broadcastLog('info', `Serving folder: ${cfg.sharedFolder}`);
    broadcastLog('info', tls
      ? 'Open the address above in a browser. The certificate is self-signed, so accept the warning once.'
      : `Type the address above exactly as shown (include "http://"). Serving ${scheme.toUpperCase()} on this port only.`);

    if (!callbackSent && callback) {
      callbackSent = true;
      callback(null, { port: cfg.port, sharedFolder: cfg.sharedFolder, ips, version: APP_VERSION, certExpiresAt: certExpiry });
    }
    if (process.env.RX_CLOUDE_NO_UPDATE_CHECK !== '1') {
      setTimeout(checkLatestRelease, 5000);
      setInterval(checkLatestRelease, 24 * 60 * 60 * 1000).unref();
    }
  };

  // Bind dual-stack so localhost works whichever family it resolves to, and LAN
  // clients keep working. '::' accepts IPv4 too on Windows; it is unavailable on
  // hosts with IPv6 disabled, so fall back to IPv4-only in that case.
  // let usingIpv6 = true;  (declared above with the main error listener)
  server.once('error', (err) => {
    if (usingIpv6 && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
      broadcastLog('warning', 'IPv6 is unavailable on this machine; listening on IPv4 only.');
      usingIpv6 = false;
      server.listen(cfg.port, '0.0.0.0', onListening);
      return;
    }
    // failStartup(err);  (the main error listener already reports it)
  });

  server.listen(cfg.port, '::', onListening);
}

// Stop Server Engine
function stopServer(callback) {
  if (!isRunning || !server) {
    if (callback) callback(null);
    return;
  }

  server.close(() => {
    isRunning = false;
    broadcastLog('warning', 'Drive Server has been stopped.');
    if (callback) callback(null);
  });
}

module.exports = {
  startServer,
  stopServer,
  isRunning: () => isRunning,
  getNetworkIPs,
  APP_VERSION
};

if (require.main === module) {
  startServer();
}
