// =====================================================================
// Rx Cloude - phone app shell glue (bottom tab bar, sheets, title)
// Loaded after app.js and features.js.
// =====================================================================

function isPhoneLayout() {
    return window.matchMedia('(max-width: 767.98px)').matches;
}

const MOBILE_TITLES = { drive: 'My Drive', starred: 'Starred', vault: 'Vault', trash: 'Trash', users: 'Users' };

function setMobileActive(tab) {
    document.body.setAttribute('data-tab', tab);
    document.querySelectorAll('#mobileBottomNav .mnav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-mtab') === tab);
    });
    const title = document.getElementById('mobileTitle');
    if (title) title.innerText = MOBILE_TITLES[tab] || 'Rx Cloude';
}

function mobileNav(tab) {
    closeAllSheets();
    if (tab === 'menu') {
        openMobileSidebar();
        return;
    }
    switchTab(tab);
}

// Keep the tab bar in sync however the tab was changed (sidebar, links...).
const _shellSwitchTab = switchTab;
switchTab = function (tab) {
    _shellSwitchTab(tab);
    setMobileActive(tab);
    const scroller = document.getElementById('main-scroll');
    if (scroller) scroller.scrollTop = 0;
};

// --- Sheets --------------------------------------------------------------
function openFabSheet() {
    closeAnyDropdown();
    document.getElementById('fabSheet').classList.add('show');
    document.getElementById('sheetBackdrop').classList.add('show');
}

function closeAllSheets() {
    const fab = document.getElementById('fabSheet');
    if (fab) fab.classList.remove('show');
    closeAnyDropdown();
    const backdrop = document.getElementById('sheetBackdrop');
    if (backdrop) backdrop.classList.remove('show');
}

// On phones the ⋮ menus are bottom sheets and need a backdrop.
const _shellToggleDropdown = toggleDropdown;
toggleDropdown = function (menuId, event) {
    _shellToggleDropdown(menuId, event);
    const menu = document.getElementById(menuId);
    const open = menu && !menu.classList.contains('hidden');
    const backdrop = document.getElementById('sheetBackdrop');
    if (backdrop) backdrop.classList.toggle('show', !!open && isPhoneLayout());
};

const _shellCloseAnyDropdown = closeAnyDropdown;
closeAnyDropdown = function () {
    _shellCloseAnyDropdown();
    const fab = document.getElementById('fabSheet');
    const backdrop = document.getElementById('sheetBackdrop');
    if (backdrop && !(fab && fab.classList.contains('show'))) backdrop.classList.remove('show');
};

// Android back button / swipe-back closes the open sheet or drawer first
// instead of leaving the app.
window.addEventListener('popstate', () => {
    const sidebar = document.getElementById('main-sidebar');
    const drawerOpen = sidebar && !sidebar.classList.contains('-translate-x-full') && isPhoneLayout();
    if (drawerOpen) closeMobileSidebar();
    closeAllSheets();
});

document.addEventListener('DOMContentLoaded', () => {
    if (window.lucide) lucide.createIcons();
    setMobileActive(typeof currentTab === 'string' ? currentTab : 'drive');
});
if (document.readyState !== 'loading' && window.lucide) lucide.createIcons();
