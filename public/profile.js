// =====================================================================
// Rx Cloude - My Profile: profile picture (upload / remove) + avatar UI.
// Loaded after app.js.
// =====================================================================

const AVATAR_SIZE = 256; // pixels; pictures are cropped to a square this size

function avatarUrl(user) {
    if (!user || !user.avatarVersion || !authToken) return null;
    return `/api/avatar/${encodeURIComponent(user.id)}?v=${user.avatarVersion}&token=${encodeURIComponent(authToken)}`;
}

// Fill a circle element with the user's picture, or their initial.
function renderAvatarInto(el, user) {
    if (!el || !user) return;
    const url = avatarUrl(user);
    const initial = escHtml((user.username || '?').charAt(0).toUpperCase());
    if (url) {
        el.innerHTML = `<img src="${url}" alt="" class="w-full h-full object-cover" onerror="this.parentElement.textContent='${initial}'">`;
    } else {
        el.textContent = (user.username || '?').charAt(0).toUpperCase();
    }
}

// HTML for list rows (users table).
function avatarHtml(user, sizeClasses) {
    const cls = sizeClasses || 'w-8 h-8 text-xs';
    const url = avatarUrl(user);
    const initial = escHtml((user.username || '?').charAt(0).toUpperCase());
    if (url) {
        return `<div class="${cls} rounded-full overflow-hidden shrink-0 bg-blue-100"><img src="${url}" alt="" loading="lazy" class="w-full h-full object-cover"></div>`;
    }
    return `<div class="${cls} rounded-full bg-blue-100 text-blue-700 font-bold flex items-center justify-center shrink-0">${initial}</div>`;
}

function applyProfileUi() {
    renderAvatarInto(document.getElementById('profile-avatar'), currentUser);
    if (!currentUser) return;
    renderAvatarInto(document.getElementById('profileModalAvatar'), currentUser);
    const name = document.getElementById('profileModalName');
    const role = document.getElementById('profileModalRole');
    if (name) name.textContent = currentUser.username;
    if (role) role.textContent = currentUser.role === 'admin' ? 'Super Admin' : 'Standard User';
    const remove = document.getElementById('btnRemoveAvatar');
    if (remove) remove.disabled = !currentUser.avatarVersion;
    if (remove) remove.classList.toggle('opacity-50', !currentUser.avatarVersion);
}

function storeCurrentUser(user) {
    if (!user) return;
    currentUser = { ...currentUser, ...user };
    try { localStorage.setItem('drive_user', JSON.stringify(currentUser)); } catch (e) {}
    applyProfileUi();
}

function openProfileModal() {
    if (!currentUser) return;
    applyProfileUi();
    const m = document.getElementById('profileModal');
    m.classList.remove('hidden');
    m.classList.add('flex');
    if (window.lucide) lucide.createIcons();
}

function closeProfileModal() {
    const m = document.getElementById('profileModal');
    m.classList.add('hidden');
    m.classList.remove('flex');
}

// Center-crop to a square and scale down in the browser, so a 10 MB phone
// photo becomes a ~30 KB upload.
function cropToSquareBlob(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            const side = Math.min(img.naturalWidth, img.naturalHeight);
            const sx = (img.naturalWidth - side) / 2;
            const sy = (img.naturalHeight - side) / 2;
            const out = Math.min(AVATAR_SIZE, side);
            const canvas = document.createElement('canvas');
            canvas.width = out;
            canvas.height = out;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, sx, sy, side, side, 0, 0, out, out);
            URL.revokeObjectURL(url);
            canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not process the picture')), 'image/jpeg', 0.88);
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This file is not a picture the browser can read')); };
        img.src = url;
    });
}

async function handleAvatarSelected(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) {
        rxAlert({ title: 'Not a picture', text: 'Please choose a JPG, PNG, WebP or GIF image.', icon: 'error' });
        return;
    }
    const status = document.getElementById('avatarUploadStatus');
    status.textContent = 'Uploading...';
    status.classList.remove('hidden');
    try {
        const blob = await cropToSquareBlob(file);
        const form = new FormData();
        form.append('avatar', blob, 'avatar.jpg');
        const res = await apiFetch('/api/auth/avatar', { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        storeCurrentUser(data.user);
        showToast('Profile picture updated');
    } catch (err) {
        rxAlert({ title: 'Could not change picture', text: err.message, icon: 'error' });
    } finally {
        status.classList.add('hidden');
    }
}

async function removeAvatar() {
    if (!currentUser || !currentUser.avatarVersion) return;
    if (!(await rxConfirm({ title: 'Remove profile picture?', text: 'Your initial will be shown instead.', confirmText: 'Remove', danger: true }))) return;
    try {
        const res = await apiFetch('/api/auth/avatar', { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed');
        storeCurrentUser(data.user);
        showToast('Profile picture removed');
    } catch (err) {
        showToast(err.message);
    }
}

// Show the picture as soon as the drive opens, and refresh the cached user
// record (another device may have changed the picture).
const _profileShowDrive = showDrive;
showDrive = function () {
    _profileShowDrive();
    applyProfileUi();
    if (authToken && currentUser && !currentUser.mustChangePassword) {
        apiFetch('/api/auth/me').then(r => r.ok ? r.json() : null).then(d => { if (d && d.user) storeCurrentUser(d.user); }).catch(() => {});
    }
};

window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeProfileModal(); });
