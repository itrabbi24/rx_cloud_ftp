// =====================================================================
// Rx Cloude - uploader (loaded after app.js; replaces uploadFilesReal)
//
// Fixes in this version of the uploader:
//  - Dragging a FOLDER in failed: the browser hands the folder over as one
//    empty "file". Dropped folders are now walked with webkitGetAsEntry().
//  - Folders with more than 500 files failed with "Too many files" (one
//    request). Files are now sent in batches with one combined progress bar.
//  - Empty sub-folders were skipped; they are now created too.
//  - Files/folders can be dropped anywhere on the drive page.
// =====================================================================

const UPLOAD_BATCH_FILES = 100;                  // server accepts up to 500
const UPLOAD_BATCH_BYTES = 256 * 1024 * 1024;    // keep each request reasonable
let uploadInProgress = false;

// Relative path to send for a file ("Folder/sub/file.txt" or "file.txt").
function uploadPathOf(file) {
    return file.rxRelativePath || file.webkitRelativePath || file.name;
}

// --- Reading dropped folders ---------------------------------------------
function readEntryFiles(entry, prefix, out, dirs) {
    return new Promise((resolve) => {
        if (entry.isFile) {
            entry.file(file => {
                try { file.rxRelativePath = prefix + file.name; } catch (e) {}
                out.push(file);
                resolve();
            }, () => resolve());
            return;
        }
        if (!entry.isDirectory) return resolve();
        const dirPath = prefix + entry.name;
        dirs.push(dirPath);
        const reader = entry.createReader();
        const all = [];
        // readEntries returns at most ~100 entries per call; keep reading.
        const readBatch = () => reader.readEntries(async (entries) => {
            if (!entries.length) {
                for (const child of all) await readEntryFiles(child, dirPath + '/', out, dirs);
                return resolve();
            }
            all.push(...entries);
            readBatch();
        }, () => resolve());
        readBatch();
    });
}

async function filesFromDataTransfer(dt) {
    const files = [];
    const dirs = [];
    const items = dt && dt.items ? Array.from(dt.items) : [];
    const entries = items
        .filter(it => it.kind === 'file')
        .map(it => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null));
    if (entries.length && entries.every(Boolean)) {
        for (const entry of entries) await readEntryFiles(entry, '', files, dirs);
    } else if (dt && dt.files) {
        // Old browsers: plain files only (folders show up as size-0 entries).
        Array.from(dt.files).forEach(f => { if (f.size > 0 || f.type) files.push(f); });
    }
    return { files, dirs };
}

// --- Creating empty folders ----------------------------------------------
async function ensureFolders(basePath, dirPaths) {
    // Parents first; "already exists" answers are fine.
    const sorted = Array.from(new Set(dirPaths)).sort((a, b) => a.split('/').length - b.split('/').length);
    for (const rel of sorted) {
        const parts = rel.split('/');
        const name = parts.pop();
        const parent = parts.length ? (basePath === '/' ? '/' : basePath + '/') + parts.join('/') : basePath;
        try {
            await apiFetch('/api/files/mkdir', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPath: parent, folderName: name })
            });
        } catch (e) {}
    }
}

// --- Batched upload -------------------------------------------------------
function makeBatches(files) {
    const batches = [];
    let current = [];
    let bytes = 0;
    for (const f of files) {
        if (current.length && (current.length >= UPLOAD_BATCH_FILES || bytes + f.size > UPLOAD_BATCH_BYTES)) {
            batches.push(current);
            current = [];
            bytes = 0;
        }
        current.push(f);
        bytes += f.size;
    }
    if (current.length) batches.push(current);
    return batches;
}

function sendBatch(batch, targetPath, onProgress) {
    return new Promise((resolve) => {
        const formData = new FormData();
        formData.append('path', targetPath);
        batch.forEach(f => formData.append('files', f, uploadPathOf(f)));
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/files/upload?path=' + encodeURIComponent(targetPath), true);
        if (authToken) xhr.setRequestHeader('Authorization', `Bearer ${authToken}`);
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
        xhr.onload = () => {
            let error = null;
            if (xhr.status !== 200) {
                error = 'Upload failed';
                try { error = JSON.parse(xhr.responseText).error || error; } catch (e) {}
            }
            resolve({ status: xhr.status, error });
        };
        xhr.onerror = () => resolve({ status: 0, error: 'Connection to the server was lost' });
        xhr.send(formData);
    });
}

// uploadFilesReal(files, extraDirs) - files may come from <input>, a folder
// picker (webkitRelativePath) or a drop (rxRelativePath).
uploadFilesReal = async function (fileList, extraDirs) {
    const files = Array.from(fileList || []);
    if (!files.length && !(extraDirs && extraDirs.length)) return;
    if (uploadInProgress) { showToast('Please wait for the current upload to finish'); return; }

    // Client-side size check (same rule as before).
    if (globalServerConfig && globalServerConfig.maxUploadMB > 0) {
        const maxBytes = globalServerConfig.maxUploadMB * 1024 * 1024;
        const tooBig = files.find(f => f.size > maxBytes);
        if (tooBig) {
            const sz = (tooBig.size / (1024 * 1024)).toFixed(1);
            rxAlert({ title: 'File too large', text: `"${tooBig.name}" (${sz} MB) is over the upload limit of ${globalServerConfig.maxUploadMB} MB per file.`, icon: 'error' });
            return;
        }
    }

    const targetPath = currentPath;
    const progressContainer = document.getElementById('upload-progress-container');
    const progressBar = document.getElementById('upload-bar');
    const progressText = document.getElementById('upload-percentage');
    const statusText = document.getElementById('upload-status-text');
    const modalOpen = !document.getElementById('uploadModal').classList.contains('hidden');
    if (!modalOpen) openUploadModal();
    progressContainer.classList.remove('hidden');

    uploadInProgress = true;
    const totalBytes = files.reduce((s, f) => s + f.size, 0) || 1;
    let doneBytes = 0;
    let uploaded = 0;
    const errors = [];

    // Folder structure first, so empty sub-folders exist too.
    const dirs = new Set(extraDirs || []);
    files.forEach(f => {
        const parts = uploadPathOf(f).split('/');
        for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    });
    if (dirs.size) {
        statusText.innerText = `Creating ${dirs.size} folder(s)...`;
        await ensureFolders(targetPath, Array.from(dirs));
    }

    const batches = makeBatches(files);
    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const batchBytes = batch.reduce((s, f) => s + f.size, 0);
        statusText.innerText = batches.length > 1
            ? `Uploading ${uploaded + 1}-${uploaded + batch.length} of ${files.length} files...`
            : `Uploading ${files.length} file(s)...`;
        const result = await sendBatch(batch, targetPath, (loaded) => {
            const pct = Math.min(100, Math.round(((doneBytes + loaded) / totalBytes) * 100));
            progressBar.style.width = pct + '%';
            progressText.innerText = pct + '%';
        });
        if (result.status === 401) { uploadInProgress = false; handleLogout(); return; }
        if (result.error) {
            errors.push(result.error);
            // Stop on errors that will repeat for every batch.
            if (result.status === 403 || result.status === 0 || /quota/i.test(result.error)) break;
        } else {
            uploaded += batch.length;
        }
        doneBytes += batchBytes;
    }

    uploadInProgress = false;
    progressContainer.classList.add('hidden');
    progressBar.style.width = '0%';
    progressText.innerText = '0%';

    if (errors.length) {
        rxAlert({
            title: uploaded ? 'Upload partly finished' : 'Upload failed',
            text: `${uploaded} of ${files.length} file(s) uploaded. ${errors[0]}`,
            icon: uploaded ? 'warning' : 'error'
        });
    } else {
        showToast(files.length ? `${files.length} file(s) uploaded` : 'Folder created');
        setTimeout(closeUploadModal, 400);
    }
    if (currentPath === targetPath) loadDirectory(currentPath);
};

// --- Drop handling --------------------------------------------------------
async function handleUploadDrop(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    document.body.classList.remove('rx-dragging');
    if (currentTab !== 'drive' || !authToken) return;
    const { files, dirs } = await filesFromDataTransfer(e.dataTransfer);
    if (!files.length && !dirs.length) return;
    uploadFilesReal(files, dirs);
}

function isFileDrag(e) {
    return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}

(function setupUploadDrop() {
    // The modal's drop zone: replace its old handler (it sent folders as files).
    const zone = document.getElementById('drop-zone');
    if (zone) zone.addEventListener('drop', handleUploadDrop, true);

    // Anywhere on the drive page. Internal drags (moving items between
    // folders) carry no "Files" type and are left alone.
    let depth = 0;
    document.addEventListener('dragenter', (e) => {
        if (!isFileDrag(e) || currentTab !== 'drive' || !authToken) return;
        depth++;
        document.body.classList.add('rx-dragging');
    });
    document.addEventListener('dragleave', (e) => {
        if (!isFileDrag(e)) return;
        depth = Math.max(0, depth - 1);
        if (!depth) document.body.classList.remove('rx-dragging');
    });
    document.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
    document.addEventListener('drop', (e) => {
        depth = 0;
        if (!isFileDrag(e)) return;
        if (e.target.closest && e.target.closest('#drop-zone')) return; // handled above
        handleUploadDrop(e);
    });
})();
