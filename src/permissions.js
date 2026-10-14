const path = require('path');

const OPERATION_PERMISSION = Object.freeze({
  view: 'canView',
  preview: 'canPreview',
  upload: 'canUpload',
  download: 'canDownload',
  createFolder: 'canCreateFolder',
  rename: 'canRename',
  move: 'canMove',
  copy: 'canCopy',
  delete: 'canDelete',
  restore: 'canRestore',
  share: 'canShare',
  managePermissions: 'canManagePermissions',
  edit: 'canEdit',
  viewActivity: 'canViewActivity'
});

function isAdmin(user) {
  return user?.role === 'admin';
}

function normalizeRelative(value) {
  return path.posix.normalize(String(value || '').replace(/\\/g, '/')).replace(/^\.\//, '').replace(/^\/+/, '');
}

// function pathWithinScope(user, requestedPath) {
//   if (isAdmin(user)) return true;
//   // The filesystem jail applies folderScope. Here paths are relative to that
//   // jail, so reject only absolute paths and let folder ACLs decide the rest.
//   return !path.isAbsolute(String(requestedPath || ''));
// }
// BUG (since the first version): the browser sends drive paths like "/" and
// "/Folder", which path.isAbsolute() treats as absolute, so EVERY non-admin
// was denied listing, opening and creating folders ("View permission denied")
// while uploads (which strip the slash) still went through. A leading slash
// means "the root of the user's own drive"; only real escapes are rejected.
function pathWithinScope(user, requestedPath) {
  if (isAdmin(user)) return true;
  const raw = String(requestedPath || '').replace(/\\/g, '/');
  // Drive letters (C:/...) and UNC shares (//server/...) point outside the jail.
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith('//')) return false;
  // ".." must not climb above the user's root.
  let depth = 0;
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    depth += part === '..' ? -1 : 1;
    if (depth < 0) return false;
  }
  return true;
}

function hasPermission(user, operation, requestedPath = '') {
  if (!user || user.status === 'inactive') return false;
  if (isAdmin(user)) return true;

  const permissionKey = OPERATION_PERMISSION[operation] || operation;
  if (!pathWithinScope(user, requestedPath)) return false;

  // A custom folder permission can override the user's default operation.
  const requested = normalizeRelative(path.posix.join(user.folderScope || '', requestedPath || ''));
  const matching = (user.folderPermissions || [])
    .filter(item => {
      const folder = normalizeRelative(item.path);
      return requested === folder || requested.startsWith(`${folder}/`);
    })
    .sort((a, b) => normalizeRelative(b.path).length - normalizeRelative(a.path).length)[0];

  if (matching && matching.permissions && Object.prototype.hasOwnProperty.call(matching.permissions, permissionKey)) {
    return Boolean(matching.permissions[permissionKey]);
  }

  return Boolean(user.permissions?.[permissionKey]);
}

// The account created on first run. It is protected: only it can change
// itself, and no one can block, demote or delete it.
function isDefaultAdmin(user) {
  return Boolean(user) && (user.id === 'admin_1' || user.username === 'admin');
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    accessMode: user.accessMode,
    folderScope: user.folderScope,
    quotaMB: user.quotaMB,
    permissions: user.permissions,
    folderPermissions: user.folderPermissions,
    mustChangePassword: Boolean(user.mustChangePassword),
    // Changes whenever the profile picture changes (cache-busting); 0 = none.
    avatarVersion: Number(user.avatarVersion) || 0,
    isDefaultAdmin: isDefaultAdmin(user),
    createdAt: user.createdAt
  };
}

module.exports = {
  OPERATION_PERMISSION,
  isAdmin,
  hasPermission,
  pathWithinScope,
  isDefaultAdmin,
  publicUser
};
