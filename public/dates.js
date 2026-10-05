// =====================================================================
// Rx Cloude - date display (relative "2 hours ago" or a fixed format)
// The chosen format is a per-browser preference (localStorage). Hovering a
// date always shows the full date and time.
// =====================================================================

const DATE_FORMATS = {
    relative: 'Relative (2 hours ago)',
    short: 'Date (05 Oct 2026)',
    full: 'Date & time (05 Oct 2026, 3:45 PM)',
    numeric: 'Numeric (05/10/2026)'
};

function getDateFormat() {
    try {
        const v = localStorage.getItem('rx_date_format');
        if (v && DATE_FORMATS[v]) return v;
    } catch (e) {}
    return 'relative';
}

function relativeTime(date) {
    const seconds = Math.round((Date.now() - date.getTime()) / 1000);
    if (seconds < 0) return 'just now'; // server clock slightly ahead
    if (seconds < 45) return 'just now';
    const units = [
        ['year', 365 * 24 * 3600], ['month', 30 * 24 * 3600], ['week', 7 * 24 * 3600],
        ['day', 24 * 3600], ['hour', 3600], ['minute', 60]
    ];
    for (const [name, size] of units) {
        const n = Math.floor(seconds / size);
        if (n >= 1) {
            if (name === 'day' && n === 1) return 'yesterday';
            return `${n} ${name}${n > 1 ? 's' : ''} ago`;
        }
    }
    return 'just now';
}

function formatDateText(value, format) {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return '';
    const f = format || getDateFormat();
    if (f === 'relative') return relativeTime(d);
    if (f === 'numeric') {
        const p = n => String(n).padStart(2, '0');
        return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
    }
    const day = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    if (f === 'full') return `${day}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    return day;
}

// HTML for templates: <span class="rx-date" data-ts=...>2 hours ago</span>
function rxDate(value) {
    const d = new Date(value);
    if (isNaN(d.getTime())) return '';
    const fullText = formatDateText(d, 'full');
    return `<span class="rx-date" data-ts="${d.getTime()}" title="${fullText}">${formatDateText(d)}</span>`;
}

// Re-render every visible date (after a format change, and each minute so
// "5 minutes ago" keeps counting).
function refreshDates() {
    const format = getDateFormat();
    document.querySelectorAll('.rx-date[data-ts]').forEach(el => {
        el.textContent = formatDateText(new Date(Number(el.getAttribute('data-ts'))), format);
    });
}

function setDateFormat(format) {
    if (!DATE_FORMATS[format]) return;
    try { localStorage.setItem('rx_date_format', format); } catch (e) {}
    refreshDates();
}

setInterval(() => { if (getDateFormat() === 'relative') refreshDates(); }, 60 * 1000);

document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('dateFormatSelect');
    if (!select) return;
    select.innerHTML = Object.entries(DATE_FORMATS).map(([k, label]) => `<option value="${k}">${label}</option>`).join('');
    select.value = getDateFormat();
    select.addEventListener('change', () => setDateFormat(select.value));
});
