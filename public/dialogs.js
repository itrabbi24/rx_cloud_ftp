// =====================================================================
// Rx Cloude - styled confirm / alert dialogs (SweetAlert2, bundled locally
// in /vendor so it also works on LAN servers without internet access).
// Falls back to the browser's native dialogs if the library is missing.
// =====================================================================

const RX_DIALOG_CLASSES = {
    popup: 'rx-swal-popup',
    title: 'rx-swal-title',
    htmlContainer: 'rx-swal-text',
    actions: 'rx-swal-actions',
    confirmButton: 'rx-swal-btn rx-swal-confirm',
    cancelButton: 'rx-swal-btn rx-swal-cancel'
};

// Ask the user to confirm. Resolves true/false.
// options: { title, text, confirmText, cancelText, danger (red button), icon }
async function rxConfirm(options) {
    const opts = typeof options === 'string' ? { text: options } : (options || {});
    if (!window.Swal) return window.confirm(opts.text || opts.title || 'Are you sure?');
    const result = await Swal.fire({
        title: opts.title || 'Are you sure?',
        text: opts.text || '',
        icon: opts.icon || (opts.danger ? 'warning' : 'question'),
        showCancelButton: true,
        confirmButtonText: opts.confirmText || 'Yes',
        cancelButtonText: opts.cancelText || 'Cancel',
        reverseButtons: true,
        focusCancel: !!opts.danger,
        buttonsStyling: false,
        customClass: {
            ...RX_DIALOG_CLASSES,
            confirmButton: RX_DIALOG_CLASSES.confirmButton + (opts.danger ? ' rx-swal-danger' : '')
        }
    });
    return result.isConfirmed === true;
}

// Show a message with a single OK button.
async function rxAlert(options) {
    const opts = typeof options === 'string' ? { text: options } : (options || {});
    if (!window.Swal) { window.alert(opts.text || opts.title || ''); return; }
    await Swal.fire({
        title: opts.title || '',
        text: opts.text || '',
        icon: opts.icon || 'info',
        confirmButtonText: opts.confirmText || 'OK',
        buttonsStyling: false,
        customClass: RX_DIALOG_CLASSES
    });
}
