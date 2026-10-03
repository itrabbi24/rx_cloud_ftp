// State Management
let currentUser = null;
let authToken = localStorage.getItem('drive_token') || null;
let currentPath = '/';
let filesList = [];
let currentViewMode = localStorage.getItem('rx_view_mode') || 'grid'; // 'grid' | 'table'
let searchQuery = '';
let currentTab = 'drive';
let selectedCategory = 'all';

// File names come from the disk and can contain quotes, apostrophes or HTML.
// They were pasted raw into onclick='...' handlers, so a name like
// "John's report.pdf" broke every button on its card (and "<img onerror>"
// names could run script). Always pass names through these two helpers.
function escHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function jsArg(value) {
    return escHtml(JSON.stringify(String(value === undefined || value === null ? '' : value)));
}


// DOM Elements
const loginScreen = document.getElementById('loginScreen');
const driveScreen = document.getElementById('driveScreen');
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');

const profileName = document.getElementById('profile-name');
const profileRole = document.getElementById('profile-role');
const profileAvatar = document.getElementById('profile-avatar');
const navUsersBtn = document.getElementById('navUsersBtn');

const viewDrive = document.getElementById('view-drive');
const viewUsers = document.getElementById('view-users');
const viewTrash = document.getElementById('view-trash');
const breadcrumbContainer = document.getElementById('breadcrumb-container');
const foldersGrid = document.getElementById('folders-grid');
const filesGridView = document.getElementById('files-grid-view');
const filesTableView = document.getElementById('files-table-view');
const filesTableBody = document.getElementById('files-table-body');
const fileCount = document.getElementById('file-count');

const storageBar = document.getElementById('storage-bar');
const storageText = document.getElementById('storage-text');

// Init
document.addEventListener('DOMContentLoaded', () => {
    // Version is not secret: show it on the login screen too.
    fetchServerVersion();
    const cachedUser = localStorage.getItem('drive_user');
    if (authToken && cachedUser) {
        currentUser = JSON.parse(cachedUser);
        showDrive();
    } else {
        showLogin();
    }
});

// Login
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.classList.add('hidden');
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login failed');

        authToken = data.token;
        currentUser = data.user;
        localStorage.setItem('drive_token', authToken);
        localStorage.setItem('drive_user', JSON.stringify(currentUser));

        showDrive();
        showToast('Welcome back, ' + currentUser.username + '!');
    } catch (err) {
        loginError.innerText = err.message;
        loginError.classList.remove('hidden');
    }
});

function handleLogout() {
    localStorage.removeItem('drive_token');
    localStorage.removeItem('drive_user');
    authToken = null;
    currentUser = null;
    // A forced first-login dialog must not survive a logout: it stayed on top
    // of the login page (e.g. a stale token from an older install on the same
    // port) and every "Update" failed with "Access token required".
    if (typeof changePassForced !== 'undefined') changePassForced = false;
    const passModal = document.getElementById('changePassModal');
    if (passModal) { passModal.classList.add('hidden'); passModal.classList.remove('flex', 'pass-forced'); }
    showLogin();
}

function showLogin() {
    loginScreen.classList.remove('hidden');
    driveScreen.classList.add('hidden');
    // The login card is inside the DOM from the start, so its <i data-lucide>
    // placeholders were never converted. Without this they render as empty
    // boxes (a bare blue dot where the cloud logo should be).
    if (window.lucide) lucide.createIcons();
}

function showDrive() {
    loginScreen.classList.add('hidden');
    driveScreen.classList.remove('hidden');

    const pName = document.getElementById('profile-name');
    const pRole = document.getElementById('profile-role');
    const pAvatar = document.getElementById('profile-avatar');

    if (pName && currentUser) pName.innerText = currentUser.username;
    if (pRole && currentUser) pRole.innerText = currentUser.role === 'admin' ? 'Super Admin' : 'Standard User';
    if (pAvatar && currentUser) pAvatar.innerText = currentUser.username.charAt(0).toUpperCase();

    if (navUsersBtn) {
        if (currentUser && currentUser.role === 'admin') {
            navUsersBtn.classList.remove('hidden');
        } else {
            navUsersBtn.classList.add('hidden');
        }
    }

    switchViewMode(currentViewMode);
    fetchServerConfig();
    loadDirectory('/');
    if (currentUser && currentUser.mustChangePassword) {
        // setTimeout(() => { openChangePassModal(); showToast('Please change your password first'); }, 250);
        // Re-check: a stale saved login is rejected (and logged out) within these 250 ms.
        setTimeout(() => {
            if (!authToken || !currentUser) return;
            openChangePassModal(true); showToast('Please choose a new password first');
        }, 250);
    }
}

// API Fetch Helper
async function apiFetch(endpoint, options = {}) {
    options.headers = options.headers || {};
    if (authToken) {
        options.headers['Authorization'] = `Bearer ${authToken}`;
    }
    const res = await fetch(endpoint, options);
    if (res.status === 401) {
        handleLogout();
    }
    // An expired login comes back as 403 "Invalid or expired session"; the
    // app used to stay on screen showing that error on every click.
    if (res.status === 403 && authToken) {
        try {
            const body = await res.clone().json();
            if (/expired session|user not found/i.test(body.error || '')) {
                handleLogout();
                showToast('Your session expired. Please sign in again.');
            }
        } catch (e) {}
    }
    // 428 = the server requires a password change before anything else.
    if (res.status === 428 && authToken) {
        openChangePassModal(true);
    }
    return res;
}

// Load Directory
// Big folders take a moment; show skeleton tiles instead of a frozen page,
// and ignore responses from a folder the user has already left.
let directoryRequestId = 0;
function showDirectoryLoading() {
    const tile = '<div class="animate-pulse bg-white border border-gray-200/80 rounded-2xl h-20"></div>';
    const card = '<div class="animate-pulse bg-white border border-gray-200/80 rounded-2xl overflow-hidden"><div class="h-36 bg-gray-100"></div><div class="p-4 space-y-2"><div class="h-3 bg-gray-100 rounded w-3/4"></div><div class="h-2.5 bg-gray-100 rounded w-1/2"></div></div></div>';
    foldersGrid.innerHTML = tile.repeat(4);
    filesGridView.innerHTML = card.repeat(8);
    filesTableBody.innerHTML = `<tr><td colspan="6" class="py-10 text-center text-xs text-gray-400"><span class="inline-flex items-center gap-2"><i data-lucide="loader-2" class="w-4 h-4 animate-spin text-blue-500"></i> Loading files...</span></td></tr>`;
    if (window.lucide) lucide.createIcons();
}

async function loadDirectory(targetPath) {
    const requestId = ++directoryRequestId;
    // Only show the skeleton if the folder does not answer almost instantly.
    const loadingTimer = setTimeout(() => { if (requestId === directoryRequestId) showDirectoryLoading(); }, 150);
    try {
        const res = await apiFetch(`/api/files?path=${encodeURIComponent(targetPath)}`);
        const data = await res.json();
        if (requestId !== directoryRequestId) return; // a newer folder was opened
        if (!res.ok) throw new Error(data.error || 'Failed to load directory');

        currentPath = data.currentPath;
        // filesList = data.files;
        // Natural order: f2 before f10, case-insensitive (the disk order put f10 before f2).
        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
        filesList = (data.files || []).slice().sort((a, b) => collator.compare(a.name, b.name));
        selectedFiles.clear();
        filesRenderLimit = FILES_PAGE_SIZE;
        foldersRenderLimit = FILES_PAGE_SIZE;

        renderBreadcrumbs();
        renderDashboard();

        // Update Quota / Storage Status
        if (data.quota && data.quota.usedBytes !== null && data.quota.usedBytes !== undefined) {
            const usedStr = formatBytes(data.quota.usedBytes || 0);
            if (data.quota.limitMB > 0) {
                const usedMB = data.quota.usedBytes / (1024 * 1024);
                const pct = Math.min(100, Math.round((usedMB / data.quota.limitMB) * 100));
                storageBar.style.width = pct + '%';
                storageText.innerText = `${usedStr} of ${data.quota.limitMB} MB`;
            } else {
                storageBar.style.width = data.quota.usedBytes > 0 ? '12%' : '4%';
                storageText.innerText = `${usedStr} used (Unlimited)`;
            }
            storageText.title = storageText.innerText;
        }
    } catch (err) {
        if (requestId === directoryRequestId) {
            // Do not leave skeleton tiles spinning forever.
            renderDashboard();
            showToast(err.message);
        }
    } finally {
        clearTimeout(loadingTimer);
    }
}

// Rendering thousands of cards at once froze phones. Render in pages and
// let the user (or scrolling) reveal more.
const FILES_PAGE_SIZE = 120;
let filesRenderLimit = FILES_PAGE_SIZE;
let foldersRenderLimit = FILES_PAGE_SIZE;

function appendShowMore(container, shown, total, onMore, asTableRow) {
    if (shown >= total) return;
    const label = `Show more (${total - shown} remaining)`;
    if (asTableRow) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="6" class="py-3 text-center"><button class="show-more-btn px-4 py-2 text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-xl cursor-pointer">${label}</button></td>`;
        tr.querySelector('button').onclick = onMore;
        container.appendChild(tr);
        return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'col-span-full flex justify-center py-2';
    wrap.innerHTML = `<button class="show-more-btn px-4 py-2.5 text-xs font-semibold text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-xl cursor-pointer">${label}</button>`;
    wrap.querySelector('button').onclick = onMore;
    container.appendChild(wrap);
}

// Reveal the next page automatically when the user scrolls near the end.
(function setupAutoShowMore() {
    const scroller = document.getElementById('main-scroll');
    if (!scroller) return;
    scroller.addEventListener('scroll', () => {
        if (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 400) return;
        const btn = document.querySelector('#files-grid-view .show-more-btn, #files-table-body .show-more-btn');
        if (btn && btn.offsetParent !== null) btn.click();
    }, { passive: true });
})();

// Breadcrumbs
function renderBreadcrumbs() {
    breadcrumbContainer.innerHTML = '';
    const parts = currentPath.split('/').filter(Boolean);

    const rootBtn = document.createElement('button');
    rootBtn.className = "hover:text-blue-600 font-medium flex items-center gap-1 cursor-pointer";
    rootBtn.innerHTML = `<i data-lucide="hard-drive" class="w-3.5 h-3.5"></i> My Drive`;
    rootBtn.onclick = () => loadDirectory('/');
    breadcrumbContainer.appendChild(rootBtn);

    let accumulated = '';
    parts.forEach((part, index) => {
        accumulated += '/' + part;
        const target = accumulated;

        const chevron = document.createElement('span');
        chevron.innerHTML = `<i data-lucide="chevron-right" class="w-3 h-3 text-gray-400"></i>`;
        breadcrumbContainer.appendChild(chevron);

        const crumb = document.createElement('button');
        crumb.className = index === parts.length - 1 ? "text-gray-800 font-semibold" : "hover:text-blue-600 font-medium cursor-pointer";
        crumb.innerText = part;
        crumb.onclick = () => loadDirectory(target);
        breadcrumbContainer.appendChild(crumb);
    });

    if (window.lucide) lucide.createIcons();
}

function handleSearch(q) {
    searchQuery = q.toLowerCase();
    filesRenderLimit = FILES_PAGE_SIZE;
    foldersRenderLimit = FILES_PAGE_SIZE;
    renderDashboard();
}

function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll('.nav-btn').forEach(btn => {
        if (btn.getAttribute('data-tab') === tab) {
            btn.className = "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-blue-50 text-blue-700 font-medium text-sm transition-colors cursor-pointer nav-btn";
        } else {
            btn.className = "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-600 hover:bg-gray-100 font-medium text-sm transition-colors cursor-pointer nav-btn";
        }
    });

    viewDrive.classList.add('hidden');
    viewUsers.classList.add('hidden');
    viewTrash.classList.add('hidden');

    if (tab === 'drive') {
        viewDrive.classList.remove('hidden');
        loadDirectory(currentPath);
    } else if (tab === 'users') {
        viewUsers.classList.remove('hidden');
        fetchServerConfig();
        loadUsersTable();
    } else if (tab === 'trash') {
        viewTrash.classList.remove('hidden');
        loadTrashTable();
    }
}

function switchViewMode(mode) {
    currentViewMode = mode;
    localStorage.setItem('rx_view_mode', mode);
    const gridBtn = document.getElementById('grid-view-btn');
    const listBtn = document.getElementById('list-view-btn');

    if (mode === 'grid') {
        if (gridBtn) gridBtn.className = "p-1.5 bg-white shadow-xs text-blue-600 rounded-lg transition-all cursor-pointer";
        if (listBtn) listBtn.className = "p-1.5 text-gray-400 hover:text-gray-700 rounded-lg transition-all cursor-pointer";
        if (filesGridView) filesGridView.classList.remove('hidden');
        if (filesTableView) filesTableView.classList.add('hidden');
    } else {
        if (listBtn) listBtn.className = "p-1.5 bg-white shadow-xs text-blue-600 rounded-lg transition-all cursor-pointer";
        if (gridBtn) gridBtn.className = "p-1.5 text-gray-400 hover:text-gray-700 rounded-lg transition-all cursor-pointer";
        if (filesTableView) filesTableView.classList.remove('hidden');
        if (filesGridView) filesGridView.classList.add('hidden');
    }
    renderFiles();
}

// Render Dashboard
function renderDashboard() {
    renderFolders();
    renderFiles();
}

function getFileMeta(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) {
        return { icon: 'image', color: 'bg-blue-50 text-blue-600' };
    }
    if (['pdf'].includes(ext)) {
        return { icon: 'file-text', color: 'bg-red-50 text-red-600' };
    }
    if (['doc', 'docx', 'txt', 'md'].includes(ext)) {
        return { icon: 'file-text', color: 'bg-indigo-50 text-indigo-600' };
    }
    if (['xls', 'xlsx', 'csv'].includes(ext)) {
        return { icon: 'file-spreadsheet', color: 'bg-emerald-50 text-emerald-600' };
    }
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
        return { icon: 'archive', color: 'bg-purple-50 text-purple-600' };
    }
    if (['mp4', 'mkv', 'webm', 'mov'].includes(ext)) {
        return { icon: 'film', color: 'bg-pink-50 text-pink-600' };
    }
    return { icon: 'file', color: 'bg-gray-50 text-gray-600' };
}

function formatBytes(bytes) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

let selectedFolderColor = 'blue';
let itemToRename = null; // { name, isDirectory }
let starredItems = JSON.parse(localStorage.getItem('rx_starred_items') || '[]');

function isItemStarred(name) {
    return starredItems.includes(`${currentPath}/${name}`);
}

function toggleStarItem(name, event) {
    if (event) event.stopPropagation();
    const key = `${currentPath}/${name}`;
    if (starredItems.includes(key)) {
        starredItems = starredItems.filter(k => k !== key);
        showToast(`Removed "${name}" from Starred`);
    } else {
        starredItems.push(key);
        showToast(`Added "${name}" to Starred`);
    }
    localStorage.setItem('rx_starred_items', JSON.stringify(starredItems));
    closeAnyDropdown();
    renderDashboard();
}

function selectFolderColor(color) {
    selectedFolderColor = color;
    document.querySelectorAll('.color-tag-btn').forEach(btn => {
        if (btn.getAttribute('data-color') === color) {
            btn.className = `w-7 h-7 rounded-full bg-${color === 'rose' ? 'rose' : color === 'amber' ? 'amber' : color === 'emerald' ? 'emerald' : color === 'purple' ? 'purple' : color === 'slate' ? 'slate' : 'blue'}-500 ring-2 ring-offset-2 ring-blue-600 transition-all cursor-pointer color-tag-btn`;
        } else {
            btn.className = `w-7 h-7 rounded-full bg-${btn.getAttribute('data-color') === 'rose' ? 'rose' : btn.getAttribute('data-color') === 'amber' ? 'amber' : btn.getAttribute('data-color') === 'emerald' ? 'emerald' : btn.getAttribute('data-color') === 'purple' ? 'purple' : btn.getAttribute('data-color') === 'slate' ? 'slate' : 'blue'}-500 ring-0 ring-offset-2 ring-transparent transition-all cursor-pointer color-tag-btn`;
        }
    });
}

// Close popup menus on outer click
document.addEventListener('click', (e) => {
    if (!e.target.closest('.action-dropdown-btn') && !e.target.closest('.action-dropdown-menu')) {
        closeAnyDropdown();
    }
});

function closeAnyDropdown() {
    document.querySelectorAll('.action-dropdown-menu').forEach(menu => menu.classList.add('hidden'));
}

function toggleDropdown(menuId, event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById(menuId);
    if (!menu) return;
    const isHidden = menu.classList.contains('hidden');
    closeAnyDropdown();
    if (isHidden) {
        menu.classList.remove('hidden');
        // Reflect the open state for assistive technology.
        document.querySelectorAll('.action-dropdown-btn[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
        const trigger = (event && event.currentTarget) || document.querySelector(`[onclick*="${menuId}"]`);
        if (trigger && trigger.setAttribute) trigger.setAttribute('aria-expanded', 'true');
    }
}

// Render Folders
function renderFolders() {
    foldersGrid.innerHTML = '';
    const folders = filesList.filter(f => f.isDirectory && f.name.toLowerCase().includes(searchQuery));
    const foldersCountEl = document.getElementById('folders-count');
    if (foldersCountEl) foldersCountEl.innerText = folders.length;

    if (folders.length === 0) {
        foldersGrid.innerHTML = `<div class="col-span-full py-6 text-center text-xs text-gray-400">No folders here.</div>`;
        return;
    }

    const folderColors = [
        { border: 'border-blue-200/80', icon: 'text-blue-500', fill: 'fill-blue-500/20' },
        { border: 'border-emerald-200/80', icon: 'text-emerald-500', fill: 'fill-emerald-500/20' },
        { border: 'border-amber-200/80', icon: 'text-amber-500', fill: 'fill-amber-500/20' },
        { border: 'border-purple-200/80', icon: 'text-purple-500', fill: 'fill-purple-500/20' }
    ];

    // folders.forEach((folder, idx) => {
    folders.slice(0, foldersRenderLimit).forEach((folder, idx) => {
        const colorStyle = folderColors[idx % folderColors.length];
        const starred = isItemStarred(folder.name);
        const menuId = `folder-menu-${idx}`;

        const el = document.createElement('div');
        el.setAttribute('data-foldername', folder.name);
        el.draggable = true;
        el.ondragstart = (e) => handleItemDragStart(e, folder.name, true);
        el.ondragend = (e) => handleItemDragEnd(e);
        el.ondragover = (e) => handleFolderDragOver(e, folder.name, el);
        el.ondragleave = (e) => handleFolderDragLeave(e, el);
        el.ondrop = (e) => handleFolderDrop(e, folder.name, el);
        el.className = `folder-card folder-dropzone relative bg-white p-4 rounded-2xl border ${colorStyle.border} hover:shadow-md hover:border-blue-400 transition-all flex flex-col justify-between cursor-pointer group`;
        el.innerHTML = `
            <div class="flex items-start justify-between mb-3" onclick="openFolder(${jsArg(folder.name)})">
                <div class="flex items-center gap-3 flex-1 min-w-0 pr-2">
                    <div class="p-2.5 rounded-xl shrink-0 group-hover:scale-105 transition-transform">
                        <i data-lucide="folder" class="w-6 h-6 ${colorStyle.icon} ${colorStyle.fill}"></i>
                    </div>
                    <div class="truncate">
                        <h3 class="font-semibold text-sm text-gray-900 group-hover:text-blue-600 transition-colors truncate" title="${escHtml(folder.name)}">${escHtml(folder.name)}</h3>
                        <p class="text-xs text-gray-400">${new Date(folder.updatedAt).toLocaleDateString()}</p>
                    </div>
                </div>
                <div class="flex items-center gap-1 shrink-0 relative" onclick="event.stopPropagation()">
                    <button onclick="toggleStarItem(${jsArg(folder.name)}, event)" class="p-1.5 text-${starred ? 'amber-400' : 'gray-300'} hover:text-amber-400 transition-colors cursor-pointer" title="Star Folder">
                        <i data-lucide="star" class="w-4 h-4 ${starred ? 'fill-amber-400' : ''}"></i>
                    </button>
                    <button onclick="toggleDropdown('${menuId}', event)" aria-label="Actions for ${escHtml(folder.name)}" aria-haspopup="menu" aria-expanded="false" class="action-dropdown-btn p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors cursor-pointer">
                        <i data-lucide="more-vertical" class="w-4 h-4"></i>
                    </button>
                    <!-- 3-Dots Dropdown Menu -->
                    <div id="${menuId}" class="action-dropdown-menu hidden absolute right-0 top-8 w-52 bg-white rounded-xl shadow-xl border border-gray-200 py-1.5 z-30 text-xs text-gray-700">
                        <div class="px-3 py-1.5 font-semibold text-gray-400 border-b border-gray-100 truncate">${escHtml(folder.name)}</div>
                        <!-- Folders cannot be shared (the server rejects them), so this item only ever showed an error:
                        <button onclick="openShareModal(${jsArg(folder.name)})" class="w-full px-3.5 py-2 text-left hover:bg-gray-50 flex items-center gap-2.5 cursor-pointer">
                            <i data-lucide="share-2" class="w-4 h-4 text-gray-500"></i> Share Secure Link...
                        </button> -->
                        <button onclick="downloadFolderAsZip(${jsArg(folder.name)})" class="w-full px-3.5 py-2 text-left hover:bg-gray-50 flex items-center gap-2.5 cursor-pointer">
                            <i data-lucide="archive" class="w-4 h-4 text-gray-500"></i> Download as Zip (Stream)
                        </button>
                        <button onclick="toggleStarItem(${jsArg(folder.name)}, event)" class="w-full px-3.5 py-2 text-left hover:bg-gray-50 flex items-center gap-2.5 cursor-pointer">
                            <i data-lucide="star" class="w-4 h-4 ${starred ? 'text-amber-400 fill-amber-400' : 'text-gray-500'}"></i> ${starred ? 'Remove Star' : 'Add to Starred'}
                        </button>
                        <button onclick="openRenameModal(${jsArg(folder.name)}, true)" class="w-full px-3.5 py-2 text-left hover:bg-gray-50 flex items-center gap-2.5 cursor-pointer">
                            <i data-lucide="edit-3" class="w-4 h-4 text-gray-500"></i> Rename
                        </button>
                        <div class="border-t border-gray-100 my-1"></div>
                        <button onclick="deleteItem(${jsArg(folder.name)}, event)" class="w-full px-3.5 py-2 text-left hover:bg-red-50 text-red-600 flex items-center gap-2.5 cursor-pointer">
                            <i data-lucide="trash-2" class="w-4 h-4 text-red-600"></i> Move to Trash
                        </button>
                    </div>
                </div>
            </div>
        `;
        foldersGrid.appendChild(el);
    });
    appendShowMore(foldersGrid, Math.min(foldersRenderLimit, folders.length), folders.length, () => {
        foldersRenderLimit += FILES_PAGE_SIZE;
        renderFolders();
    });

    if (window.lucide) lucide.createIcons();
}

function openFolder(name) {
    const target = currentPath === '/' ? '/' + name : currentPath + '/' + name;
    loadDirectory(target);
}

function setFilterCategory(category) {
    selectedCategory = category;
    document.querySelectorAll('.cat-pill').forEach(btn => {
        if (btn.getAttribute('data-cat') === category) {
            btn.className = "cat-pill px-3 py-1.5 rounded-full font-semibold transition-colors cursor-pointer bg-blue-50 text-blue-600 shrink-0";
        } else {
            btn.className = "cat-pill px-3 py-1.5 rounded-full font-medium transition-colors cursor-pointer text-gray-500 hover:bg-gray-100 shrink-0";
        }
    });
    renderFiles();
}

function matchCategory(fileName, category) {
    if (category === 'all') return true;
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    if (category === 'docs') return ['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'ppt', 'pptx'].includes(ext);
    if (category === 'images') return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext);
    if (category === 'media') return ['mp4', 'mkv', 'webm', 'mov', 'avi', 'mp3', 'wav', 'ogg', 'm4a'].includes(ext);
    if (category === 'code') return ['js', 'ts', 'html', 'css', 'json', 'py', 'java', 'cs', 'cpp', 'c', 'php', 'sql', 'sh', 'md', 'prisma', 'yml', 'yaml'].includes(ext);
    if (category === 'zip') return ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext);
    return true;
}

let selectedFiles = new Set();

function updateBulkActionBar() {
    const bar = document.getElementById('bulk-action-bar');
    const countEl = document.getElementById('bulk-selected-count');
    const thSelectAll = document.getElementById('th-select-all');

    const visibleFiles = filesList.filter(f => !f.isDirectory && f.name.toLowerCase().includes(searchQuery) && matchCategory(f.name, selectedCategory));

    if (selectedFiles.size > 0) {
        if (bar) bar.classList.remove('hidden');
        if (countEl) countEl.innerText = `${selectedFiles.size} item${selectedFiles.size > 1 ? 's' : ''} selected`;
    } else {
        if (bar) bar.classList.add('hidden');
    }

    if (thSelectAll) {
        thSelectAll.checked = visibleFiles.length > 0 && visibleFiles.every(f => selectedFiles.has(f.name));
    }
}

function toggleFileSelection(fileName, event) {
    if (event) event.stopPropagation();
    if (selectedFiles.has(fileName)) {
        selectedFiles.delete(fileName);
    } else {
        selectedFiles.add(fileName);
    }
    updateBulkActionBar();
    syncCheckboxesUI();
}

function selectAllVisibleFiles() {
    const visibleFiles = filesList.filter(f => !f.isDirectory && f.name.toLowerCase().includes(searchQuery) && matchCategory(f.name, selectedCategory));
    if (selectedFiles.size === visibleFiles.length && visibleFiles.length > 0) {
        selectedFiles.clear();
    } else {
        visibleFiles.forEach(f => selectedFiles.add(f.name));
    }
    updateBulkActionBar();
    syncCheckboxesUI();
}

function toggleSelectAllTable(checked) {
    const visibleFiles = filesList.filter(f => !f.isDirectory && f.name.toLowerCase().includes(searchQuery) && matchCategory(f.name, selectedCategory));
    if (checked) {
        visibleFiles.forEach(f => selectedFiles.add(f.name));
    } else {
        selectedFiles.clear();
    }
    updateBulkActionBar();
    syncCheckboxesUI();
}

function clearSelection() {
    selectedFiles.clear();
    updateBulkActionBar();
    syncCheckboxesUI();
}

function syncCheckboxesUI() {
    document.querySelectorAll('.file-row-checkbox').forEach(cb => {
        cb.checked = selectedFiles.has(cb.getAttribute('data-filename'));
    });
    document.querySelectorAll('.file-card-wrapper').forEach(card => {
        const name = card.getAttribute('data-filename');
        if (selectedFiles.has(name)) {
            card.classList.add('ring-2', 'ring-blue-500', 'bg-blue-50/20');
        } else {
            card.classList.remove('ring-2', 'ring-blue-500', 'bg-blue-50/20');
        }
    });
}

// Bulk Actions: Download Zip & Delete
async function downloadSelectedAsZip() {
    const items = Array.from(selectedFiles);
    if (items.length === 0) return;
    showToast(`Generating ZIP for ${items.length} file(s)...`);

    try {
        const res = await apiFetch('/api/files/download-zip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPath, items })
        });
        if (!res.ok) throw new Error('Zip creation failed');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bundle_${Date.now()}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        clearSelection();
    } catch (err) {
        showToast('Download error: ' + err.message);
    }
}

async function deleteSelectedBulk() {
    const items = Array.from(selectedFiles);
    if (items.length === 0) return;
    // if (!confirm(`Move ${items.length} selected item(s) to Trash?`)) return;  (native popup, replaced by SweetAlert2)
    if (!(await rxConfirm({ title: 'Move to Trash?', text: `${items.length} selected item(s) will be moved to Trash. You can restore them later.`, confirmText: 'Move to Trash', danger: true }))) return;

    try {
        const res = await apiFetch('/api/files', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPath, items })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to move to trash');
        showToast(`${items.length} items moved to Trash`);
        clearSelection();
        loadDirectory(currentPath);
    } catch (err) {
        showToast(err.message);
    }
}

// Render Files
function renderFiles() {
    const files = filesList.filter(f => !f.isDirectory && f.name.toLowerCase().includes(searchQuery) && matchCategory(f.name, selectedCategory));
    fileCount.innerText = files.length;

    filesTableBody.innerHTML = '';
    filesGridView.innerHTML = '';

    if (files.length === 0) {
        filesTableBody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-xs text-gray-400">No files found matching criteria.</td></tr>`;
        filesGridView.innerHTML = `<div class="col-span-full py-8 text-center text-xs text-gray-400">No files found matching criteria.</div>`;
        updateBulkActionBar();
        return;
    }

    // files.forEach((file, idx) => {
    files.slice(0, filesRenderLimit).forEach((file, idx) => {
        const meta = getFileMeta(file.name);
        const fullPath = currentPath === '/' ? '/' + file.name : currentPath + '/' + file.name;
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext);
        const fileUrl = `/api/files/download?path=${encodeURIComponent(fullPath)}&preview=true&token=${authToken}`;
        const starred = isItemStarred(file.name);
        const isSelected = selectedFiles.has(file.name);
        const menuId = `file-menu-${idx}`;

        // Table Row matching user reference
        const tr = document.createElement('tr');
        tr.draggable = true;
        tr.ondragstart = (e) => handleItemDragStart(e, file.name, false);
        tr.ondragend = (e) => handleItemDragEnd(e);
        tr.className = `hover:bg-blue-50/30 transition-colors group cursor-pointer ${isSelected ? 'bg-blue-50/20' : ''}`;
        tr.innerHTML = `
            <td class="py-3.5 px-4 text-center" onclick="event.stopPropagation()">
                <input type="checkbox" data-filename="${escHtml(file.name)}" onchange="toggleFileSelection(${jsArg(file.name)}, event)" class="file-row-checkbox w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer" ${isSelected ? 'checked' : ''}>
            </td>
            <td class="py-3.5 px-4 flex items-center gap-3 font-medium text-gray-900" onclick="previewFile(${jsArg(file.name)})">
                ${isImage 
                    ? `<img src="${fileUrl}" loading="lazy" class="w-8 h-8 rounded-lg object-cover border border-gray-200 shrink-0" onerror="this.onerror=null; this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%232563eb%22 stroke-width=%222%22><rect width=%2218%22 height=%2218%22 x=%223%22 y=%223%22 rx=%222%22/><circle cx=%229%22 cy=%229%22 r=%222%22/><path d=%22m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21%22/></svg>'">` 
                    : `<div class="p-2 ${meta.color} rounded-lg shrink-0"><i data-lucide="${meta.icon}" class="w-4 h-4"></i></div>`
                }
                <span class="truncate max-w-xs text-sm">${escHtml(file.name)}</span>
                <!-- <span class="px-1.5 py-0.5 bg-blue-50 text-blue-600 text-[10px] font-semibold rounded border border-blue-200">v1</span> (removed: every file showed a meaningless "v1" badge; there is no versioning) -->
                ${starred ? `<i data-lucide="star" class="w-3.5 h-3.5 text-amber-400 fill-amber-400 shrink-0"></i>` : ''}
            </td>
            <td class="py-3.5 px-6 text-xs text-gray-500 col-owner">You</td>
            <td class="py-3.5 px-6 text-xs text-gray-500">${new Date(file.updatedAt).toLocaleDateString()}</td>
            <td class="py-3.5 px-6 text-xs text-gray-500">${formatBytes(file.size)}</td>
            <td class="py-3.5 px-6 text-right space-x-1 relative" onclick="event.stopPropagation()">
                <button onclick="previewFile(${jsArg(file.name)})" class="text-gray-400 hover:text-blue-600 transition-colors cursor-pointer p-1" title="Preview"><i data-lucide="eye" class="w-4 h-4"></i></button>
                <button onclick="downloadFile(${jsArg(file.name)})" class="text-gray-400 hover:text-gray-700 transition-colors cursor-pointer p-1" title="Download"><i data-lucide="download" class="w-4 h-4"></i></button>
                <button onclick="openShareModal(${jsArg(file.name)})" class="text-gray-400 hover:text-blue-600 transition-colors cursor-pointer p-1" title="Share Link"><i data-lucide="share-2" class="w-4 h-4"></i></button>
                <button onclick="toggleStarItem(${jsArg(file.name)}, event)" class="p-1 text-${starred ? 'amber-400' : 'gray-400'} hover:text-amber-400 transition-colors cursor-pointer" title="Star File">
                    <i data-lucide="star" class="w-4 h-4 ${starred ? 'fill-amber-400' : ''}"></i>
                </button>
                <button onclick="deleteItem(${jsArg(file.name)}, event)" class="text-gray-400 hover:text-red-600 transition-colors cursor-pointer p-1" title="Move to Trash"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
            </td>
        `;
        filesTableBody.appendChild(tr);

        // Grid Card matching CloudDrive Pro reference
        const card = document.createElement('div');
        card.setAttribute('data-filename', file.name);
        card.draggable = true;
        card.ondragstart = (e) => handleItemDragStart(e, file.name, false);
        card.ondragend = (e) => handleItemDragEnd(e);
        card.className = `file-card-wrapper relative bg-white rounded-2xl border border-gray-200/80 hover:border-blue-400 hover:shadow-lg transition-all flex flex-col justify-between overflow-hidden group cursor-pointer ${isSelected ? 'ring-2 ring-blue-500 bg-blue-50/20' : ''}`;
        
        let cardThumbnailHtml = '';
        if (isImage) {
            cardThumbnailHtml = `
                <div class="file-thumb w-full h-36 bg-gray-50 overflow-hidden relative border-b border-gray-100 flex items-center justify-center">
                    <img src="${fileUrl}" alt="${escHtml(file.name)}" loading="lazy" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" onerror="this.parentElement.innerHTML='<div class=\\'flex items-center justify-center h-full text-blue-500\\'><i data-lucide=\\'image\\' class=\\'w-8 h-8\\'></i></div>'; if(window.lucide)lucide.createIcons();">
                    <div class="absolute top-2.5 left-2.5 z-10" onclick="event.stopPropagation()">
                        <input type="checkbox" onchange="toggleFileSelection(${jsArg(file.name)}, event)" class="file-row-checkbox w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer shadow-sm" ${isSelected ? 'checked' : ''}>
                    </div>
                </div>
            `;
        } else if (true) {
            // Same-height thumbnail area as images, so the grid lines up and a
            // document card no longer looks half empty.
            cardThumbnailHtml = `
                <div class="file-thumb w-full h-36 relative border-b border-gray-100 flex flex-col items-center justify-center gap-2 ${meta.color}">
                    <i data-lucide="${meta.icon}" class="w-10 h-10 opacity-90"></i>
                    <span class="text-[10px] font-bold tracking-wider uppercase opacity-70">${escHtml(ext && ext !== file.name.toLowerCase() ? ext : 'file')}</span>
                    <div class="absolute top-2.5 left-2.5 z-10" onclick="event.stopPropagation()">
                        <input type="checkbox" onchange="toggleFileSelection(${jsArg(file.name)}, event)" class="file-row-checkbox w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer shadow-sm" ${isSelected ? 'checked' : ''}>
                    </div>
                </div>
            `;
        } else {
            cardThumbnailHtml = `
                <div class="p-4 pb-0 flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <div onclick="event.stopPropagation()">
                            <input type="checkbox" onchange="toggleFileSelection(${jsArg(file.name)}, event)" class="file-row-checkbox w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 cursor-pointer" ${isSelected ? 'checked' : ''}>
                        </div>
                        <div class="p-2.5 ${meta.color} rounded-xl shadow-xs">
                            <i data-lucide="${meta.icon}" class="w-5 h-5"></i>
                        </div>
                    </div>
                    <!-- <span class="px-1.5 py-0.5 bg-blue-50 text-blue-600 text-[10px] font-semibold rounded border border-blue-200">v1</span> (removed: every file showed a meaningless "v1" badge; there is no versioning) -->
                </div>
            `;
        }

        card.innerHTML = `
            <div onclick="previewFile(${jsArg(file.name)})" class="flex-1 flex flex-col">
                ${cardThumbnailHtml}
                <div class="file-card-body p-4">
                    <h4 class="font-semibold text-sm text-gray-900 truncate mb-1" title="${escHtml(file.name)}">${escHtml(file.name)}</h4>
                    <p class="text-xs text-gray-400">${formatBytes(file.size)} • ${new Date(file.updatedAt).toLocaleDateString()}</p>
                </div>
            </div>
            <div class="file-card-actions flex justify-between items-center px-3 py-2 border-t border-gray-100 bg-gray-50/50" onclick="event.stopPropagation()">
                <div class="flex items-center gap-1">
                    <button onclick="previewFile(${jsArg(file.name)})" class="p-1.5 text-gray-400 hover:text-blue-600 transition-colors rounded-lg hover:bg-white" title="Preview"><i data-lucide="eye" class="w-4 h-4"></i></button>
                    <button onclick="downloadFile(${jsArg(file.name)})" class="p-1.5 text-gray-400 hover:text-gray-700 transition-colors rounded-lg hover:bg-white" title="Download"><i data-lucide="download" class="w-4 h-4"></i></button>
                    <button onclick="openShareModal(${jsArg(file.name)})" class="p-1.5 text-gray-400 hover:text-blue-600 transition-colors rounded-lg hover:bg-white" title="Share"><i data-lucide="share-2" class="w-4 h-4"></i></button>
                </div>
                <div class="relative">
                    <button onclick="toggleDropdown('${menuId}', event)" aria-label="Actions for ${escHtml(file.name)}" aria-haspopup="menu" aria-expanded="false" class="action-dropdown-btn p-1.5 text-gray-400 hover:text-gray-700 transition-colors rounded-lg hover:bg-white cursor-pointer">
                        <i data-lucide="more-vertical" class="w-4 h-4"></i>
                    </button>
                    <!-- File 3-dots Dropdown Menu -->
                    <div id="${menuId}" class="action-dropdown-menu hidden absolute right-0 bottom-8 w-52 bg-white rounded-xl shadow-xl border border-gray-200 py-1.5 z-30 text-xs text-gray-700">
                        <div class="px-3 py-1.5 font-semibold text-gray-400 border-b border-gray-100 truncate">${escHtml(file.name)}</div>
                        <button onclick="previewFile(${jsArg(file.name)})" class="w-full px-3.5 py-2 text-left hover:bg-gray-50 flex items-center gap-2.5 cursor-pointer">
                            <i data-lucide="eye" class="w-4 h-4 text-gray-500"></i> Preview File
                        </button>
                        <button onclick="openShareModal(${jsArg(file.name)})" class="w-full px-3.5 py-2 text-left hover:bg-gray-50 flex items-center gap-2.5 cursor-pointer">
                            <i data-lucide="share-2" class="w-4 h-4 text-gray-500"></i> Share Secure Link...
                        </button>
                        <button onclick="downloadFile(${jsArg(file.name)})" class="w-full px-3.5 py-2 text-left hover:bg-gray-50 flex items-center gap-2.5 cursor-pointer">
                            <i data-lucide="download" class="w-4 h-4 text-gray-500"></i> Download File
                        </button>
                        <button onclick="toggleStarItem(${jsArg(file.name)}, event)" class="w-full px-3.5 py-2 text-left hover:bg-gray-50 flex items-center gap-2.5 cursor-pointer">
                            <i data-lucide="star" class="w-4 h-4 ${starred ? 'text-amber-400 fill-amber-400' : 'text-gray-500'}"></i> ${starred ? 'Remove Star' : 'Add to Starred'}
                        </button>
                        <button onclick="openRenameModal(${jsArg(file.name)}, false)" class="w-full px-3.5 py-2 text-left hover:bg-gray-50 flex items-center gap-2.5 cursor-pointer">
                            <i data-lucide="edit-3" class="w-4 h-4 text-gray-500"></i> Rename
                        </button>
                        <div class="border-t border-gray-100 my-1"></div>
                        <button onclick="deleteItem(${jsArg(file.name)}, event)" class="w-full px-3.5 py-2 text-left hover:bg-red-50 text-red-600 flex items-center gap-2.5 cursor-pointer">
                            <i data-lucide="trash-2" class="w-4 h-4 text-red-600"></i> Move to Trash
                        </button>
                    </div>
                </div>
            </div>
        `;
        filesGridView.appendChild(card);
    });
    const shownFiles = Math.min(filesRenderLimit, files.length);
    const showMoreFiles = () => { filesRenderLimit += FILES_PAGE_SIZE; renderFiles(); };
    appendShowMore(filesGridView, shownFiles, files.length, showMoreFiles);
    appendShowMore(filesTableBody, shownFiles, files.length, showMoreFiles, true);

    updateBulkActionBar();
    if (window.lucide) lucide.createIcons();
}

// Download folder as ZIP
async function downloadFolderAsZip(folderName) {
    closeAnyDropdown();
    showToast(`Streaming Zip download for "${folderName}"...`);
    try {
        const res = await apiFetch('/api/files/download-zip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPath, items: [folderName] })
        });
        if (!res.ok) throw new Error('Zip creation failed');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${folderName}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (err) {
        showToast('Download error: ' + err.message);
    }
}

// Rename Modal functions
function openRenameModal(name, isDirectory) {
    closeAnyDropdown();
    itemToRename = { name, isDirectory };
    const modal = document.getElementById('renameModal');
    const title = document.getElementById('renameModalTitle');
    const input = document.getElementById('renameInput');
    
    title.innerText = isDirectory ? 'Rename Folder' : 'Rename File';
    input.value = name;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    setTimeout(() => {
        input.focus();
        input.select();
    }, 60);
}

function closeRenameModal() {
    const modal = document.getElementById('renameModal');
    modal.classList.remove('flex');
    modal.classList.add('hidden');
    itemToRename = null;
}

document.getElementById('renameForm').onsubmit = async (e) => {
    e.preventDefault();
    if (!itemToRename) return;
    const newName = document.getElementById('renameInput').value.trim();
    if (!newName || newName === itemToRename.name) {
        closeRenameModal();
        return;
    }

    try {
        const res = await apiFetch('/api/files/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                currentPath,
                oldName: itemToRename.name,
                newName
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to rename item');
        showToast(`Renamed to "${newName}"`);
        closeRenameModal();
        loadDirectory(currentPath);
    } catch (err) {
        showToast(err.message);
    }
};

// Download
function downloadFile(name) {
    const fullPath = currentPath === '/' ? '/' + name : currentPath + '/' + name;
    window.location.href = `/api/files/download?path=${encodeURIComponent(fullPath)}&token=${authToken}`;
}

// Delete Item (Move to Trash)
async function deleteItem(name, event) {
    if (event) event.stopPropagation();
    closeAnyDropdown();
    // if (!confirm(`Move "${name}" to Trash? You can restore it anytime.`)) return;  (native popup, replaced by SweetAlert2)
    if (!(await rxConfirm({ title: 'Move to Trash?', text: `"${name}" will be moved to Trash. You can restore it anytime.`, confirmText: 'Move to Trash', danger: true }))) return;

    try {
        const res = await apiFetch('/api/files', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPath, items: [name] })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to move to trash');
        showToast(`"${name}" moved to Trash`);
        loadDirectory(currentPath);
    } catch (err) {
        showToast(err.message);
    }
}

// Custom Modern New Folder Modal
function createNewFolderPrompt() {
    const modal = document.getElementById('newFolderModal');
    const input = document.getElementById('newFolderNameInput');
    input.value = '';
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    setTimeout(() => input.focus(), 60);
}

function closeNewFolderModal() {
    const modal = document.getElementById('newFolderModal');
    modal.classList.remove('flex');
    modal.classList.add('hidden');
}

document.getElementById('newFolderForm').onsubmit = async (e) => {
    e.preventDefault();
    const folderName = document.getElementById('newFolderNameInput').value.trim();
    if (!folderName) return;

    try {
        const res = await apiFetch('/api/files/mkdir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPath, folderName })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to create folder');
        closeNewFolderModal();
        showToast(`Folder "${folderName}" created successfully!`);
        loadDirectory(currentPath);
    } catch (err) {
        showToast(err.message);
    }
};

// Upload Modal Logic
function openUploadModal() {
    document.getElementById('uploadModal').classList.remove('hidden');
    document.getElementById('uploadModal').classList.add('flex');
    document.getElementById('upload-progress-container').classList.add('hidden');
}

function closeUploadModal() {
    document.getElementById('uploadModal').classList.remove('flex');
    document.getElementById('uploadModal').classList.add('hidden');
}

function handleFileSelect(event) {
    // Copy the list first: clearing the input empties the live FileList.
    const files = Array.from(event.target.files || []);
    // Reset so choosing the same file again still triggers a change event.
    event.target.value = '';
    if (files.length > 0) {
        uploadFilesReal(files);
    }
}

function uploadFilesReal(files) {
    if (!files || files.length === 0) return;

    // Client-side Global Max File Upload Limit check
    if (globalServerConfig && globalServerConfig.maxUploadMB > 0) {
        const maxBytes = globalServerConfig.maxUploadMB * 1024 * 1024;
        for (let i = 0; i < files.length; i++) {
            if (files[i].size > maxBytes) {
                const sz = (files[i].size / (1024 * 1024)).toFixed(1);
                showToast(`"${files[i].name}" exceeds limit of ${globalServerConfig.maxUploadMB} MB`);
                // alert(`Upload Denied:\n"${files[i].name}" (${sz} MB) exceeds the global server upload limit of ${globalServerConfig.maxUploadMB} MB.`);  (native popup, replaced by SweetAlert2)
                rxAlert({ title: 'File too large', text: `"${files[i].name}" (${sz} MB) is over the upload limit of ${globalServerConfig.maxUploadMB} MB per file.`, icon: 'error' });
                return;
            }
        }
    }

    const progressContainer = document.getElementById('upload-progress-container');
    const progressBar = document.getElementById('upload-bar');
    const progressText = document.getElementById('upload-percentage');
    const statusText = document.getElementById('upload-status-text');

    progressContainer.classList.remove('hidden');

    const formData = new FormData();
    formData.append('path', currentPath);
    for (let i = 0; i < files.length; i++) {
        // formData.append('files', files[i]);
        // Send the folder-relative path so "Select Folder" keeps its structure
        // (it used to flatten every file into the current folder).
        formData.append('files', files[i], files[i].webkitRelativePath || files[i].name);
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files/upload', true);
    if (authToken) xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);

    xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            progressBar.style.width = pct + '%';
            progressText.innerText = pct + '%';
            statusText.innerText = `Uploading ${files.length} file(s)...`;
        }
    };

    xhr.onload = () => {
        progressContainer.classList.add('hidden');
        progressBar.style.width = '0%';
        if (xhr.status === 401) { handleLogout(); return; }
        if (xhr.status === 200) {
            showToast('Files uploaded successfully!');
            setTimeout(() => {
                closeUploadModal();
                loadDirectory(currentPath);
            }, 600);
        } else {
            let err = 'Upload failed';
            try { err = JSON.parse(xhr.responseText).error; } catch(e) {}
            showToast('Error: ' + err);
        }
    };

    xhr.onerror = () => { progressContainer.classList.add('hidden'); showToast('Upload connection error'); };
    xhr.send(formData);
}

// Drag & drop dropzone
const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('dragover', (e) => e.preventDefault());
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files) {
        uploadFilesReal(e.dataTransfer.files);
    }
});

// ==========================================
// 4. PUBLIC & PASSWORD-PROTECTED SHARE LINKS
// ==========================================
let currentShareTargetFile = '';
let currentShareExpiryHours = 24;

function setShareExpiry(hours, btn) {
    currentShareExpiryHours = hours;
    document.querySelectorAll('.share-expiry-btn').forEach(b => {
        b.className = "share-expiry-btn px-3 py-1.5 border border-gray-200 rounded-xl font-medium text-gray-600 hover:bg-gray-50 cursor-pointer shrink-0";
    });
    btn.className = "share-expiry-btn px-3 py-1.5 bg-blue-600 text-white rounded-xl font-semibold cursor-pointer shrink-0";
}

function openShareModal(name) {
    closeAnyDropdown();
    currentShareTargetFile = name;
    const fullPath = currentPath === '/' ? '/' + name : currentPath + '/' + name;

    document.getElementById('share-file-name').innerText = name;
    document.getElementById('sharePasswordCheckbox').checked = false;
    document.getElementById('sharePasswordContainer').classList.add('hidden');
    document.getElementById('sharePasswordValue').value = '';
    document.getElementById('shareMaxDownloads').value = '';
    document.getElementById('shareResultContainer').classList.add('hidden');
    document.getElementById('share-link-input').value = '';

    // Reset expiry to 24 hours
    currentShareExpiryHours = 24;
    const expiryBtns = document.querySelectorAll('.share-expiry-btn');
    if (expiryBtns.length >= 2) {
        expiryBtns.forEach(b => b.className = "share-expiry-btn px-3 py-1.5 border border-gray-200 rounded-xl font-medium text-gray-600 hover:bg-gray-50 cursor-pointer shrink-0");
        expiryBtns[1].className = "share-expiry-btn px-3 py-1.5 bg-blue-600 text-white rounded-xl font-semibold cursor-pointer shrink-0";
    }

    const modal = document.getElementById('shareModal');
    modal.style.zIndex = '9999';
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    if (window.lucide) lucide.createIcons();
}

function closeShareModal() {
    document.getElementById('shareModal').classList.remove('flex');
    document.getElementById('shareModal').classList.add('hidden');
}

function toggleSharePasswordInput(checked) {
    const container = document.getElementById('sharePasswordContainer');
    if (container) {
        if (checked) {
            container.classList.remove('hidden');
            setTimeout(() => document.getElementById('sharePasswordValue').focus(), 50);
        } else {
            container.classList.add('hidden');
        }
    }
}

// Kept in sync with SHARE_PASSWORD_MIN in server.js.
const SHARE_PASSWORD_MIN = 3;

async function generateShareLink() {
    if (!currentShareTargetFile) return;
    const fullPath = currentPath === '/' ? '/' + currentShareTargetFile : currentPath + '/' + currentShareTargetFile;
    const hasPassword = document.getElementById('sharePasswordCheckbox').checked;
    const password = hasPassword ? document.getElementById('sharePasswordValue').value.trim() : '';
    const maxDownloads = document.getElementById('shareMaxDownloads').value;

    // Same rule the server enforces, checked here so the user gets an instant
    // message instead of a round trip.
    if (hasPassword && password.length < SHARE_PASSWORD_MIN) {
        showToast(`Share link password must be at least ${SHARE_PASSWORD_MIN} digits`);
        document.getElementById('sharePasswordValue').focus();
        return;
    }

    const btn = document.getElementById('btnGenerateShare');
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Generating...`;
    if (window.lucide) lucide.createIcons();

    try {
        const res = await apiFetch('/api/shares', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filePath: fullPath,
                password,
                expiresHours: currentShareExpiryHours,
                maxDownloads: maxDownloads ? Number(maxDownloads) : null
            })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to generate link');

        const fullShareUrl = `${window.location.origin}${data.shareUrl}`;
        document.getElementById('share-link-input').value = fullShareUrl;
        document.getElementById('share-open-tab').href = fullShareUrl;
        document.getElementById('shareResultContainer').classList.remove('hidden');
        showToast('Secure share link generated!');
    } catch (err) {
        showToast(err.message);
    } finally {
        btn.innerHTML = `<i data-lucide="link" class="w-4 h-4"></i> Generate Secure Share Link`;
        if (window.lucide) lucide.createIcons();
    }
}

function copyShareLink() {
    const input = document.getElementById('share-link-input');
    if (!input.value) return;
    input.select();
    navigator.clipboard.writeText(input.value);
    showToast('Public share link copied to clipboard!');
}

// ==========================================
// 5. IN-BROWSER CODE & NOTE EDITOR
// ==========================================
let currentEditorFileName = '';
let currentEditorFullPath = '';
let isEditorNewFile = false;
let isEditorMarkdownPreviewActive = false;

const CODE_EXT_LANGUAGES = {
    js: 'JAVASCRIPT',
    mjs: 'JAVASCRIPT',
    ts: 'TYPESCRIPT',
    html: 'HTML',
    htm: 'HTML',
    css: 'CSS',
    json: 'JSON',
    py: 'PYTHON',
    md: 'MARKDOWN',
    sql: 'SQL',
    txt: 'PLAIN TEXT',
    env: 'ENV CONFIG',
    log: 'LOG FILE',
    xml: 'XML',
    yml: 'YAML',
    yaml: 'YAML',
    sh: 'SHELL',
    bat: 'BATCH',
    ps1: 'POWERSHELL',
    c: 'C',
    cpp: 'C++',
    cs: 'C#',
    java: 'JAVA',
    csv: 'CSV'
};

function getCodeLanguage(fileName) {
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    return CODE_EXT_LANGUAGES[ext] || 'TEXT';
}

function updateEditorLineNumbers() {
    const textarea = document.getElementById('editorTextarea');
    const gutter = document.getElementById('editorLineNumbers');
    if (!textarea || !gutter) return;
    const lines = textarea.value.split('\n');
    const lineCount = lines.length;

    gutter.innerHTML = Array.from({ length: lineCount }, (_, i) => i + 1).join('<br>');
    document.getElementById('editorStatsLines').innerText = `Lines: ${lineCount}`;

    const text = textarea.value;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    document.getElementById('editorStatsWords').innerText = `Words: ${words}`;
    document.getElementById('editorStatsChars').innerText = `Chars: ${text.length}`;
}

function openNewNoteModal() {
    isEditorNewFile = true;
    currentEditorFileName = `note_${new Date().toISOString().slice(0,10)}_${Date.now().toString().slice(-4)}.txt`;
    currentEditorFullPath = currentPath === '/' ? '/' + currentEditorFileName : currentPath + '/' + currentEditorFileName;

    document.getElementById('editorFileName').value = currentEditorFileName;
    document.getElementById('editorTextarea').value = `# Quick Note\nCreated: ${new Date().toLocaleString()}\n\n`;
    document.getElementById('editorSaveStatus').innerText = 'New Document';
    document.getElementById('editorSaveStatus').className = 'text-amber-500 font-sans';

    setupEditorUI();
    document.getElementById('codeEditorModal').classList.remove('hidden');
    document.getElementById('codeEditorModal').classList.add('flex');
    setTimeout(() => {
        document.getElementById('editorTextarea').focus();
    }, 100);
}

async function openCodeEditor(fileName, isNew = false) {
    closePreviewModal();
    isEditorNewFile = isNew;
    currentEditorFileName = fileName;
    currentEditorFullPath = currentPath === '/' ? '/' + fileName : currentPath + '/' + fileName;

    document.getElementById('editorFileName').value = fileName;
    document.getElementById('editorTextarea').value = 'Loading file contents...';
    document.getElementById('editorSaveStatus').innerText = 'Loading...';
    document.getElementById('editorSaveStatus').className = 'text-gray-400 font-sans';

    setupEditorUI();
    document.getElementById('codeEditorModal').classList.remove('hidden');
    document.getElementById('codeEditorModal').classList.add('flex');

    try {
        const fileUrl = `/api/files/download?path=${encodeURIComponent(currentEditorFullPath)}&preview=true&token=${authToken}`;
        const res = await fetch(fileUrl);
        if (!res.ok) throw new Error('Failed to load file text');
        const text = await res.text();
        document.getElementById('editorTextarea').value = text;
        document.getElementById('editorSaveStatus').innerText = 'Ready';
        document.getElementById('editorSaveStatus').className = 'text-gray-400 font-sans';
        updateEditorLineNumbers();
    } catch (err) {
        showToast('Error loading file: ' + err.message);
        document.getElementById('editorTextarea').value = '';
        document.getElementById('editorSaveStatus').innerText = 'Load failed';
        document.getElementById('editorSaveStatus').className = 'text-red-500 font-sans';
    }
}

function setupEditorUI() {
    const ext = (currentEditorFileName.split('.').pop() || '').toLowerCase();
    const lang = getCodeLanguage(currentEditorFileName);
    document.getElementById('editorLanguageBadge').innerText = lang;

    const mdToggle = document.getElementById('btnEditorMdToggle');
    if (ext === 'md') {
        mdToggle.classList.remove('hidden');
    } else {
        mdToggle.classList.add('hidden');
        document.getElementById('editorPreviewSection').classList.add('hidden');
        isEditorMarkdownPreviewActive = false;
    }

    updateEditorLineNumbers();

    const textarea = document.getElementById('editorTextarea');
    const gutter = document.getElementById('editorLineNumbers');

    textarea.onscroll = () => {
        gutter.scrollTop = textarea.scrollTop;
    };

    textarea.oninput = () => {
        updateEditorLineNumbers();
        document.getElementById('editorSaveStatus').innerText = 'Unsaved changes';
        document.getElementById('editorSaveStatus').className = 'text-blue-600 font-sans font-semibold';
        if (isEditorMarkdownPreviewActive) renderMarkdownPreview();
    };

    textarea.onkeydown = (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = textarea.selectionStart;
            const end = textarea.selectionEnd;
            textarea.value = textarea.value.substring(0, start) + '    ' + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + 4;
            updateEditorLineNumbers();
        } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            saveEditorContent();
        }
    };

    document.getElementById('editorFileName').oninput = () => {
        const newName = document.getElementById('editorFileName').value.trim();
        if (newName) {
            document.getElementById('editorLanguageBadge').innerText = getCodeLanguage(newName);
        }
    };

    if (window.lucide) lucide.createIcons();
}

function toggleEditorMarkdownPreview() {
    const previewPane = document.getElementById('editorPreviewSection');
    const btn = document.getElementById('btnEditorMdToggle');

    if (isEditorMarkdownPreviewActive) {
        previewPane.classList.add('hidden');
        isEditorMarkdownPreviewActive = false;
        btn.classList.remove('bg-blue-50', 'text-blue-600', 'border-blue-200');
    } else {
        previewPane.classList.remove('hidden');
        isEditorMarkdownPreviewActive = true;
        btn.classList.add('bg-blue-50', 'text-blue-600', 'border-blue-200');
        renderMarkdownPreview();
    }
}

function renderMarkdownPreview() {
    const raw = document.getElementById('editorTextarea').value;
    const output = document.getElementById('editorMarkdownOutput');
    let html = raw
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/^### (.*$)/gim, '<h3 class="text-base font-bold text-gray-900 mt-4 mb-1">$1</h3>')
        .replace(/^## (.*$)/gim, '<h2 class="text-lg font-bold text-gray-900 mt-4 mb-2 pb-1 border-b border-gray-100">$1</h2>')
        .replace(/^# (.*$)/gim, '<h1 class="text-xl font-black text-gray-900 mt-2 mb-2 pb-1 border-b border-gray-200">$1</h1>')
        .replace(/\*\*(.*?)\*\*/gim, '<strong class="font-bold text-gray-900">$1</strong>')
        .replace(/\*(.*?)\*/gim, '<em class="italic">$1</em>')
        .replace(/`([^`]+)`/gim, '<code class="px-1.5 py-0.5 bg-gray-100 rounded text-red-500 font-mono text-xs">$1</code>')
        .replace(/^[\*\-] (.*$)/gim, '<li class="ml-4 list-disc text-gray-700">$1</li>')
        .replace(/^\d+\. (.*$)/gim, '<li class="ml-4 list-decimal text-gray-700">$1</li>')
        .replace(/\n\n/gim, '<div class="h-3"></div>')
        .replace(/\n/gim, '<br>');
    output.innerHTML = html;
}

async function saveEditorContent() {
    const targetName = document.getElementById('editorFileName').value.trim();
    if (!targetName || /[\\/:*?"<>|]/.test(targetName)) {
        showToast('Please enter a valid file name');
        return;
    }

    const savePath = currentPath === '/' ? '/' + targetName : currentPath + '/' + targetName;
    const content = document.getElementById('editorTextarea').value;
    const btn = document.getElementById('btnSaveEditor');

    btn.innerHTML = `<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> <span>Saving...</span>`;
    if (window.lucide) lucide.createIcons();

    try {
        const res = await apiFetch('/api/files/save-text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filePath: savePath,
                content
            })
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save');

        showToast(`Saved "${targetName}" successfully!`);
        document.getElementById('editorSaveStatus').innerText = 'All changes saved';
        document.getElementById('editorSaveStatus').className = 'text-emerald-600 font-sans font-medium';
        currentEditorFileName = targetName;
        currentEditorFullPath = savePath;
        isEditorNewFile = false;

        loadDirectory(currentPath);
    } catch (err) {
        showToast('Save error: ' + err.message);
        document.getElementById('editorSaveStatus').innerText = 'Save failed';
        document.getElementById('editorSaveStatus').className = 'text-red-500 font-sans';
    } finally {
        btn.innerHTML = `<i data-lucide="save" class="w-3.5 h-3.5"></i> <span>Save</span> <kbd class="hidden sm:inline text-[9px] bg-blue-500/60 px-1 rounded">Ctrl+S</kbd>`;
        if (window.lucide) lucide.createIcons();
    }
}

async function closeCodeEditorModal() {
    const status = document.getElementById('editorSaveStatus').innerText;
    if (status.includes('Unsaved')) {
        // if (!confirm('You have unsaved changes in this document. Are you sure you want to close?')) {  (native popup, replaced by SweetAlert2)
        if (!(await rxConfirm({ title: 'Discard changes?', text: 'This document has unsaved changes. Close without saving?', confirmText: 'Discard', cancelText: 'Keep editing', danger: true }))) {
            return;
        }
    }
    const modal = document.getElementById('codeEditorModal');
    modal.classList.remove('flex');
    modal.classList.add('hidden');
}

// Change Password
// forced = first login: the dialog cannot be dismissed, because every other
// request is refused (428) until the password is changed. Cancelling used to
// leave an empty, broken drive on screen.
let changePassForced = false;
function openChangePassModal(forced) {
    changePassForced = forced === true;
    const modal = document.getElementById('changePassModal');
    modal.classList.toggle('pass-forced', changePassForced);
    const note = document.getElementById('changePassForcedNote');
    if (note) note.classList.toggle('hidden', !changePassForced);
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    setTimeout(() => { const f = document.getElementById('currentPasswordInput'); if (f) f.focus(); }, 60);
}

function closeChangePassModal(afterSuccess) {
    if (changePassForced && afterSuccess !== true) return;
    changePassForced = false;
    document.getElementById('changePassModal').classList.remove('flex');
    document.getElementById('changePassModal').classList.add('hidden');
}

document.getElementById('changePassForm').onsubmit = async (e) => {
    e.preventDefault();
    const oldPassword = document.getElementById('currentPasswordInput').value;
    const newPassword = document.getElementById('newPasswordInput').value;

    if (!authToken) {
        handleLogout();
        showToast('Please sign in first');
        return;
    }
    try {
        const res = await apiFetch('/api/auth/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPassword, newPassword })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to update password');
        showToast('Password changed successfully!');
        const wasForced = changePassForced;
        closeChangePassModal(true);
        document.getElementById('changePassForm').reset();
        if (wasForced && currentUser) {
            currentUser.mustChangePassword = false;
            localStorage.setItem('drive_user', JSON.stringify(currentUser));
            loadDirectory('/');
        }
    } catch (err) {
        showToast(err.message);
    }
};

// Preview
let currentPreviewFile = null;

function previewFile(name) {
    currentPreviewFile = name;
    const ext = (name.split('.').pop() || '').toLowerCase();
    const fullPath = currentPath === '/' ? '/' + name : currentPath + '/' + name;
    const fileUrl = `/api/files/download?path=${encodeURIComponent(fullPath)}&preview=true&token=${authToken}`;

    // Audio files launch directly into floating background mini-player
    if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) {
        openFloatingMediaPlayer(name, false);
        showToast(`Playing audio "${name}" in Floating Mini-Player`);
        return;
    }

    // Code & Text files open in Code Editor
    if (['txt', 'md', 'js', 'json', 'html', 'css', 'py', 'sql', 'env', 'log', 'xml', 'yml', 'yaml', 'sh', 'bat', 'csv'].includes(ext)) {
        openCodeEditor(name, false);
        return;
    }

    document.getElementById('previewTitle').innerText = name;
    const subtitleEl = document.getElementById('previewSubtitle');
    if (subtitleEl) subtitleEl.innerText = `${ext.toUpperCase()} File • ${currentPath}`;
    document.getElementById('btnPreviewDownload').onclick = () => downloadFile(name);
    const shareBtn = document.getElementById('btnPreviewShare');
    if (shareBtn) shareBtn.onclick = () => openShareModal(name);

    const miniBtn = document.getElementById('btnPreviewMiniPlayer');
    if (miniBtn) {
        if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) {
            miniBtn.classList.remove('hidden');
        } else {
            miniBtn.classList.add('hidden');
        }
    }

    const container = document.getElementById('previewContent');
    container.innerHTML = '';

    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) {
        container.innerHTML = `<img src="${fileUrl}" class="max-w-full max-h-[75vh] rounded-xl shadow-md object-contain">`;
    } else if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) {
        container.innerHTML = `<video id="previewVideoEl" controls autoplay src="${fileUrl}" class="max-w-full max-h-[75vh] rounded-xl shadow-md bg-black"></video>`;
    } else if (['pdf'].includes(ext)) {
        container.innerHTML = `
            <div class="w-full h-[75vh] flex flex-col bg-white rounded-xl overflow-hidden border border-gray-200 shadow-sm">
                <div class="px-4 py-2 bg-gray-50 border-b border-gray-200 flex justify-between items-center text-xs text-gray-500">
                    <span class="flex items-center gap-1.5 font-medium text-gray-700">
                        <i data-lucide="file-text" class="w-4 h-4 text-red-500"></i> PDF Document Viewer
                    </span>
                    <a href="${fileUrl}" target="_blank" class="text-blue-600 hover:underline flex items-center gap-1 font-medium">
                        Open in New Tab <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
                    </a>
                </div>
                <iframe src="${fileUrl}#toolbar=1" class="w-full flex-1 border-0 bg-white" title="${escHtml(name)}"></iframe>
            </div>
        `;
    } else {
        container.innerHTML = `
            <div class="text-center py-12 px-6 bg-white rounded-2xl border border-gray-200 max-w-sm">
                <div class="p-3 bg-gray-100 text-gray-500 rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-3">
                    <i data-lucide="file" class="w-6 h-6"></i>
                </div>
                <h4 class="font-semibold text-gray-800 text-sm mb-1">${escHtml(name)}</h4>
                <p class="text-xs text-gray-500 mb-4">Preview not supported for this file format.</p>
                <button onclick="downloadFile(${jsArg(name)})" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-semibold shadow-sm transition-all cursor-pointer">
                    Download File
                </button>
            </div>
        `;
    }

    document.getElementById('previewModal').classList.remove('hidden');
    document.getElementById('previewModal').classList.add('flex');
    if (window.lucide) lucide.createIcons();
}

function closePreviewModal() {
    document.getElementById('previewModal').classList.remove('flex');
    document.getElementById('previewModal').classList.add('hidden');
    // A closed video kept playing (and downloading) in the background.
    const content = document.getElementById('previewContent');
    if (content) content.innerHTML = '';
}

// User Management (Admin)
async function loadUsersTable() {
    const tbody = document.getElementById('users-table-body');
    tbody.innerHTML = `<tr><td colspan="5" class="py-6 text-center text-xs text-gray-400">Loading users...</td></tr>`;

    try {
        const res = await apiFetch('/api/users');
        const users = await res.json();
        if (!res.ok) throw new Error(users.error || 'Failed to load users');

        tbody.innerHTML = '';
        users.forEach(u => {
            const tr = document.createElement('tr');
            tr.className = "hover:bg-gray-50/50 transition-colors";
            tr.innerHTML = `
                <td class="py-3.5 px-6 font-medium text-gray-900 flex items-center gap-3">
                    <div class="w-8 h-8 rounded-full bg-blue-100 text-blue-700 font-bold text-xs flex items-center justify-center shrink-0">
                        ${u.username.charAt(0).toUpperCase()}
                    </div>
                    <div>
                        <div class="font-bold text-gray-800 text-xs">${escHtml(u.username)}</div>
                        <div class="text-[10px] text-gray-400">Created: ${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : 'Initial'}</div>
                    </div>
                </td>
                <td class="py-3.5 px-6"><span class="px-2.5 py-1 text-xs font-semibold rounded-md ${u.role === 'admin' ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-gray-100 text-gray-600'}">${u.role.toUpperCase()}</span></td>
                <td class="py-3.5 px-6 text-xs text-gray-600 font-mono"><code>${u.folderScope ? '/' + u.folderScope : 'Entire Drive (/)'}</code></td>
                <td class="py-3.5 px-6 text-xs font-semibold ${u.quotaMB > 0 ? 'text-gray-700' : 'text-emerald-600'}">${u.quotaMB > 0 ? u.quotaMB + ' MB' : 'Unlimited'}</td>
                <td class="py-3.5 px-6 text-right">
                    ${u.username !== 'admin' ? `<button onclick="deleteUser(${jsArg(u.id)})" class="px-3 py-1 bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 text-xs font-semibold rounded-lg transition-colors cursor-pointer">Delete</button>` : '<span class="text-xs text-gray-400 italic">Default Admin</span>'}
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="5" class="py-6 text-center text-xs text-red-500">${err.message}</td></tr>`;
    }
}

// ==========================================
// 6. GLOBAL SERVER CONFIG & USER MANAGEMENT
// ==========================================
let globalServerConfig = {
    maxUploadMB: 1024,
    allowRegistration: false,
    sessionDays: 7,
    version: '—'
};

// Single place that renders the effective per-file upload ceiling.
// The global MB setting is the real cap; when it is 0 (unlimited) the only
// remaining limit is the absolute 50 GB engine ceiling.
function applyUploadLimitUi(maxUploadMB) {
    const mb = Number(maxUploadMB) || 0;
    const label = mb > 0 ? `${mb} MB` : '50 GB';
    const badge = document.getElementById('modal-max-upload-badge');
    if (badge) badge.innerText = mb > 0 ? `Max: ${mb} MB/file` : 'Max: 50 GB/file';
    const note = document.getElementById('upload-limit-note');
    if (note) note.innerText = `Images, PDFs, documents, media, and archives up to ${label} per file. Directory hierarchy preserved.`;
}

async function fetchServerVersion() {
    try {
        const res = await fetch('/api/version');
        if (!res.ok) return;
        const data = await res.json();
        globalServerConfig.version = data.version || '—';
        globalServerConfig.node = data.node || '';
        applyVersionUi(data.version, data.node);
    } catch (e) {}
}

// Keeps every version stamp on the page in sync (login screen, sidebar,
// settings card). The server is the single source of truth.
function applyVersionUi(version, node) {
    const v = version ? 'v' + version : 'v—';
    const set = (id, text) => { const el = document.getElementById(id); if (el) el.innerText = text; };
    set('loginVersionBadge', v);
    set('sidebarVersionBadge', v);
    set('serverVersionBadge', v);
    // set('sidebarEngineBadge', node ? 'Node ' + node : '—');
    // The runtime version is an internal detail; it stays on the admin settings card only.
    set('sidebarEngineBadge', '');
    set('serverEnvBadge', node ? 'Node runtime ' + node : 'Node runtime unknown');
}

async function fetchServerConfig() {
    fetchServerVersion();
    try {
        const res = await fetch('/api/config');
        if (!res.ok) return;
        const data = await res.json();
        globalServerConfig = { ...globalServerConfig, ...data };

        const badge = document.getElementById('currentLimitBadge');
        if (badge) {
            badge.innerText = data.maxUploadMB > 0 ? `${data.maxUploadMB} MB` : 'Unlimited';
        }

        const input = document.getElementById('settingMaxUploadMB');
        if (input) input.value = data.maxUploadMB;

        const regCheckbox = document.getElementById('settingAllowRegistration');
        if (regCheckbox) regCheckbox.checked = !!data.allowRegistration;

        const sessionInput = document.getElementById('settingSessionDays');
        if (sessionInput && data.sessionDays) sessionInput.value = data.sessionDays;

        const sessionBadge = document.getElementById('currentSessionBadge');
        if (sessionBadge && data.sessionDays) sessionBadge.innerText = `${data.sessionDays} days`;

        applyUploadLimitUi(data.maxUploadMB);
    } catch (e) {}
}

async function saveGlobalServerConfig() {
    const input = document.getElementById('settingMaxUploadMB');
    const regCheckbox = document.getElementById('settingAllowRegistration');
    const sessionInput = document.getElementById('settingSessionDays');
    const btn = document.getElementById('btnSaveConfig');

    const maxUploadMB = Math.max(0, Number(input.value) || 0);
    const allowRegistration = regCheckbox.checked;
    const sessionDays = Math.min(365, Math.max(1, Number(sessionInput && sessionInput.value) || 7));

    btn.innerHTML = `<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> Saving...`;
    if (window.lucide) lucide.createIcons();

    try {
        const res = await apiFetch('/api/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ maxUploadMB, allowRegistration, sessionDays })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save settings');

        // Trust the server's response - it normalises and clamps every value.
        const saved = data.config || {};
        globalServerConfig.maxUploadMB = saved.maxUploadMB !== undefined ? saved.maxUploadMB : maxUploadMB;
        globalServerConfig.allowRegistration = saved.allowRegistration !== undefined ? saved.allowRegistration : allowRegistration;
        globalServerConfig.sessionDays = saved.sessionDays !== undefined ? saved.sessionDays : sessionDays;

        const appliedMB = globalServerConfig.maxUploadMB;
        const appliedDays = globalServerConfig.sessionDays;

        if (input) input.value = appliedMB;
        if (sessionInput) sessionInput.value = appliedDays;

        const badge = document.getElementById('currentLimitBadge');
        if (badge) badge.innerText = appliedMB > 0 ? `${appliedMB} MB` : 'Unlimited';

        const sessionBadge = document.getElementById('currentSessionBadge');
        if (sessionBadge) sessionBadge.innerText = `${appliedDays} days`;

        applyUploadLimitUi(appliedMB);

        showToast(`Server settings saved! Upload limit: ${appliedMB > 0 ? appliedMB + ' MB' : 'Unlimited'}, session: ${appliedDays} days`);
    } catch (err) {
        showToast('Settings error: ' + err.message);
    } finally {
        btn.innerHTML = `<i data-lucide="save" class="w-3.5 h-3.5"></i> Save Settings`;
        if (window.lucide) lucide.createIcons();
    }
}

function setSessionDaysPreset(days) {
    const input = document.getElementById('settingSessionDays');
    if (input) input.value = days;
    const badge = document.getElementById('currentSessionBadge');
    if (badge) badge.innerText = `${days} days`;
}

function setSettingPreset(mb) {
    const input = document.getElementById('settingMaxUploadMB');
    if (input) {
        input.value = mb;
        const badge = document.getElementById('currentLimitBadge');
        if (badge) badge.innerText = mb > 0 ? `${mb} MB` : 'Unlimited';
    }
}

function setUserQuotaPreset(mb) {
    const input = document.getElementById('modalQuota');
    if (input) input.value = mb;
}

function generateRandomUserPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$';
    let pwd = '';
    for (let i = 0; i < 10; i++) {
        pwd += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const input = document.getElementById('modalPassword');
    if (input) {
        input.value = pwd;
        showToast('Generated secure password!');
    }
}

function handleFolderModeChange(mode) {
    const container = document.getElementById('customScopeContainer');
    if (container) {
        if (mode === 'custom') {
            container.classList.remove('hidden');
            const scopeInput = document.getElementById('modalFolderScope');
            if (scopeInput) setTimeout(() => scopeInput.focus(), 50);
        } else {
            container.classList.add('hidden');
        }
    }
}

function openCreateUserModal() {
    document.getElementById('createUserModal').classList.remove('hidden');
    document.getElementById('createUserModal').classList.add('flex');
    document.getElementById('modalUsername').value = '';
    document.getElementById('modalPassword').value = '';
    document.getElementById('modalQuota').value = '1024';
    document.getElementById('modalRole').value = 'user';
    const radios = document.getElementsByName('folderModeRadio');
    if (radios.length > 0) radios[0].checked = true;
    handleFolderModeChange('own');

    // Default permissions
    document.getElementById('permUpload').checked = true;
    document.getElementById('permDownload').checked = true;
    document.getElementById('permCreateFolder').checked = true;
    document.getElementById('permRename').checked = true;
    document.getElementById('permDelete').checked = true;
    document.getElementById('permShare').checked = true;

    if (window.lucide) lucide.createIcons();
}

function closeCreateUserModal() {
    document.getElementById('createUserModal').classList.remove('flex');
    document.getElementById('createUserModal').classList.add('hidden');
}

document.getElementById('createUserForm').onsubmit = async (e) => {
    e.preventDefault();
    const username = document.getElementById('modalUsername').value.trim();
    const password = document.getElementById('modalPassword').value;
    const role = document.getElementById('modalRole').value;
    const quotaMB = Number(document.getElementById('modalQuota').value) || 0;

    let folderScope = '';
    let accessMode = 'own';
    const selectedMode = document.querySelector('input[name="folderModeRadio"]:checked')?.value || 'own';

    if (selectedMode === 'own') {
        accessMode = 'own';
        folderScope = `users/${username}`;
    } else if (selectedMode === 'global') {
        accessMode = 'global';
        folderScope = '';
    } else if (selectedMode === 'custom') {
        accessMode = 'custom';
        folderScope = document.getElementById('modalFolderScope').value.trim();
    }

    const permissions = {
        canView: true,
        canPreview: true,
        canUpload: document.getElementById('permUpload').checked,
        canDownload: document.getElementById('permDownload').checked,
        canCreateFolder: document.getElementById('permCreateFolder').checked,
        canRename: document.getElementById('permRename').checked,
        canMove: document.getElementById('permRename').checked,
        canDelete: document.getElementById('permDelete').checked,
        canRestore: document.getElementById('permDelete').checked,
        canShare: document.getElementById('permShare').checked,
        canEdit: document.getElementById('permUpload').checked
    };

    const payload = {
        username,
        password,
        role,
        accessMode,
        folderScope,
        quotaMB,
        permissions
    };

    try {
        const res = await apiFetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to save user');
        showToast(`User "${username}" created successfully!`);
        closeCreateUserModal();
        loadUsersTable();
    } catch (err) {
        showToast(err.message);
    }
};

async function deleteUser(id) {
    // if (!confirm('Are you sure you want to delete this user?')) return;  (native popup, replaced by SweetAlert2)
    if (!(await rxConfirm({ title: 'Delete this user?', text: 'The account will be removed. Files in their folder stay on the drive.', confirmText: 'Delete user', danger: true }))) return;
    try {
        const res = await apiFetch(`/api/users/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete user');
        showToast('User removed');
        loadUsersTable();
    } catch (err) {
        showToast(err.message);
    }
}

// Trash Bin Management
async function loadTrashTable() {
    const tbody = document.getElementById('trash-table-body');
    tbody.innerHTML = `<tr><td colspan="5" class="py-6 text-center text-xs text-gray-400">Loading trash items...</td></tr>`;

    try {
        const res = await apiFetch('/api/trash');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load trash');

        tbody.innerHTML = '';
        if (!data.items || data.items.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="py-12 text-center text-xs text-gray-400">Trash is empty.</td></tr>`;
            return;
        }

        data.items.forEach(item => {
            const tr = document.createElement('tr');
            tr.className = "hover:bg-gray-50/50 transition-colors";
            tr.innerHTML = `
                <td class="py-3.5 px-6 font-medium text-gray-900 flex items-center gap-2.5">
                    <div class="p-2 bg-gray-100 text-gray-500 rounded-lg">
                        <i data-lucide="${item.isDirectory ? 'folder' : 'file'}" class="w-4 h-4"></i>
                    </div>
                    <span class="truncate max-w-xs text-sm">${escHtml(item.name)}</span>
                </td>
                <td class="py-3.5 px-6 text-xs text-gray-500"><code>${escHtml(item.originalRelPath)}</code></td>
                <td class="py-3.5 px-6 text-xs text-gray-500">${item.size ? formatBytes(item.size) : '—'}</td>
                <td class="py-3.5 px-6 text-xs text-gray-500">${new Date(item.deletedAt).toLocaleDateString()}</td>
                <td class="py-3.5 px-6 text-right space-x-2">
                    <button onclick="restoreTrashItem(${jsArg(item.trashId)})" class="px-2.5 py-1 bg-blue-50 text-blue-600 hover:bg-blue-100 font-medium text-xs rounded-lg transition-colors cursor-pointer inline-flex items-center gap-1">
                        <i data-lucide="rotate-ccw" class="w-3.5 h-3.5"></i> Restore
                    </button>
                    <button onclick="deleteTrashItemPermanently(${jsArg(item.trashId)})" class="px-2.5 py-1 bg-red-50 text-red-600 hover:bg-red-100 font-medium text-xs rounded-lg transition-colors cursor-pointer inline-flex items-center gap-1">
                        <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Delete Forever
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
        if (window.lucide) lucide.createIcons();
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="5" class="py-6 text-center text-xs text-red-500">${err.message}</td></tr>`;
    }
}

async function restoreTrashItem(trashId) {
    try {
        const res = await apiFetch('/api/trash/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trashId })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to restore item');
        showToast('Item restored successfully!');
        loadTrashTable();
    } catch (err) {
        showToast(err.message);
    }
}

async function deleteTrashItemPermanently(trashId) {
    // if (!confirm('Permanently delete this item? This action cannot be undone.')) return;  (native popup, replaced by SweetAlert2)
    if (!(await rxConfirm({ title: 'Delete forever?', text: 'This item will be permanently deleted. This cannot be undone.', confirmText: 'Delete forever', danger: true }))) return;
    try {
        const res = await apiFetch('/api/trash', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trashId })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to delete permanently');
        showToast('Item permanently removed');
        loadTrashTable();
    } catch (err) {
        showToast(err.message);
    }
}

async function emptyTrashAll() {
    // if (!confirm('Are you sure you want to empty the trash bin? All items will be permanently erased.')) return;  (native popup, replaced by SweetAlert2)
    if (!(await rxConfirm({ title: 'Empty Trash?', text: 'All items in Trash will be permanently erased. This cannot be undone.', confirmText: 'Empty Trash', danger: true }))) return;
    try {
        const res = await apiFetch('/api/trash', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ emptyAll: true })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to empty trash');
        showToast('Trash emptied successfully');
        loadTrashTable();
    } catch (err) {
        showToast(err.message);
    }
}

// Toast
let toastTimer = null;
function showToast(message) {
    const toast = document.getElementById('toast');
    document.getElementById('toast-message').innerText = message;
    toast.classList.remove('translate-y-20', 'opacity-0');
    toast.classList.add('translate-y-0', 'opacity-100');

    // A previous toast's timer used to hide the new message after a moment.
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.remove('translate-y-0', 'opacity-100');
        toast.classList.add('translate-y-20', 'opacity-0');
    }, 2800);
}

// Mobile Sidebar Drawer Controls
function openMobileSidebar() {
    const sidebar = document.getElementById('main-sidebar');
    const overlay = document.getElementById('mobile-sidebar-overlay');
    if (sidebar) sidebar.classList.remove('-translate-x-full');
    if (overlay) overlay.classList.remove('hidden');
    document.body.classList.add('overflow-hidden');
}

function closeMobileSidebar() {
    const sidebar = document.getElementById('main-sidebar');
    const overlay = document.getElementById('mobile-sidebar-overlay');
    if (sidebar) sidebar.classList.add('-translate-x-full');
    if (overlay) overlay.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
}

// Auto-close mobile drawer on larger screens
window.addEventListener('resize', () => {
    if (window.innerWidth >= 768) {
        closeMobileSidebar();
    }
});

// Close all open modals / dropdowns on Escape key
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeMobileSidebar();
        closeUploadModal();
        closeShareModal();
        closeNewFolderModal();
        closeRenameModal();
        closePreviewModal();
        closeChangePassModal();
        closeCreateUserModal();
        closeStorageAnalyticsModal();
        closeAnyDropdown();
    }
});

// ==========================================
// 1. DRAG AND DROP MOVE INTO FOLDERS
// ==========================================
let draggedItem = null;

function handleItemDragStart(e, name, isFolder) {
    draggedItem = { name, isFolder };
    e.dataTransfer.setData('text/plain', name);
    e.dataTransfer.effectAllowed = 'move';
    if (e.currentTarget) {
        e.currentTarget.classList.add('opacity-50', 'scale-[0.98]');
    }
}

function handleItemDragEnd(e) {
    if (e.currentTarget) {
        e.currentTarget.classList.remove('opacity-50', 'scale-[0.98]');
    }
    draggedItem = null;
    document.querySelectorAll('.folder-dropzone').forEach(el => {
        el.classList.remove('ring-4', 'ring-blue-500/40', 'bg-blue-50/70', 'border-blue-400', 'scale-[1.02]');
    });
}

function handleFolderDragOver(e, folderName, el) {
    if (!draggedItem || draggedItem.name === folderName) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    el.classList.add('ring-4', 'ring-blue-500/40', 'bg-blue-50/70', 'border-blue-400', 'scale-[1.02]');
}

function handleFolderDragLeave(e, el) {
    el.classList.remove('ring-4', 'ring-blue-500/40', 'bg-blue-50/70', 'border-blue-400', 'scale-[1.02]');
}

async function handleFolderDrop(e, targetFolder, el) {
    e.preventDefault();
    el.classList.remove('ring-4', 'ring-blue-500/40', 'bg-blue-50/70', 'border-blue-400', 'scale-[1.02]');
    if (!draggedItem || draggedItem.name === targetFolder) return;

    let itemsToMove = [draggedItem.name];
    if (selectedFiles.has(draggedItem.name) && selectedFiles.size > 1) {
        itemsToMove = Array.from(selectedFiles);
    }

    showToast(`Moving ${itemsToMove.length} item(s) into "${targetFolder}"...`);

    try {
        const res = await apiFetch('/api/files/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                currentPath,
                items: itemsToMove,
                targetFolder
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to move items');
        showToast(`Moved ${data.count || itemsToMove.length} item(s) to "${targetFolder}"`);
        selectedFiles.clear();
        updateBulkActionBar();
        loadDirectory(currentPath);
    } catch (err) {
        showToast('Move error: ' + err.message);
    }
}

// ==========================================
// 2. FLOATING AUDIO / VIDEO MINI-PLAYER (PiP)
// ==========================================
let currentMediaName = null;
let currentMediaIsVideo = false;
let isMediaExpanded = false;

function formatMediaTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function openFloatingMediaPlayer(fileName, isVideo = false, startTime = 0) {
    currentMediaName = fileName;
    currentMediaIsVideo = isVideo;

    const player = document.getElementById('floatingMediaPlayer');
    const titleEl = document.getElementById('miniPlayerTitle');
    const typeEl = document.getElementById('miniPlayerType');
    const iconEl = document.getElementById('miniPlayerIcon');
    const videoContainer = document.getElementById('miniVideoContainer');
    const videoEl = document.getElementById('miniVideoElement');
    const audioEl = document.getElementById('miniAudioElement');
    const seek = document.getElementById('miniPlayerSeek');
    const curTimeEl = document.getElementById('miniPlayerCurrentTime');
    const durTimeEl = document.getElementById('miniPlayerDuration');
    const playIcon = document.getElementById('miniPlayIcon');

    const fullPath = currentPath === '/' ? '/' + fileName : currentPath + '/' + fileName;
    const streamUrl = `/api/files/download?path=${encodeURIComponent(fullPath)}&preview=true&token=${authToken}`;

    titleEl.innerText = fileName;
    typeEl.innerText = isVideo ? 'Video (Floating Player)' : 'Audio Player';
    iconEl.innerHTML = `<i data-lucide="${isVideo ? 'film' : 'music'}" class="w-4 h-4"></i>`;

    if (isVideo) {
        audioEl.pause();
        audioEl.src = '';
        videoContainer.classList.remove('hidden');
        videoContainer.classList.add('flex');
        videoEl.src = streamUrl;
        if (startTime > 0) videoEl.currentTime = startTime;
        videoEl.play().catch(() => {});
    } else {
        videoEl.pause();
        videoEl.src = '';
        videoContainer.classList.add('hidden');
        videoContainer.classList.remove('flex');
        audioEl.src = streamUrl;
        if (startTime > 0) audioEl.currentTime = startTime;
        audioEl.play().catch(() => {});
    }

    const activeEl = isVideo ? videoEl : audioEl;

    activeEl.onloadedmetadata = () => {
        durTimeEl.innerText = formatMediaTime(activeEl.duration);
        seek.max = activeEl.duration || 100;
    };

    activeEl.ontimeupdate = () => {
        curTimeEl.innerText = formatMediaTime(activeEl.currentTime);
        seek.value = activeEl.currentTime;
    };

    activeEl.onplay = () => {
        playIcon.setAttribute('data-lucide', 'pause');
        if (window.lucide) lucide.createIcons();
    };

    activeEl.onpause = () => {
        playIcon.setAttribute('data-lucide', 'play');
        if (window.lucide) lucide.createIcons();
    };

    activeEl.onended = () => {
        playIcon.setAttribute('data-lucide', 'play');
        if (window.lucide) lucide.createIcons();
    };

    seek.oninput = () => {
        activeEl.currentTime = seek.value;
    };

    const volSlider = document.getElementById('miniPlayerVolume');
    volSlider.oninput = () => {
        activeEl.volume = volSlider.value;
        activeEl.muted = volSlider.value == 0;
        updateVolumeIcon(activeEl.muted, volSlider.value);
    };

    player.classList.remove('hidden');
    player.classList.add('flex');
    if (window.lucide) lucide.createIcons();
}

function updateVolumeIcon(muted, vol) {
    const icon = document.getElementById('miniVolumeIcon');
    if (!icon) return;
    if (muted || vol == 0) {
        icon.setAttribute('data-lucide', 'volume-x');
    } else if (vol < 0.5) {
        icon.setAttribute('data-lucide', 'volume-1');
    } else {
        icon.setAttribute('data-lucide', 'volume-2');
    }
    if (window.lucide) lucide.createIcons();
}

function toggleMediaPlayPause() {
    const videoEl = document.getElementById('miniVideoElement');
    const audioEl = document.getElementById('miniAudioElement');
    const activeEl = currentMediaIsVideo ? videoEl : audioEl;
    if (!activeEl) return;
    if (activeEl.paused) {
        activeEl.play().catch(() => {});
    } else {
        activeEl.pause();
    }
}

function skipMediaTime(sec) {
    const videoEl = document.getElementById('miniVideoElement');
    const audioEl = document.getElementById('miniAudioElement');
    const activeEl = currentMediaIsVideo ? videoEl : audioEl;
    if (!activeEl) return;
    activeEl.currentTime = Math.max(0, Math.min(activeEl.duration || 0, activeEl.currentTime + sec));
}

function toggleMediaMute() {
    const videoEl = document.getElementById('miniVideoElement');
    const audioEl = document.getElementById('miniAudioElement');
    const activeEl = currentMediaIsVideo ? videoEl : audioEl;
    if (!activeEl) return;
    activeEl.muted = !activeEl.muted;
    updateVolumeIcon(activeEl.muted, activeEl.volume);
}

function toggleMiniPlayerExpand() {
    const videoContainer = document.getElementById('miniVideoContainer');
    const player = document.getElementById('floatingMediaPlayer');
    if (!currentMediaIsVideo) return;
    isMediaExpanded = !isMediaExpanded;
    if (isMediaExpanded) {
        videoContainer.classList.remove('h-48');
        videoContainer.classList.add('h-64');
        player.classList.remove('w-80', 'sm:w-96');
        player.classList.add('w-96', 'sm:w-[440px]');
    } else {
        videoContainer.classList.remove('h-64');
        videoContainer.classList.add('h-48');
        player.classList.remove('w-96', 'sm:w-[440px]');
        player.classList.add('w-80', 'sm:w-96');
    }
}

function closeMiniPlayer() {
    const player = document.getElementById('floatingMediaPlayer');
    const videoEl = document.getElementById('miniVideoElement');
    const audioEl = document.getElementById('miniAudioElement');
    if (videoEl) {
        videoEl.pause();
        videoEl.src = '';
    }
    if (audioEl) {
        audioEl.pause();
        audioEl.src = '';
    }
    if (player) {
        player.classList.remove('flex');
        player.classList.add('hidden');
    }
    currentMediaName = null;
}

function popoutToMiniPlayer() {
    if (!currentPreviewFile) return;
    const ext = (currentPreviewFile.split('.').pop() || '').toLowerCase();
    const isVideo = ['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext);
    let currentTime = 0;
    const previewVideo = document.getElementById('previewVideoEl');
    if (previewVideo) {
        currentTime = previewVideo.currentTime;
    }
    closePreviewModal();
    openFloatingMediaPlayer(currentPreviewFile, isVideo, currentTime);
    showToast(`Playing in Floating Mini-Player`);
}

// ==========================================
// 3. STORAGE BREAKDOWN ANALYTICS MODAL
// ==========================================
async function openStorageAnalyticsModal() {
    const modal = document.getElementById('storageAnalyticsModal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    const totalUsedEl = document.getElementById('storage-modal-total-used');
    const quotaTextEl = document.getElementById('storage-modal-quota-text');
    const totalFilesEl = document.getElementById('storage-modal-total-files');
    const totalFoldersEl = document.getElementById('storage-modal-total-folders');
    const barEl = document.getElementById('storage-segmented-bar');
    const legendEl = document.getElementById('storage-legend');
    const gridEl = document.getElementById('storage-categories-grid');

    totalUsedEl.innerText = 'Analyzing...';
    barEl.innerHTML = '<div class="w-full bg-blue-200 animate-pulse h-full"></div>';
    gridEl.innerHTML = '<div class="col-span-full py-8 text-center text-xs text-gray-400">Scanning directory storage...</div>';

    try {
        const res = await apiFetch('/api/storage/breakdown');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to calculate storage');

        totalUsedEl.innerText = formatBytes(data.totalUsed);
        if (data.quotaMB > 0) {
            quotaTextEl.innerText = `of ${data.quotaMB} MB Limit`;
        } else {
            quotaTextEl.innerText = 'of Unlimited Quota';
        }
        totalFilesEl.innerText = data.totalFiles.toLocaleString();
        totalFoldersEl.innerText = data.totalFolders.toLocaleString();

        barEl.innerHTML = '';
        legendEl.innerHTML = '';
        gridEl.innerHTML = '';

        const catKeys = ['docs', 'images', 'videos', 'audio', 'archives', 'others'];
        const iconMap = {
            docs: 'file-text',
            images: 'image',
            videos: 'film',
            audio: 'music',
            archives: 'archive',
            others: 'file'
        };

        const total = data.totalUsed || 1;

        catKeys.forEach(key => {
            const item = data.breakdown[key];
            if (!item) return;
            const pct = data.totalUsed > 0 ? (item.size / total) * 100 : 0;
            const pctRounded = pct.toFixed(1);

            if (item.size > 0) {
                const seg = document.createElement('div');
                seg.style.width = `${Math.max(1, pct)}%`;
                seg.style.backgroundColor = item.color;
                seg.className = "h-full transition-all duration-500 relative cursor-pointer hover:opacity-90";
                seg.title = `${item.label}: ${formatBytes(item.size)} (${pctRounded}%)`;
                barEl.appendChild(seg);
            }

            const leg = document.createElement('div');
            leg.className = "flex items-center gap-1.5";
            leg.innerHTML = `
                <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color: ${item.color}"></span>
                <span>${item.label} (${pctRounded}%)</span>
            `;
            legendEl.appendChild(leg);

            const card = document.createElement('div');
            card.className = "p-3.5 bg-gray-50/70 border border-gray-200/80 rounded-2xl flex items-center justify-between shadow-2xs hover:shadow-xs transition-shadow";
            card.innerHTML = `
                <div class="flex items-center gap-3">
                    <div class="p-2 rounded-xl text-white shadow-xs shrink-0" style="background-color: ${item.color}">
                        <i data-lucide="${iconMap[key]}" class="w-4 h-4"></i>
                    </div>
                    <div>
                        <div class="font-bold text-xs text-gray-800">${item.label}</div>
                        <div class="text-[11px] text-gray-400">${item.count} file${item.count !== 1 ? 's' : ''}</div>
                    </div>
                </div>
                <div class="text-right">
                    <div class="font-bold text-xs text-gray-900">${formatBytes(item.size)}</div>
                    <div class="text-[10px] font-semibold text-blue-600">${pctRounded}%</div>
                </div>
            `;
            gridEl.appendChild(card);
        });

        if (window.lucide) lucide.createIcons();
    } catch (err) {
        showToast(err.message);
        gridEl.innerHTML = `<div class="col-span-full py-6 text-center text-xs text-red-500">${err.message}</div>`;
    }
}

function closeStorageAnalyticsModal() {
    const modal = document.getElementById('storageAnalyticsModal');
    if (modal) {
        modal.classList.remove('flex');
        modal.classList.add('hidden');
    }
}
