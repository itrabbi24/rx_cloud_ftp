const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Keep all application metadata beside the portable app's working directory.
// The launcher already starts from the application folder, so this remains
// compatible with the existing portable EXE workflow.
const APP_ROOT = process.env.RX_CLOUDE_ROOT || (process.pkg ? path.dirname(process.execPath) : process.cwd());
const DATA_DIR = path.join(APP_ROOT, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const DEFAULT_PERMISSIONS = Object.freeze({
  canView: true,
  canPreview: true,
  canUpload: true,
  canDownload: true,
  canCreateFolder: true,
  canRename: false,
  canMove: false,
  canCopy: true,
  canDelete: false,
  canRestore: false,
  canShare: false,
  canManagePermissions: false,
  canEdit: false,
  canViewActivity: false
});

const ADMIN_PERMISSIONS = Object.fromEntries(
  Object.keys(DEFAULT_PERMISSIONS).map(key => [key, true])
);

const DEFAULT_CONFIG = {
  port: 8080,
  sharedFolder: path.join(APP_ROOT, 'shared_files'),
  jwtSecret: crypto.randomBytes(32).toString('hex'),
  allowRegistration: false,
  sessionDays: 7,
  maxUploadMB: 1024, // 1024 MB (1 GB) default global limit, 0 = unlimited
  maxUploadBytes: 50 * 1024 * 1024 * 1024
};

// Hard ceiling used to configure multer before any file bytes are written.
const ABSOLUTE_MAX_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024;

function getSessionDays(config) {
  const value = Number((config || {}).sessionDays);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_CONFIG.sessionDays;
  return Math.min(365, Math.floor(value));
}

// Bytes multer should accept. Limited to the larger of the global MB setting
// and the stored maxUploadBytes, never above the absolute ceiling, so an
// oversized upload is rejected before it lands on disk.
function getUploadByteLimit(config) {
  const cfg = config || {};
  const configured = Number(cfg.maxUploadBytes);
  const fromMB = Number(cfg.maxUploadMB) > 0 ? Number(cfg.maxUploadMB) * 1024 * 1024 : 0;
  const limit = Math.max(
    Number.isFinite(configured) && configured > 0 ? configured : 0,
    fromMB
  );
  if (limit <= 0) return ABSOLUTE_MAX_UPLOAD_BYTES;
  return Math.min(limit, ABSOLUTE_MAX_UPLOAD_BYTES);
}

// Apply an admin settings update onto an existing config object.
function applyConfigUpdate(config, body) {
  const next = { ...config };
  const src = body || {};
  if (src.maxUploadMB !== undefined) {
    next.maxUploadMB = Math.max(0, Math.floor(Number(src.maxUploadMB) || 0));
  }
  if (src.allowRegistration !== undefined) {
    next.allowRegistration = !!src.allowRegistration;
  }
  if (src.sessionDays !== undefined) {
    next.sessionDays = getSessionDays({ sessionDays: Math.max(0, Math.floor(Number(src.sessionDays) || 0)) });
  }
  return next;
}

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function atomicWrite(file, value) {
  ensureStorage();
  const tempFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  const backupFile = path.join(BACKUP_DIR, `${path.basename(file)}.bak`);
  const contents = JSON.stringify(value, null, 2);

  fs.writeFileSync(tempFile, contents, 'utf8');
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, backupFile);
  }
  fs.renameSync(tempFile, file);
}

function readJson(file, fallback) {
  ensureStorage();
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    console.error(`Error reading ${path.basename(file)}:`, err.message);
    const backupFile = path.join(BACKUP_DIR, `${path.basename(file)}.bak`);
    try {
      if (fs.existsSync(backupFile)) {
        return JSON.parse(fs.readFileSync(backupFile, 'utf8'));
      }
    } catch (backupErr) {
      console.error(`Error reading backup ${path.basename(file)}:`, backupErr.message);
    }
  }
  atomicWrite(file, fallback);
  return clone(fallback);
}

function normalizePermissions(permissions, role) {
  const base = role === 'admin' ? ADMIN_PERMISSIONS : DEFAULT_PERMISSIONS;
  return { ...base, ...(permissions || {}) };
}

function normalizeUser(user) {
  const role = user.role === 'admin' ? 'admin' : (user.role || 'user');
  const accessMode = ['own', 'global', 'custom'].includes(user.accessMode)
    ? user.accessMode
    : (user.folderScope ? 'custom' : 'global');

  return {
    ...user,
    role,
    status: user.status || 'active',
    accessMode,
    folderScope: user.folderScope || '',
    quotaMB: Number.isFinite(Number(user.quotaMB)) ? Number(user.quotaMB) : 0,
    permissions: normalizePermissions(user.permissions, role),
    folderPermissions: Array.isArray(user.folderPermissions) ? user.folderPermissions : [],
    mustChangePassword: Boolean(user.mustChangePassword)
  };
}

function getConfig() {
  const config = { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, DEFAULT_CONFIG) };
  if (!config.jwtSecret || config.jwtSecret === 'super-secret-key-ftp-drive-') {
    config.jwtSecret = crypto.randomBytes(32).toString('hex');
    saveConfig(config);
  }
  return config;
}

function saveConfig(config) {
  atomicWrite(CONFIG_FILE, { ...DEFAULT_CONFIG, ...config });
}

const FIRST_LOGIN_FILE = path.join(DATA_DIR, 'FIRST-LOGIN.txt');
let firstLoginPassword = null;

function generateReadablePassword(length) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// Creates the default admin on first run. Returns the generated password when
// the account was created by this call, or null when users already existed.
function ensureUsersExist() {
  firstLoginPassword = null;
  getUsers();
  return firstLoginPassword;
}

// The one-time credentials file is only useful until the password is changed.
function clearFirstLoginFile() {
  try { fs.rmSync(FIRST_LOGIN_FILE, { force: true }); } catch (err) {}
}

function getUsers() {
  const rawUsers = readJson(USERS_FILE, []);
  if (Array.isArray(rawUsers) && rawUsers.length > 0) {
    const users = rawUsers.map(normalizeUser);
    if (JSON.stringify(users) !== JSON.stringify(rawUsers)) saveUsers(users);
    return users;
  }

  // First run on a fresh machine. The generated password used to be thrown
  // away, so nobody could ever log in after moving the exe to a new server.
  // It is now kept readable (short, no look-alike characters), printed by the
  // engine at startup and written to data/FIRST-LOGIN.txt until it is changed.
  // const initialAdminPassword = process.env.RX_CLOUDE_ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url');
  const initialAdminPassword = process.env.RX_CLOUDE_ADMIN_PASSWORD || generateReadablePassword(10);
  firstLoginPassword = initialAdminPassword;
  try {
    ensureStorage();
    fs.writeFileSync(FIRST_LOGIN_FILE, [
      'Rx Cloude - first login',
      '',
      'Username: admin',
      `Password: ${initialAdminPassword}`,
      '',
      'You will be asked to choose a new password after signing in.',
      'This file is deleted automatically once the password is changed.',
      ''
    ].join('\r\n'), 'utf8');
  } catch (err) {
    console.error(`Could not write ${path.basename(FIRST_LOGIN_FILE)}: ${err.message}`);
  }
  const defaultAdmin = normalizeUser({
    id: 'admin_1',
    username: 'admin',
    passwordHash: bcrypt.hashSync(initialAdminPassword, 12),
    role: 'admin',
    accessMode: 'global',
    permissions: ADMIN_PERMISSIONS,
    folderScope: '',
    quotaMB: 0,
    createdAt: new Date().toISOString(),
    mustChangePassword: true
  });
  saveUsers([defaultAdmin]);
  return [defaultAdmin];
}

function saveUsers(users) {
  atomicWrite(USERS_FILE, users.map(normalizeUser));
}

const SHARES_FILE = path.join(DATA_DIR, 'shares.json');
const METADATA_FILE = path.join(DATA_DIR, 'metadata.json');
const VAULT_FILE = path.join(DATA_DIR, 'vault.json');

function getShares() {
  return readJson(SHARES_FILE, []);
}

function saveShares(shares) {
  atomicWrite(SHARES_FILE, shares);
}

function getAllMetadata() {
  return readJson(METADATA_FILE, {});
}

function getUserMetadata(userId) {
  const all = getAllMetadata();
  return all[userId] || {};
}

function saveUserMetadata(userId, meta) {
  const all = getAllMetadata();
  all[userId] = meta;
  atomicWrite(METADATA_FILE, all);
}

function updateFileMeta(userId, relPath, updates) {
  const userMeta = getUserMetadata(userId);
  const cleanPath = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  userMeta[cleanPath] = { ...(userMeta[cleanPath] || {}), ...updates };
  if (!userMeta[cleanPath].starred && !userMeta[cleanPath].color) {
    delete userMeta[cleanPath];
  }
  saveUserMetadata(userId, userMeta);
  return userMeta[cleanPath] || null;
}

function getAllVaults() {
  return readJson(VAULT_FILE, {});
}

function getVaultInfo(userId) {
  const vaults = getAllVaults();
  return vaults[userId] || null;
}

function setVaultPin(userId, pin) {
  const vaults = getAllVaults();
  vaults[userId] = {
    ...(vaults[userId] || {}),
    pinHash: bcrypt.hashSync(String(pin), 10),
    updatedAt: new Date().toISOString()
  };
  atomicWrite(VAULT_FILE, vaults);
  return true;
}

function verifyVaultPin(userId, pin) {
  const vault = getVaultInfo(userId);
  if (!vault || !vault.pinHash) return false;
  return bcrypt.compareSync(String(pin), vault.pinHash);
}

function updateVaultInfo(userId, updates) {
  const vaults = getAllVaults();
  vaults[userId] = { ...(vaults[userId] || {}), ...updates };
  atomicWrite(VAULT_FILE, vaults);
  return vaults[userId];
}

module.exports = {
  DATA_DIR,
  DEFAULT_PERMISSIONS,
  ADMIN_PERMISSIONS,
  DEFAULT_CONFIG,
  ABSOLUTE_MAX_UPLOAD_BYTES,
  getConfig,
  saveConfig,
  getSessionDays,
  getUploadByteLimit,
  applyConfigUpdate,
  getUsers,
  saveUsers,
  ensureUsersExist,
  clearFirstLoginFile,
  FIRST_LOGIN_FILE,
  normalizeUser,
  normalizePermissions,
  getShares,
  saveShares,
  getUserMetadata,
  updateFileMeta,
  getVaultInfo,
  setVaultPin,
  verifyVaultPin,
  updateVaultInfo
};
