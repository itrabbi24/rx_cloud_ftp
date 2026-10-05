# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.3.1] - 2026-10-05

### Fixed
- Launcher: the Update button was hidden behind the title; it now sits under the status badge.

## [1.3.0] - 2026-10-05

### Added
- Update notifications: the launcher checks GitHub Releases at start and daily, then shows a tray message and an **Update** button. The web UI shows admins a banner.
- One-click self-update: downloads the new `RxCloude.exe`, swaps it in place, restarts, and starts the server again if it was running. Data and settings are kept.
- "Check for updates" in the tray menu. Set `RX_CLOUDE_NO_UPDATE_CHECK=1` to turn off the server-side check.

## [1.2.0] - 2026-10-05

### Added
- Phone app shell: bottom tab bar with a create button, bottom-sheet menus and dialogs, 2-column tiles, safe-area support and full-screen previews.
- Skeleton loading state and incremental rendering (120 items per page, with auto "show more" on scroll) for large folders.
- First-run admin credentials are shown in the launcher (popup, copied to clipboard), printed to the console and saved to `data\FIRST-LOGIN.txt` until changed.
- The launcher remembers port, folder and HTTPS settings; "Start with Windows" now starts the server straight to the tray.
- Launcher: one-click Windows Firewall rule, single-instance guard, crash detection, embedded window and tray icon.
- Folder upload keeps the folder structure.
- Styled confirmation dialogs (SweetAlert2, bundled for offline use) replace the browser's plain confirm/alert popups for delete, empty trash, discard changes and upload errors.
- Natural sort order (`file2` before `file10`).
- Project tooling: `npm run check`, `npm run dev`, CI workflow, contribution docs.

### Changed
- The vault asks for the PIN every time it is opened and locks when you leave it. The unlock is no longer kept in browser storage.
- A single password rule (minimum 4 characters) applies everywhere. Before, some screens required 12 and others 4.
- The embedded web UI is refreshed whenever its content changes, not only when the version number changes.
- The repository is reorganised into `src/`, `public/`, `launcher/`, `scripts/` and `assets/`. Builds go to `dist/`.

### Fixed
- Fresh installs could not log in: the generated admin password was never shown.
- In CLI mode, data was stored in `%LOCALAPPDATA%` instead of next to the exe.
- The launcher reported "Running" when another program (for example Apache) already owned the port on localhost.
- Ports that browsers block (`ERR_UNSAFE_PORT`, for example 123) are rejected with a clear message.
- Changing the vault PIN made existing vault files permanently unreadable.
- Moving a file into the vault failed after deleting the source and lost the file's name. Restoring from the vault could crash the server.
- File names containing `'` broke every button on their card.
- Rename silently overwrote an existing file. Moving a folder into its own subfolder crashed the request.
- The forced password-change dialog could be dismissed, leaving a broken UI, or stayed over the login page after a stale session.
- Expired sessions now log out instead of showing errors on every action.
- Preview videos kept playing after the dialog closed. Video seeking now works (HTTP range requests).
- The note editor failed on files larger than 100 KB.
- The phone header collapsed and overlapped the search bar.
- The launcher UI froze for 2 seconds on start, and the "&" in "Activity & Server Logs" was hidden.

### Security
- Fixed path traversal in Trash restore and delete (`trashId` such as `../../file`).
- Uploaded HTML/SVG files are sandboxed when previewed (stored XSS).
- The live activity log (usernames, IPs, file names) is only available to the server machine.
- File names are escaped everywhere they are rendered.
- Share-link password attempts are rate-limited. Usernames and folder scopes are validated.

## [1.1.1] - 2026-10-04

Packaging and launcher hotfixes (embedded web UI, HTTP by default, dual-stack binding, friendlier startup errors, encoding fixes). See [docs/HISTORY-1.1.x.md](docs/HISTORY-1.1.x.md) for the detailed notes.

[Unreleased]: https://github.com/itrabbi24/rx_cloud_ftp/compare/v1.3.1...HEAD
[1.3.1]: https://github.com/itrabbi24/rx_cloud_ftp/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/itrabbi24/rx_cloud_ftp/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/itrabbi24/rx_cloud_ftp/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/itrabbi24/rx_cloud_ftp/releases/tag/v1.1.1
