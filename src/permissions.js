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

function pathWithinScope(user, requestedPath) {
  if (isAdmin(user)) return true;
  // The filesystem jail applies folderScope. Here paths are relative to that
  // jail, so reject only absolute paths and let folder ACLs decide the rest.
  return !path.isAbsolute(String(requestedPath || ''));
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
    createdAt: user.createdAt
  };
}

module.exports = {
  OPERATION_PERMISSION,
  isAdmin,
  hasPermission,
  pathWithinScope,
  publicUser
};
