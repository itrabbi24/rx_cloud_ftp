// =====================================================================
// Rx Cloude - branding (name, page title, logo chosen by the admin)
//
// Elements marked data-brand-name / data-brand-logo show the custom brand.
// The "Powered by Rx Cloude" credit is deliberately NOT marked, so the real
// product name stays visible whatever the branding is set to.
// =====================================================================

const DEFAULT_BRAND_NAME = 'Rx Cloude';
const DEFAULT_BRAND_TITLE = 'Rx Cloude - Modern Cloud Storage';
let currentBranding = { name: '', title: '', logoVersion: 0 };

function brandEsc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function brandLogoUrl(b) {
    return b.logoVersion ? `/api/branding/logo?v=${b.logoVersion}` : '';
}

function applyBranding(b) {
    currentBranding = { name: '', title: '', logoVersion: 0, ...(b || {}) };
    const name = currentBranding.name || DEFAULT_BRAND_NAME;
    const logo = brandLogoUrl(currentBranding);

    // Two-tone wordmark like the original: last word in blue.
    document.querySelectorAll('[data-brand-name]').forEach(el => {
        if (el.dataset.brandName === 'plain') { el.textContent = name; return; }
        const words = name.split(' ');
        const last = words.pop();
        el.innerHTML = (words.length ? brandEsc(words.join(' ')) + ' ' : '') + `<span class="text-blue-600">${brandEsc(last)}</span>`;
    });

    document.querySelectorAll('[data-brand-logo]').forEach(el => {
        if (el.dataset.origClass === undefined) {
            el.dataset.origClass = el.className;
            el.dataset.origHtml = el.innerHTML;
        }
        if (logo) {
            const size = el.dataset.brandLogo || 'w-10 h-10';
            el.className = `${size} shrink-0 rounded-xl overflow-hidden flex items-center justify-center`;
            el.innerHTML = `<img src="${logo}" alt="${brandEsc(name)}" class="w-full h-full object-contain">`;
        } else {
            el.className = el.dataset.origClass;
            el.innerHTML = el.dataset.origHtml;
        }
    });

    if (!document.body.dataset.keepTitle) {
        document.title = currentBranding.title || (currentBranding.name ? `${currentBranding.name} - Cloud Storage` : DEFAULT_BRAND_TITLE);
    }
    const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (appleTitle) appleTitle.setAttribute('content', name);
    document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]').forEach(link => {
        if (link.dataset.origHref === undefined) link.dataset.origHref = link.getAttribute('href');
        link.setAttribute('href', logo || link.dataset.origHref);
    });

    fillBrandingForm();
    if (window.lucide) lucide.createIcons();
}

async function loadBranding() {
    try {
        const res = await fetch('/api/branding');
        if (res.ok) applyBranding(await res.json());
    } catch (e) {}
}

// --- Admin settings card ---------------------------------------------------
function fillBrandingForm() {
    const nameInput = document.getElementById('brandNameInput');
    if (!nameInput) return;
    nameInput.value = currentBranding.name || '';
    document.getElementById('brandTitleInput').value = currentBranding.title || '';
    const preview = document.getElementById('brandLogoPreview');
    const logo = brandLogoUrl(currentBranding);
    preview.innerHTML = logo
        ? `<img src="${logo}" alt="" class="w-full h-full object-contain">`
        : '<i data-lucide="cloud" class="w-6 h-6"></i>';
    preview.className = logo
        ? 'w-12 h-12 rounded-xl overflow-hidden border border-gray-200 bg-white flex items-center justify-center shrink-0'
        : 'w-12 h-12 rounded-xl bg-blue-600 text-white flex items-center justify-center shrink-0';
    document.getElementById('btnBrandLogoRemove').classList.toggle('hidden', !logo);
}

async function saveBranding() {
    const btn = document.getElementById('btnSaveBranding');
    const name = document.getElementById('brandNameInput').value.trim();
    const title = document.getElementById('brandTitleInput').value.trim();
    btn.disabled = true;
    try {
        const res = await apiFetch('/api/branding', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, title })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not save branding');
        applyBranding(data.branding);
        showToast('Branding saved');
    } catch (err) {
        showToast(err.message);
    } finally {
        btn.disabled = false;
    }
}

function resetBrandingText() {
    document.getElementById('brandNameInput').value = '';
    document.getElementById('brandTitleInput').value = '';
    saveBranding();
}

async function uploadBrandLogo(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { showToast('Logo is too large (max 2 MB)'); return; }
    const form = new FormData();
    form.append('logo', file);
    try {
        const res = await apiFetch('/api/branding/logo', { method: 'POST', body: form });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not upload logo');
        applyBranding(data.branding);
        showToast('Logo updated');
    } catch (err) {
        showToast(err.message);
    }
}

async function removeBrandLogo() {
    try {
        const res = await apiFetch('/api/branding/logo', { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not remove logo');
        applyBranding(data.branding);
        showToast('Logo removed');
    } catch (err) {
        showToast(err.message);
    }
}

loadBranding();
