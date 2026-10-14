// =====================================================================
// Rx Cloud - zoom for the file preview (images and PDFs)
//
// Images: - / + buttons, percentage, Fit, rotate, mouse wheel, drag to pan,
//         double-click / double-tap to zoom, pinch on phones, keys + - 0.
// PDFs:   - / + / Fit drive the browser's PDF viewer through its #zoom=
//         open parameter (Chrome, Edge and Firefox all support it).
// =====================================================================

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 8;
const ZOOM_STEP = 1.25;
let imageZoom = null;   // state of the image currently shown, or null
let pdfZoom = null;     // state of the PDF currently shown, or null

function zoomButton(action, icon, title) {
    return `<button type="button" data-zoom="${action}" title="${title}" aria-label="${title}" class="p-1.5 rounded-lg hover:bg-white/15 cursor-pointer"><i data-lucide="${icon}" class="w-4 h-4"></i></button>`;
}

// ---- Images ----------------------------------------------------------------
function renderZoomableImage(container, url, name) {
    pdfZoom = null;
    container.innerHTML = `
        <div class="rx-zoom-stage relative w-full h-full min-h-[60vh] overflow-hidden flex items-center justify-center select-none" style="touch-action:none">
            <img src="${url}" alt="${escHtml(name)}" draggable="false" class="rx-zoom-img max-w-full max-h-full rounded-xl shadow-md object-contain will-change-transform" style="transform-origin:center center">
            <div class="rx-zoom-bar absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-0.5 px-1.5 py-1 rounded-xl bg-slate-900/75 text-white shadow-lg backdrop-blur z-10">
                ${zoomButton('out', 'zoom-out', 'Zoom out (-)')}
                <button type="button" data-zoom="reset" title="Actual size / fit (0)" class="rx-zoom-pct min-w-[52px] px-1.5 py-1 text-[11px] font-semibold tabular-nums rounded-lg hover:bg-white/15 cursor-pointer">100%</button>
                ${zoomButton('in', 'zoom-in', 'Zoom in (+)')}
                <span class="w-px h-4 bg-white/25 mx-0.5"></span>
                ${zoomButton('fit', 'maximize', 'Fit to screen')}
                ${zoomButton('rotate', 'rotate-cw', 'Rotate')}
            </div>
        </div>`;
    const stage = container.querySelector('.rx-zoom-stage');
    const img = container.querySelector('.rx-zoom-img');
    imageZoom = { stage, img, scale: 1, x: 0, y: 0, rot: 0 };

    container.querySelector('.rx-zoom-bar').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-zoom]');
        if (!btn) return;
        e.stopPropagation();
        const a = btn.dataset.zoom;
        if (a === 'in') zoomImageBy(ZOOM_STEP);
        else if (a === 'out') zoomImageBy(1 / ZOOM_STEP);
        else if (a === 'fit' || a === 'reset') resetImageZoom(a === 'reset' && imageZoom.scale === 1 ? 2 : 1);
        else if (a === 'rotate') { imageZoom.rot = (imageZoom.rot + 90) % 360; applyImageZoom(); }
    });

    // Mouse wheel zooms towards the pointer.
    stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        zoomImageBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
    }, { passive: false });

    // Double-click / double-tap: zoom in to 2x at that point, or back to fit.
    stage.addEventListener('dblclick', (e) => {
        if (e.target.closest('.rx-zoom-bar')) return;
        if (imageZoom.scale > 1) resetImageZoom(1);
        else zoomImageBy(2, e.clientX, e.clientY);
    });

    // Drag to pan (mouse and one finger); pinch with two fingers.
    const pointers = new Map();
    let last = null, pinch = null;
    stage.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.rx-zoom-bar')) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        stage.setPointerCapture(e.pointerId);
        if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: imageZoom.scale };
        }
        last = { x: e.clientX, y: e.clientY };
    });
    stage.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 2 && pinch) {
            const [a, b] = [...pointers.values()];
            const dist = Math.hypot(a.x - b.x, a.y - b.y);
            setImageScale(pinch.scale * (dist / pinch.dist), (a.x + b.x) / 2, (a.y + b.y) / 2);
            return;
        }
        if (imageZoom.scale > 1 && last) {
            imageZoom.x += e.clientX - last.x;
            imageZoom.y += e.clientY - last.y;
            last = { x: e.clientX, y: e.clientY };
            applyImageZoom();
        }
    });
    const end = (e) => {
        pointers.delete(e.pointerId);
        if (pointers.size < 2) pinch = null;
        last = pointers.size ? { ...[...pointers.values()][0] } : null;
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);

    // While zoomed in, a swipe pans the picture instead of changing file.
    stage.addEventListener('touchend', (e) => { if (imageZoom && imageZoom.scale > 1) e.stopPropagation(); });
    stage.addEventListener('touchstart', (e) => { if (imageZoom && imageZoom.scale > 1) e.stopPropagation(); }, { passive: true });

    applyImageZoom();
    if (window.lucide) lucide.createIcons();
}

function setImageScale(next, cx, cy) {
    const z = imageZoom;
    if (!z) return;
    next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    // Keep the point under the cursor/fingers in place while zooming.
    if (cx !== undefined) {
        const r = z.stage.getBoundingClientRect();
        const px = cx - (r.left + r.width / 2), py = cy - (r.top + r.height / 2);
        const k = next / z.scale;
        z.x = px - (px - z.x) * k;
        z.y = py - (py - z.y) * k;
    }
    z.scale = next;
    if (z.scale <= 1) { z.x = 0; z.y = 0; }
    applyImageZoom();
}

function zoomImageBy(factor, cx, cy) {
    if (imageZoom) setImageScale(imageZoom.scale * factor, cx, cy);
}

function resetImageZoom(scale) {
    if (!imageZoom) return;
    imageZoom.scale = scale || 1;
    imageZoom.x = 0;
    imageZoom.y = 0;
    applyImageZoom();
}

function applyImageZoom() {
    const z = imageZoom;
    if (!z) return;
    z.img.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.scale}) rotate(${z.rot}deg)`;
    z.stage.style.cursor = z.scale > 1 ? 'grab' : 'zoom-in';
    const pct = z.stage.parentElement && z.stage.parentElement.querySelector('.rx-zoom-pct');
    if (pct) pct.textContent = Math.round(z.scale * 100) + '%';
}

// ---- PDFs ------------------------------------------------------------------
const PDF_ZOOMS = [50, 75, 100, 125, 150, 200, 300];

function renderZoomablePdf(container, url, name) {
    imageZoom = null;
    container.innerHTML = `
        <div class="w-full h-[75vh] flex flex-col bg-white rounded-xl overflow-hidden border border-gray-200 shadow-sm">
            <div class="px-3 sm:px-4 py-2 bg-gray-50 border-b border-gray-200 flex justify-between items-center gap-2 text-xs text-gray-500">
                <span class="hidden sm:flex items-center gap-1.5 font-medium text-gray-700">
                    <i data-lucide="file-text" class="w-4 h-4 text-red-500"></i> PDF Document Viewer
                </span>
                <div class="rx-pdf-bar flex items-center gap-0.5 bg-white border border-gray-200 rounded-lg px-1 py-0.5 text-gray-700">
                    <button type="button" data-pdf="out" title="Zoom out" aria-label="Zoom out" class="p-1 rounded-md hover:bg-gray-100 cursor-pointer"><i data-lucide="zoom-out" class="w-4 h-4"></i></button>
                    <span class="rx-pdf-pct min-w-[48px] text-center text-[11px] font-semibold tabular-nums">Fit</span>
                    <button type="button" data-pdf="in" title="Zoom in" aria-label="Zoom in" class="p-1 rounded-md hover:bg-gray-100 cursor-pointer"><i data-lucide="zoom-in" class="w-4 h-4"></i></button>
                    <span class="w-px h-4 bg-gray-200 mx-0.5"></span>
                    <button type="button" data-pdf="fit" title="Fit page width" aria-label="Fit page width" class="p-1 rounded-md hover:bg-gray-100 cursor-pointer"><i data-lucide="maximize" class="w-4 h-4"></i></button>
                </div>
                <a href="${url}" target="_blank" class="text-blue-600 hover:underline flex items-center gap-1 font-medium shrink-0">
                    <span class="hidden sm:inline">Open in New Tab</span> <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
                </a>
            </div>
            <iframe class="rx-pdf-frame w-full flex-1 border-0 bg-white" title="${escHtml(name)}"></iframe>
        </div>`;
    pdfZoom = { frame: container.querySelector('.rx-pdf-frame'), pct: container.querySelector('.rx-pdf-pct'), url, level: null };
    container.querySelector('.rx-pdf-bar').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-pdf]');
        if (btn) stepPdfZoom(btn.dataset.pdf);
    });
    setPdfZoom(null);
    if (window.lucide) lucide.createIcons();
}

function stepPdfZoom(action) {
    if (!pdfZoom) return;
    const cur = pdfZoom.level === null ? 100 : pdfZoom.level;
    if (action === 'fit') return setPdfZoom(null);
    if (action === 'in') return setPdfZoom(PDF_ZOOMS.find(z => z > cur) || PDF_ZOOMS[PDF_ZOOMS.length - 1]);
    if (action === 'out') return setPdfZoom([...PDF_ZOOMS].reverse().find(z => z < cur) || PDF_ZOOMS[0]);
}

// null = fit width. The viewer only reads #zoom= when it loads, so the frame is reloaded.
function setPdfZoom(level) {
    if (!pdfZoom) return;
    pdfZoom.level = level;
    pdfZoom.pct.textContent = level === null ? 'Fit' : level + '%';
    const hash = level === null ? '#toolbar=1&view=FitH' : `#toolbar=1&zoom=${level}`;
    pdfZoom.frame.src = 'about:blank';
    setTimeout(() => { if (pdfZoom) pdfZoom.frame.src = pdfZoom.url + hash; }, 0);
}

// ---- Keyboard: + / - / 0 while a preview is open -------------------------
document.addEventListener('keydown', (e) => {
    const modal = document.getElementById('previewModal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Ignore state left over from a file that is no longer on screen.
    if (imageZoom && !imageZoom.stage.isConnected) imageZoom = null;
    if (pdfZoom && !pdfZoom.frame.isConnected) pdfZoom = null;
    if (!imageZoom && !pdfZoom) return;
    if (e.key === '+' || e.key === '=') { e.preventDefault(); imageZoom ? zoomImageBy(ZOOM_STEP) : stepPdfZoom('in'); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); imageZoom ? zoomImageBy(1 / ZOOM_STEP) : stepPdfZoom('out'); }
    else if (e.key === '0') { e.preventDefault(); imageZoom ? resetImageZoom(1) : stepPdfZoom('fit'); }
});
