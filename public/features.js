// =====================================================================
// Rx Cloude - Extended Features
// ZIP Manager • Secure Vault • Starred & Color Tags • Smart Cleaner • PWA
// Loaded after app.js; overrides a few app.js globals where needed.
// =====================================================================

const TAG_COLORS = {
    red: 'bg-rose-500', blue: 'bg-blue-500', emerald: 'bg-emerald-500',
    amber: 'bg-amber-500', purple: 'bg-purple-500'
};
let selectedColorFilter = null;

function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
}
function relPathOf(name) {
    const full = currentPath === '/' ? '/' + name : currentPath + '/' + name;
    return full.replace(/^\/+/, '');
}
function findItem(name) {
    return filesList.find(f => f.name === name);
}

// ---------------------------------------------------------------------
// 1. STARRED & COLOR TAGS (server-synced, per user, works on all devices)
// ---------------------------------------------------------------------
isItemStarred = function (name) {
    const item = findItem(name);
    return !!(item && item.starred);
};

toggleStarItem = async function (name, event) {
    if (event) event.stopPropagation();
    closeAnyDropdown();
    const item = findItem(name);
    const newVal = !(item && item.starred);
    try {
        const res = await apiFetch('/api/metadata', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: relPathOf(name), starred: newVal })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed');
        if (item) item.starred = newVal;
        showToast(newVal ? `⭐ Added "${name}" to Starred` : `Removed "${name}" from Starred`);
        renderDashboard();
    } catch (err) { showToast(err.message); }
};

async function setItemColor(name, color, event) {
    if (event) event.stopPropagation();
    closeAnyDropdown();
    try {
        const res = await apiFetch('/api/metadata', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: relPathOf(name), color: color || null })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed');
        const item = findItem(name);
        if (item) item.color = color || null;
        showToast(color ? `Tagged "${name}" as ${color}` : `Removed tag from "${name}"`);
        renderDashboard();
    } catch (err) { showToast(err.message); }
}

function setFilterColor(color) {
    selectedColorFilter = selectedColorFilter === color ? null : color;
    document.querySelectorAll('.color-filter-pill').forEach(btn => {
        const active = btn.getAttribute('data-color') === selectedColorFilter;
        btn.classList.toggle('ring-2', active);
        btn.classList.toggle('ring-offset-2', active);
        btn.classList.toggle('ring-gray-800', active);
    });
    renderFiles();
}

// "starred" category is handled by our renderFiles wrapper
const _origMatchCategory = matchCategory;
matchCategory = function (fileName, category) {
    if (category === 'starred') return true;
    return _origMatchCategory(fileName, category);
};

// Wrap renderFiles: apply starred/color filters, then decorate DOM
const _origRenderFiles = renderFiles;
renderFiles = function () {
    const saved = filesList;
    if (selectedCategory === 'starred' || selectedColorFilter) {
        filesList = saved.filter(f => f.isDirectory ||
            ((selectedCategory !== 'starred' || f.starred) &&
             (!selectedColorFilter || f.color === selectedColorFilter)));
    }
    try { _origRenderFiles(); } finally { filesList = saved; }
    decorateFileItems();
};

const _origRenderFolders = renderFolders;
renderFolders = function () {
    _origRenderFolders();
    document.querySelectorAll('#folders-grid [data-foldername]').forEach(el => {
        const name = el.getAttribute('data-foldername');
        const item = findItem(name);
        const menu = el.querySelector('.action-dropdown-menu');
        if (item && item.color) addColorDot(el.querySelector('h3'), item.color);
        if (menu) injectMenuItems(menu, name, true);
    });
    if (window.lucide) lucide.createIcons();
};

function addColorDot(target, color) {
    if (!target || !TAG_COLORS[color]) return;
    const dot = document.createElement('span');
    dot.className = `inline-block w-2.5 h-2.5 rounded-full ${TAG_COLORS[color]} ml-1.5 align-middle`;
    dot.title = `${color} tag`;
    target.appendChild(dot);
}

function injectMenuItems(menu, name, isDir) {
    const divider = menu.querySelector('.border-t');
    const wrap = document.createElement('div');
    const isZip = !isDir && /\.zip$/i.test(name);
    const n = escAttr(JSON.stringify(name));
    wrap.innerHTML = `
        ${isZip ? `
        <button onclick='extractZip(${n}, true)' class="w-full px-3.5 py-2 text-left hover:bg-gray-50 flex items-center gap-2.5 cursor-pointer">
            <i data-lucide="folder-open" class="w-4 h-4 text-indigo-500"></i> Extract to Folder
        </button>
        <button onclick='extractZip(${n}, false)' class="w-full px-3.5 py-2 text-left hover:bg-gray-50 flex items-center gap-2.5 cursor-pointer">
            <i data-lucide="package-open" class="w-4 h-4 text-indigo-500"></i> Extract Here
        </button>` : ''}
        <button onclick='compressSingle(${n})' class="w-full px-3.5 py-2 text-left hover:bg-gray-50 flex items-center gap-2.5 cursor-pointer">
            <i data-lucide="file-archive" class="w-4 h-4 text-gray-500"></i> Compress to ZIP
        </button>
        ${!isDir ? `
        <button onclick='moveItemsToVault([${n}])' class="w-full px-3.5 py-2 text-left hover:bg-purple-50 flex items-center gap-2.5 cursor-pointer text-purple-700">
            <i data-lucide="shield-alert" class="w-4 h-4"></i> Lock into Vault
        </button>` : ''}
        <div class="px-3.5 py-2 flex items-center gap-2">
            <span class="text-gray-400 text-[11px] mr-1">Tag:</span>
            ${Object.entries(TAG_COLORS).map(([c, cls]) =>
                `<button onclick='setItemColor(${n}, "${c}", event)' class="w-4 h-4 rounded-full ${cls} hover:scale-125 transition-transform cursor-pointer" title="${c}"></button>`).join('')}
            <button onclick='setItemColor(${n}, null, event)' class="w-4 h-4 rounded-full border border-gray-300 text-gray-400 flex items-center justify-center text-[9px] cursor-pointer" title="Clear">✕</button>
        </div>`;
    if (divider) menu.insertBefore(wrap, divider); else menu.appendChild(wrap);
}

function decorateFileItems() {
    document.querySelectorAll('#files-grid-view .file-card-wrapper').forEach(card => {
        const name = card.getAttribute('data-filename');
        const item = findItem(name);
        if (item && item.color) addColorDot(card.querySelector('h4'), item.color);
        if (item && item.starred) {
            const h4 = card.querySelector('h4');
            if (h4) h4.insertAdjacentHTML('afterbegin', '<i data-lucide="star" class="w-3.5 h-3.5 text-amber-400 fill-amber-400 inline mr-1 -mt-0.5"></i>');
        }
        const menu = card.querySelector('.action-dropdown-menu');
        if (menu) injectMenuItems(menu, name, false);
    });
    document.querySelectorAll('#files-table-body tr').forEach(tr => {
        const cb = tr.querySelector('[data-filename]');
        if (!cb) return;
        const item = findItem(cb.getAttribute('data-filename'));
        if (item && item.color) addColorDot(tr.querySelector('td:nth-child(2) span'), item.color);
    });
    if (window.lucide) lucide.createIcons();
}

async function loadStarredView() {
    const list = document.getElementById('starred-list');
    list.innerHTML = `<div class="col-span-full py-10 text-center text-xs text-gray-400">Loading...</div>`;
    try {
        const res = await apiFetch('/api/metadata');
        const data = await res.json();
        const entries = Object.entries(data.metadata || {});
        if (!entries.length) {
            list.innerHTML = `<div class="col-span-full py-14 text-center text-sm text-gray-400">
                <i data-lucide="star" class="w-10 h-10 mx-auto mb-3 text-gray-300"></i>
                No starred or tagged items yet.<br><span class="text-xs">Use the ⭐ or the color tag in any file menu.</span></div>`;
        } else {
            list.innerHTML = '';
            entries.forEach(([p, meta]) => {
                const name = p.split('/').pop();
                const parent = '/' + p.split('/').slice(0, -1).join('/');
                const fm = getFileMeta(name);
                const el = document.createElement('div');
                el.className = 'bg-white p-4 rounded-2xl border border-gray-200/80 hover:border-blue-400 hover:shadow-md transition-all flex items-center gap-3 cursor-pointer';
                el.innerHTML = `
                    <div class="p-2.5 ${fm.color} rounded-xl shrink-0"><i data-lucide="${fm.icon}" class="w-5 h-5"></i></div>
                    <div class="min-w-0 flex-1">
                        <div class="font-semibold text-sm text-gray-900 truncate">${escAttr(name)}</div>
                        <div class="text-[11px] text-gray-400 truncate">${escAttr(parent)}</div>
                    </div>
                    ${meta.color && TAG_COLORS[meta.color] ? `<span class="w-3 h-3 rounded-full ${TAG_COLORS[meta.color]} shrink-0"></span>` : ''}
                    ${meta.starred ? '<i data-lucide="star" class="w-4 h-4 text-amber-400 fill-amber-400 shrink-0"></i>' : ''}`;
                el.onclick = () => { switchTab('drive'); loadDirectory(parent); };
                list.appendChild(el);
            });
        }
    } catch (err) { showToast(err.message); }
    if (window.lucide) lucide.createIcons();
}

// ---------------------------------------------------------------------
// 2. TAB SWITCHING (adds Starred & Vault views)
// ---------------------------------------------------------------------
const _origSwitchTab = switchTab;
switchTab = function (tab) {
    const vs = document.getElementById('view-starred');
    const vv = document.getElementById('view-vault');
    vs.classList.add('hidden');
    vv.classList.add('hidden');
    if (tab !== 'vault' && vaultToken) {
        vaultToken = null; // auto-lock when leaving the vault
    }
    if (tab !== 'vault') pendingVaultItems = null;
    if (tab === 'starred' || tab === 'vault') {
        _origSwitchTab('__none__');
        currentTab = tab;
        document.querySelectorAll('.nav-btn').forEach(btn => {
            const active = btn.getAttribute('data-tab') === tab;
            btn.className = active
                ? "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-blue-50 text-blue-700 font-medium text-sm transition-colors cursor-pointer nav-btn"
                : "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-gray-600 hover:bg-gray-100 font-medium text-sm transition-colors cursor-pointer nav-btn";
        });
        if (tab === 'starred') { vs.classList.remove('hidden'); loadStarredView(); }
        else { vv.classList.remove('hidden'); initVaultView(); }
        return;
    }
    _origSwitchTab(tab);
};

// ---------------------------------------------------------------------
// 3. ZIP ARCHIVE MANAGER
// ---------------------------------------------------------------------
let compressItems = [];

function openCompressModal(items) {
    compressItems = items || Array.from(selectedFiles);
    if (!compressItems.length) return showToast('Select files first');
    document.getElementById('compressCountText').innerText = `${compressItems.length} item(s) selected`;
    const base = compressItems.length === 1 ? compressItems[0].replace(/\.[^.]+$/, '') : `Archive_${new Date().toISOString().slice(0, 10)}`;
    document.getElementById('compressNameInput').value = base + '.zip';
    const m = document.getElementById('compressModal');
    m.classList.remove('hidden'); m.classList.add('flex');
    if (window.lucide) lucide.createIcons();
}
function compressSingle(name) { closeAnyDropdown(); openCompressModal([name]); }
function closeCompressModal() {
    const m = document.getElementById('compressModal');
    m.classList.add('hidden'); m.classList.remove('flex');
}
async function submitCompress() {
    const btn = document.getElementById('compressSubmitBtn');
    btn.disabled = true; btn.innerText = 'Compressing...';
    try {
        const res = await apiFetch('/api/files/compress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: compressItems,
                currentPath,
                archiveName: document.getElementById('compressNameInput').value
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showToast(`📦 Created ${data.archiveName}`);
        closeCompressModal();
        clearSelection();
        loadDirectory(currentPath);
    } catch (err) { showToast(err.message); }
    btn.disabled = false; btn.innerText = 'Create ZIP';
}
async function extractZip(name, subfolder) {
    closeAnyDropdown();
    showToast(`Extracting ${name}...`);
    try {
        const res = await apiFetch('/api/files/extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: relPathOf(name), currentPath, createSubfolder: subfolder })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showToast(`✅ Extracted "${name}"`);
        loadDirectory(currentPath);
    } catch (err) { showToast(err.message); }
}

// ---------------------------------------------------------------------
// 4. SECURE VAULT WITH PIN
// ---------------------------------------------------------------------
// let vaultToken = sessionStorage.getItem('rx_vault_token') || null;
// The vault must ask for the PIN every time it is opened. The unlock token is
// kept in memory only and dropped as soon as the user leaves the Vault tab.
let vaultToken = null;
try { sessionStorage.removeItem('rx_vault_token'); } catch (e) {}
let pendingVaultItems = null; // files waiting to be locked in after the PIN is entered
let vaultMode = 'unlock'; // 'unlock' | 'setup' | 'change'

function vaultFetch(url, opts = {}) {
    opts.headers = opts.headers || {};
    opts.headers['x-vault-token'] = vaultToken || '';
    return apiFetch(url, opts);
}

async function initVaultView() {
    vaultToken = null; // always ask for the PIN when the vault is opened
    if (vaultToken) {
        const ok = await loadVaultFiles();
        if (ok) return;
    }
    const res = await apiFetch('/api/vault/status');
    const data = await res.json();
    showVaultLocked(data.hasPin ? 'unlock' : 'setup');
}

function showVaultLocked(mode) {
    vaultMode = mode;
    document.getElementById('vault-unlocked').classList.add('hidden');
    document.getElementById('vault-locked').classList.remove('hidden');
    const title = document.getElementById('vault-lock-title');
    const desc = document.getElementById('vault-lock-desc');
    const confirm = document.getElementById('vaultPinConfirm');
    const btn = document.getElementById('vaultSubmitBtn');
    const pin = document.getElementById('vaultPinInput');
    document.getElementById('vaultError').classList.add('hidden');
    pin.value = ''; confirm.value = '';
    if (mode === 'setup') {
        title.innerText = 'Create Vault PIN';
        desc.innerText = 'Set a 4–8 digit PIN to protect your private files.';
        confirm.classList.remove('hidden'); confirm.placeholder = 'Confirm PIN';
        btn.innerText = 'Create & Unlock';
    } else if (mode === 'change') {
        title.innerText = 'Change Vault PIN';
        desc.innerText = 'Enter your current PIN, then the new PIN.';
        pin.placeholder = 'Current';
        confirm.classList.remove('hidden'); confirm.placeholder = 'New PIN';
        btn.innerText = 'Update PIN';
    } else {
        title.innerText = 'Secure Vault';
        desc.innerText = 'Enter your PIN to unlock private files.';
        pin.placeholder = '••••';
        confirm.classList.add('hidden');
        btn.innerText = 'Unlock Vault';
    }
    setTimeout(() => pin.focus(), 50);
    if (window.lucide) lucide.createIcons();
}

function vaultError(msg) {
    const el = document.getElementById('vaultError');
    el.innerText = msg; el.classList.remove('hidden');
}

async function submitVaultPin() {
    const pin = document.getElementById('vaultPinInput').value.trim();
    const second = document.getElementById('vaultPinConfirm').value.trim();
    try {
        if (vaultMode === 'setup') {
            if (pin.length < 4) return vaultError('PIN must be at least 4 characters');
            if (pin !== second) return vaultError('PINs do not match');
            const r = await apiFetch('/api/vault/pin', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pin })
            });
            if (!r.ok) return vaultError((await r.json()).error);
        } else if (vaultMode === 'change') {
            if (second.length < 4) return vaultError('New PIN must be at least 4 characters');
            const r = await apiFetch('/api/vault/pin', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pin: second, currentPin: pin })
            });
            if (!r.ok) return vaultError((await r.json()).error);
            showToast('🔐 Vault PIN updated. Enter the new PIN to open the vault.');
            // The server re-keys the files and ends old sessions.
            vaultToken = null;
            return showVaultLocked('unlock');
        }
        const finalPin = pin;
        const res = await apiFetch('/api/vault/unlock', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pin: finalPin })
        });
        const data = await res.json();
        if (!res.ok) return vaultError(data.error);
        vaultToken = data.vaultToken;
        // sessionStorage.setItem('rx_vault_token', vaultToken);
        if (pendingVaultItems && pendingVaultItems.length) {
            const items = pendingVaultItems;
            pendingVaultItems = null;
            await lockItemsIntoVault(items);
        } else {
            showToast('🔓 Vault unlocked');
        }
        loadVaultFiles();
    } catch (err) { vaultError(err.message); }
}

document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.target.id === 'vaultPinInput' || e.target.id === 'vaultPinConfirm')) submitVaultPin();
});

function openChangeVaultPin() { showVaultLocked('change'); }

function lockVault() {
    vaultToken = null;
    // sessionStorage.removeItem('rx_vault_token');
    showToast('🔒 Vault locked');
    showVaultLocked('unlock');
}

async function loadVaultFiles() {
    const res = await vaultFetch('/api/vault/files');
    if (!res.ok) {
        vaultToken = null; // sessionStorage.removeItem('rx_vault_token');
        return false;
    }
    const data = await res.json();
    document.getElementById('vault-locked').classList.add('hidden');
    document.getElementById('vault-unlocked').classList.remove('hidden');
    const box = document.getElementById('vault-files');
    box.innerHTML = '';
    if (!data.files.length) {
        box.innerHTML = `<div class="col-span-full py-14 text-center text-sm text-gray-400">
            <i data-lucide="shield" class="w-10 h-10 mx-auto mb-3 text-gray-300"></i>
            Vault is empty.<br><span class="text-xs">Select files in My Drive and click "Lock into Vault".</span></div>`;
    }
    data.files.forEach(f => {
        const fm = getFileMeta(f.name);
        const n = escAttr(JSON.stringify(f.name));
        const el = document.createElement('div');
        el.className = 'bg-white p-4 rounded-2xl border border-purple-100 hover:border-purple-400 hover:shadow-md transition-all';
        el.innerHTML = `
            <div class="flex items-center gap-3 mb-3">
                <div class="p-2.5 ${fm.color} rounded-xl shrink-0"><i data-lucide="${fm.icon}" class="w-5 h-5"></i></div>
                <div class="min-w-0 flex-1">
                    <div class="font-semibold text-sm text-gray-900 truncate" title="${escAttr(f.name)}">${escAttr(f.name)}</div>
                    <div class="text-[11px] text-gray-400">${formatBytes(f.size || 0)} • ${new Date(f.updatedAt).toLocaleDateString()}</div>
                </div>
            </div>
            <div class="flex items-center gap-1 border-t border-gray-100 pt-2">
                <button onclick='vaultOpen(${n}, true)' class="p-1.5 text-gray-400 hover:text-blue-600 rounded-lg hover:bg-gray-50 cursor-pointer" title="Preview"><i data-lucide="eye" class="w-4 h-4"></i></button>
                <button onclick='vaultOpen(${n}, false)' class="p-1.5 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-50 cursor-pointer" title="Download"><i data-lucide="download" class="w-4 h-4"></i></button>
                <button onclick='vaultMoveOut(${n})' class="ml-auto px-2.5 py-1 text-[11px] font-semibold text-purple-700 bg-purple-50 hover:bg-purple-100 rounded-lg cursor-pointer flex items-center gap-1" title="Restore to current drive folder"><i data-lucide="unlock" class="w-3.5 h-3.5"></i> Unlock to Drive</button>
                <button onclick='vaultDelete(${n})' class="p-1.5 text-gray-400 hover:text-red-600 rounded-lg hover:bg-red-50 cursor-pointer" title="Delete forever"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
            </div>`;
        box.appendChild(el);
    });
    if (window.lucide) lucide.createIcons();
    return true;
}

function vaultOpen(name, preview) {
    const url = `/api/vault/download/${encodeURIComponent(name)}?token=${authToken}&vaultToken=${vaultToken}${preview ? '&preview=true' : ''}`;
    window.open(url, '_blank');
}

async function vaultMoveOut(name) {
    const res = await vaultFetch('/api/vault/move-out', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: name, targetFolder: currentPath })
    });
    const data = await res.json();
    if (!res.ok) return showToast(data.error);
    showToast(`Moved "${name}" back to ${currentPath}`);
    loadVaultFiles();
}

async function vaultDelete(name) {
    // if (!confirm(`Permanently delete "${name}" from the vault? This cannot be undone.`)) return;  (native popup, replaced by SweetAlert2)
    if (!(await rxConfirm({ title: 'Delete from Vault?', text: `"${name}" will be permanently deleted. This cannot be undone.`, confirmText: 'Delete forever', danger: true }))) return;
    const res = await vaultFetch('/api/vault/file', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: name })
    });
    if (!res.ok) return showToast((await res.json()).error);
    showToast('Deleted from vault');
    loadVaultFiles();
}

async function moveItemsToVault(names) {
    closeAnyDropdown();
    names = names.filter(n => { const it = findItem(n); return it && !it.isDirectory; });
    if (!names.length) return showToast('Only files can be locked into the vault');
    // if (!vaultToken) {
    //     showToast('🔐 Unlock your vault first');
    //     return switchTab('vault');
    // }
    // Ask for the PIN, then lock the chosen files in right after unlocking.
    const folderAtRequest = currentPath;
    switchTab('vault');
    pendingVaultItems = names.map(n => ({ name: n, path: folderAtRequest }));
    showToast(`🔐 Enter your PIN to lock ${names.length} file(s) into the vault`);
}

async function lockItemsIntoVault(items) {
    let ok = 0;
    for (const it of items) {
        const rel = (it.path === '/' ? '/' + it.name : it.path + '/' + it.name).replace(/^\/+/, '');
        const res = await vaultFetch('/api/vault/move-in', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: rel })
        });
        if (res.ok) ok++;
    }
    showToast(`🛡️ ${ok} of ${items.length} file(s) locked into Vault`);
    clearSelection();
}

// Original flow kept for reference; it required an already-unlocked vault.
async function moveItemsToVaultLegacy(names) {
    let ok = 0;
    for (const n of names) {
        const res = await vaultFetch('/api/vault/move-in', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath: relPathOf(n) })
        });
        if (res.status === 401 || res.status === 403) {
            vaultToken = null; sessionStorage.removeItem('rx_vault_token');
            showToast('Vault session expired, please unlock again');
            return switchTab('vault');
        }
        if (res.ok) ok++;
    }
    showToast(`🛡️ ${ok} file(s) locked into Vault`);
    clearSelection();
    loadDirectory(currentPath);
}
function moveSelectedToVault() { moveItemsToVault(Array.from(selectedFiles)); }

// ---------------------------------------------------------------------
// 5. SMART STORAGE CLEANER
// ---------------------------------------------------------------------
let cleanerTab = 'dup';
let cleanerSelected = new Set();
let cleanerSizes = {};

function openStorageCleanerModal() {
    const m = document.getElementById('cleanerModal');
    m.classList.remove('hidden'); m.classList.add('flex');
    switchCleanerTab('dup');
}
function closeStorageCleanerModal() {
    const m = document.getElementById('cleanerModal');
    m.classList.add('hidden'); m.classList.remove('flex');
}

function switchCleanerTab(tab) {
    cleanerTab = tab;
    cleanerSelected.clear(); cleanerSizes = {};
    const on = 'px-4 py-1.5 rounded-lg bg-white shadow-xs text-emerald-700 cursor-pointer';
    const off = 'px-4 py-1.5 rounded-lg text-gray-500 cursor-pointer';
    document.getElementById('cleanerTabDup').className = tab === 'dup' ? on : off;
    document.getElementById('cleanerTabLarge').className = tab === 'large' ? on : off;
    tab === 'dup' ? loadDuplicates() : loadLargeFiles();
}

function updateCleanerSelected() {
    let total = 0;
    cleanerSelected.forEach(p => total += cleanerSizes[p] || 0);
    document.getElementById('cleanerSelectedText').innerText =
        `${cleanerSelected.size} file(s) selected • ${formatBytes(total)} will be freed`;
}

function cleanerRow(f, checked) {
    cleanerSizes[f.path] = f.size;
    if (checked) cleanerSelected.add(f.path);
    const fm = getFileMeta(f.name);
    return `
        <label class="flex items-center gap-3 p-2.5 rounded-xl hover:bg-gray-50 cursor-pointer">
            <input type="checkbox" ${checked ? 'checked' : ''} data-path="${escAttr(f.path)}" onchange="toggleCleanerFile(this)" class="w-4 h-4 text-red-600 rounded border-gray-300 cursor-pointer">
            <div class="p-2 ${fm.color} rounded-lg shrink-0"><i data-lucide="${fm.icon}" class="w-4 h-4"></i></div>
            <div class="min-w-0 flex-1">
                <div class="text-xs font-semibold text-gray-800 truncate">${escAttr(f.name)}</div>
                <div class="text-[10px] text-gray-400 truncate">/${escAttr(f.path)}</div>
            </div>
            <div class="text-xs font-bold text-gray-600 shrink-0">${formatBytes(f.size)}</div>
        </label>`;
}

function toggleCleanerFile(cb) {
    const p = cb.getAttribute('data-path');
    cb.checked ? cleanerSelected.add(p) : cleanerSelected.delete(p);
    updateCleanerSelected();
}

function cleanerLoading(text) {
    document.getElementById('cleanerBody').innerHTML =
        `<div class="py-14 text-center text-xs text-gray-400"><i data-lucide="loader-2" class="w-8 h-8 mx-auto mb-3 animate-spin text-emerald-500"></i>${text}</div>`;
    document.getElementById('cleanerSummary').innerText = '';
    updateCleanerSelected();
    if (window.lucide) lucide.createIcons();
}

async function loadDuplicates() {
    cleanerLoading('Scanning drive & comparing file fingerprints...');
    try {
        const res = await apiFetch('/api/storage/duplicates');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        const body = document.getElementById('cleanerBody');
        if (!data.duplicates.length) {
            body.innerHTML = `<div class="py-14 text-center text-sm text-gray-400"><i data-lucide="badge-check" class="w-10 h-10 mx-auto mb-3 text-emerald-400"></i>No duplicate files found. Your drive is clean! 🎉</div>`;
        } else {
            let wasted = 0;
            body.innerHTML = data.duplicates.sort((a, b) => b.size * b.files.length - a.size * a.files.length).map(g => {
                wasted += g.size * (g.files.length - 1);
                // keep the oldest copy, pre-select the rest
                const sorted = [...g.files].sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
                return `
                <div class="border border-gray-200 rounded-2xl p-2">
                    <div class="px-2.5 py-1.5 text-[11px] font-semibold text-gray-500 flex justify-between">
                        <span>${g.files.length} identical copies • ${formatBytes(g.size)} each</span>
                        <span class="text-emerald-600">Oldest copy kept</span>
                    </div>
                    ${sorted.map((f, i) => cleanerRow(f, i > 0)).join('')}
                </div>`;
            }).join('');
            document.getElementById('cleanerSummary').innerHTML =
                `Found <b>${data.duplicates.length}</b> duplicate groups • <b class="text-red-600">${formatBytes(wasted)}</b> wasted space`;
        }
    } catch (err) {
        document.getElementById('cleanerBody').innerHTML = `<div class="py-10 text-center text-xs text-red-500">${escAttr(err.message)}</div>`;
    }
    updateCleanerSelected();
    if (window.lucide) lucide.createIcons();
}

async function loadLargeFiles() {
    cleanerLoading('Finding the biggest files...');
    try {
        const res = await apiFetch('/api/storage/large-files');
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        const body = document.getElementById('cleanerBody');
        if (!data.files.length) {
            body.innerHTML = `<div class="py-14 text-center text-sm text-gray-400">No files found.</div>`;
        } else {
            const max = data.files[0].size || 1;
            body.innerHTML = data.files.map(f => `
                <div>
                    ${cleanerRow(f, false)}
                    <div class="mx-3 -mt-1 mb-1 h-1 bg-gray-100 rounded-full overflow-hidden">
                        <div class="h-1 bg-gradient-to-r from-amber-400 to-red-500" style="width:${Math.max(2, Math.round(f.size / max * 100))}%"></div>
                    </div>
                </div>`).join('');
            const total = data.files.reduce((s, f) => s + f.size, 0);
            document.getElementById('cleanerSummary').innerHTML = `Top <b>${data.files.length}</b> largest files • <b>${formatBytes(total)}</b> total`;
        }
    } catch (err) {
        document.getElementById('cleanerBody').innerHTML = `<div class="py-10 text-center text-xs text-red-500">${escAttr(err.message)}</div>`;
    }
    updateCleanerSelected();
    if (window.lucide) lucide.createIcons();
}

async function cleanSelectedFiles() {
    if (!cleanerSelected.size) return showToast('No files selected');
    // if (!confirm(`Permanently delete ${cleanerSelected.size} file(s)? This cannot be undone.`)) return;
    // The server moves cleaned files to Trash, so they can still be restored.
    // if (!confirm(`Move ${cleanerSelected.size} file(s) to Trash?`)) return;  (native popup, replaced by SweetAlert2)
    if (!(await rxConfirm({ title: 'Clean up files?', text: `${cleanerSelected.size} file(s) will be moved to Trash. Empty the Trash afterwards to free the space.`, confirmText: 'Move to Trash', danger: true }))) return;
    try {
        const res = await apiFetch('/api/storage/clean', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: Array.from(cleanerSelected) })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showToast(`🧹 Moved ${data.deletedCount} files to Trash • ${formatBytes(data.freedBytes)} (empty Trash to free the space)`);
        switchCleanerTab(cleanerTab);
        if (currentTab === 'drive') loadDirectory(currentPath);
    } catch (err) { showToast(err.message); }
}

// ---------------------------------------------------------------------
// 6. PWA - INSTALLABLE WEB APP
// ---------------------------------------------------------------------
let deferredPwaPrompt = null;

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => { /* needs HTTPS or localhost */ });
    });
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPwaPrompt = e;
    const btn = document.getElementById('pwaInstallBtn');
    if (btn) { btn.classList.remove('hidden'); btn.classList.add('flex'); }
});

window.addEventListener('appinstalled', () => {
    deferredPwaPrompt = null;
    const btn = document.getElementById('pwaInstallBtn');
    if (btn) { btn.classList.add('hidden'); btn.classList.remove('flex'); }
    showToast('📱 Rx Cloude installed as an app!');
});

async function installPwaApp() {
    if (!deferredPwaPrompt) {
        showToast('Use your browser menu → "Add to Home Screen" / "Install app"');
        return;
    }
    deferredPwaPrompt.prompt();
    await deferredPwaPrompt.userChoice;
    deferredPwaPrompt = null;
}
