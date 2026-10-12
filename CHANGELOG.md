# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.3.8] - 2026-10-12

### Security
- The **default admin** is protected: other admins can no longer change its password, role, status, folder scope or quota, and nobody can block, demote or delete it. In Users & Access it shows lock badges instead of controls.
- Admins can no longer delete their own account.

## [1.3.7] - 2026-10-12

### Removed
- Unused files moved to `archive/` (not packed into the build): `public/app_icon.jpg`, its copy `assets/app_icon.jpg`, and the old `public/launcher.html`. The `.exe` web bundle is about 1 MB smaller.

## [1.3.6] - 2026-10-12

### Changed
- Product name spelling fixed to **Rx Cloud** across the app, launcher, share page and README. File names (`RxCloude.exe`) stay the same so self-update keeps working.
- New login page: a vector illustration on the left and a sign-in card on the right with the logo and name centred above "Welcome back", icons in the fields, a show/hide password button and a cleaner sign-in button. On phones it shows just the card.
- **Date format** is now an admin setting in Users & Access and applies to every user (it was a per-browser sidebar option).

### Added
- Users & Access: change a user's **role** (User/Admin) from the table, and **enable/disable** accounts with a switch. Disabled users are signed out at once and cannot log in; their files are kept.

### Fixed
- The last active admin could still be disabled (the safety check ran before the change). Admins also cannot disable or demote their own account.
- The **Starred** filter pill jumped to two lines when selected.
- The loading-bar animation never ran: its CSS was in `style.css`, which no page loads. Moved to `mobile.css`.

## [1.3.5] - 2026-10-12

### Added
- **Branding** (Users & Access, admin only): upload a logo and set the app name and browser tab title. They apply on the login page, sidebar, phone header, tab icon and share page.
- Gallery navigation in the preview: previous/next arrows, a "3 / 14" counter, keyboard arrow keys and swipe on phones. It steps through the folder's images, videos and PDFs.
- A fixed "Powered by Rx Cloude" credit in the sidebar that branding does not change.

### Fixed
- Uploads could stop working until a page reload if an earlier upload failed partway; the "upload in progress" lock is now always released, and errors are shown in a dialog instead of a small toast.
- Choosing an empty folder with **Select Folder** did nothing; it now says the folder is empty.

## [1.3.4] - 2026-10-10

### Added
- Search scope: **This folder** (includes sub-folders) or **All folders**. Results show each item's location; clicking one opens its folder.
- **Total Drive Storage Limit (GB)** in admin settings. Uploads stop once the drive holds that much; the sidebar shows used space against the limit.
- **Recent** files and folders on the My Drive root.
- Loading bar under the header while a folder or search loads.
- Small developer credit under the version in the sidebar.

### Changed
- Clicking **My Drive** in the sidebar always returns to the drive root.
- Sidebar footer (storage, date format, version) laid out evenly.

### Fixed
- An active category filter (e.g. Images) hid every file with only "No files found". The page now says how many files the filter hides, with a **Show all** button.

## [1.3.3] - 2026-10-05

### Added
- Relative dates ("2 hours ago") that keep updating, with a **Date format** setting in the sidebar: relative, `05 Oct 2026`, `05 Oct 2026, 3:45 PM` or `05/10/2026`. Hovering a date shows the full date and time.
- Profile pictures: a **My Profile** window (header avatar or sidebar) to upload, change or remove a photo. Photos are cropped to a square and resized in the browser and shown in the header and the users list.

### Fixed
- Folder card dates were cut off next to the star and menu buttons.

## [1.3.2] - 2026-10-05

### Fixed
- Folder upload by drag & drop: dropped folders were sent as one empty file and failed. Folders and their sub-folders are now read properly.
- Folders with more than 500 files failed with "Too many files". Uploads are now sent in batches with one combined progress bar.
- Empty sub-folders in a dropped folder are now created.

### Added
- Drop files or folders anywhere on the drive page, not only inside the upload dialog.

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

[Unreleased]: https://github.com/itrabbi24/rx_cloud_ftp/compare/v1.3.8...HEAD
[1.3.8]: https://github.com/itrabbi24/rx_cloud_ftp/compare/v1.3.7...v1.3.8
[1.3.7]: https://github.com/itrabbi24/rx_cloud_ftp/compare/v1.3.6...v1.3.7
[1.3.6]: https://github.com/itrabbi24/rx_cloud_ftp/compare/v1.3.5...v1.3.6
[1.3.5]: https://github.com/itrabbi24/rx_cloud_ftp/compare/v1.3.4...v1.3.5
[1.3.4]: https://github.com/itrabbi24/rx_cloud_ftp/compare/v1.3.3...v1.3.4
[1.3.3]: https://github.com/itrabbi24/rx_cloud_ftp/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/itrabbi24/rx_cloud_ftp/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/itrabbi24/rx_cloud_ftp/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/itrabbi24/rx_cloud_ftp/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/itrabbi24/rx_cloud_ftp/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/itrabbi24/rx_cloud_ftp/releases/tag/v1.1.1
