# ☁️ Rx Cloude - Portable Server (Zero-Install)

> **Developed by:** ARG RABBI
> **Version:** 1.1.1

যেকোনো **উইন্ডোজ সার্ভার** বা **পিসি**-তে কোনো কিছু ইনস্টল ছাড়াই (Node.js বা ডাটাবেজ ছাড়া) সরাসরি **`RxCloude.exe`** রান করবেন।

---

## 🩹 1.1.1 hotfix 5 — localhost on every address family, and repaired text encoding

**Two things fixed here:**

### a) `localhost` now works however it resolves

The server bound IPv4 only (`0.0.0.0`), so `http://[::1]:PORT` got no answer —
and a browser that resolves `localhost` to IPv6 first would fail even though
`http://localhost:PORT` looked correct to the user.

The server now binds **dual-stack** (`::`, which accepts IPv4 and IPv6) and falls
back to IPv4-only automatically if the machine has IPv6 disabled. The HTTPS
certificate also covers `::1`.

Verified with the shipped exe — all of these return 200:

```
http://localhost:18998/        http://127.0.0.1:18998/
http://[::1]:18998/            http://192.168.50.238:18998/   http://<PC-NAME>:18998/
```

### b) Mangled characters in the web UI

`public/index.html` contained double-encoded text (`â€"`, `â€¢`) in the version
badge, the upload-limit badge and the password placeholders — the same
UTF-8-read-as-CP1252 trap that had already damaged `LauncherGui.cs`. The cause
was writing those characters through PowerShell, which re-encoded them.

Repaired, and the risky spots are now safe by construction:

| Was | Now |
|---|---|
| `vâ€"` (version badge) | `v-` |
| `Max: â€"` (upload badge) | `Max: -` |
| `â€¢â€¢â€¢â€¢` (6 password fields) | real `••••` bullets |

Also: removed a stray UTF-8 BOM from `public/sw.js`, and wrapped the vault-PIN
and share-password fields in proper `<form>` elements (Chrome warned about
password inputs outside a form).

> **Encoding rule for this project:** never write source files through
> PowerShell (`Set-Content`/`Out-File`). Use the editor or Node. PowerShell
> silently re-encodes non-ASCII text and re-introduces exactly this bug.

---

## 🩹 1.1.1 hotfix 4 — browser showed "This page isn't working" (ERR_EMPTY_RESPONSE)

**Symptom:** the launcher said *Running (8084)* and its log showed the URLs, but
opening `192.168.50.238:8084` in Chrome gave **ERR_EMPTY_RESPONSE**.

**Cause:** the server only spoke **HTTPS**. A browser treats a bare
`192.168.50.238:8084` in the address bar as **`http://`**, and a plain HTTP
request sent to a TLS-only port gets no answer at all — exactly the empty
response Chrome reported. (Verified: `https://…:8084` → 200, `http://…:8084` → no
data.) On top of that the certificate's only SAN was the literal text
`DNS:Rx Cloude LAN`, so no browser could ever validate it for an IP address.

**Fix:**
1. **Plain HTTP is now the default**, so typing the bare address works.
   HTTPS is opt-in via a new **"Encrypt (HTTPS)"** checkbox in the launcher
   (or `--https`, or `RX_CLOUDE_SCHEME=https`).
2. **The certificate now covers the real addresses**: `localhost`, `127.0.0.1`,
   every LAN IP, and the computer name — and it is regenerated automatically if
   an existing one covers fewer hosts.
3. **"Open Web Drive" and the log lines use the selected scheme** (they were
   hardcoded to `https://`).
4. Startup prints the exact address to use, and for HTTP reminds you to include
   the scheme:

```
[Server] Starting: version v1.1.1, port 8084, scheme HTTP
[Server] Open in a browser: http://localhost:8084
[INFO] Local: http://localhost:8084
[INFO] Network (WiFi/LAN): http://192.168.50.238:8084
```

Verified with the shipped exe: HTTP → 200 from both `localhost` and
`192.168.50.238`; HTTPS → 200 with SANs
`DNS:localhost, IP:127.0.0.1, IP:192.168.50.238, IP:172.29.144.1, DNS:<PC-NAME>`.

> **Recommendation:** leave HTTPS off on a LAN. It is slower to set up (every
> client must accept a self-signed certificate warning) and gives no real
> protection against a self-signed certificate's threat model anyway. Turn it on
> only if you specifically need the transport encrypted.

---

## 🩹 1.1.1 hotfix 3 — clear startup errors instead of a stack trace

**Symptom:** when the port was taken, the launcher log filled with a raw Node
stack trace (`at process.processTicksAndRejections`, `Emitter 'error' event on
WebSocketServer instance`, `errno: -4091 EADDRINUSE`) and the status badge went
stale — it showed "Stopped" even though the panel briefly said Running.

**Cause:** `server.listen()` reports bind failures asynchronously through the
`'error'` event, so the listen callback never runs. `WebSocketServer` re-emits
that error on the HTTP server, and with no listener attached Node terminated the
process with an unhandled `'error'` event.

**Fix:**
1. An error listener is attached **before** `WebSocketServer` is created, so the
   error is handled instead of crashing.
2. Common failures now produce a one-line explanation:

```
[ERROR] Server could not start: Port 8080 is already in use. Close the program using it, or choose another port.
```

   Also handled: `EACCES` (use a port above 1024), `EADDRNOTAVAIL`.
3. The engine exits with a non-zero code on failure, so the launcher reports
   "Server failed to start. See the error above." instead of silently resetting.
4. The launcher **filters Node stack-trace lines** ("at …", stray braces,
   "Node.js v…"), so the log stays readable.
5. The launcher now waits ~1.8 s before declaring success, so the badge cannot
   say "Running" for a server that already died.

> **Note for this machine:** something is already listening on **port 8080**
> (`httpd.exe`, a web server). Use a different port (e.g. **8084**) in the
> launcher, or stop that service first.

---

## 🩹 1.1.1 hotfix 2 — mangled characters in the launcher window

**Symptom:** the launcher showed `â˜ Rx Cloude`, `ðŸ“ Browse`, `â–¶ Start Server`,
`â— Stopped` instead of icons.

**Cause:** `LauncherGui.cs` contained emoji (☁ 📁 ▶ ⚡ 🌐) as UTF-8 **without a
BOM**. The C# compiler reads a BOM-less file using the system ANSI codepage, so
every build re-interpreted those bytes and produced the `â˜`/`ðŸ` pattern. The
file had already been through this cycle once, so the damaged sequences were
baked into the source.

**Fix:**
1. Every caption is now **plain ASCII** (`Start Server`, `Browse`, …) — the
   source has **0 bytes above 127**, so no codepage can corrupt it again.
2. Icons moved into their own labels using `\uXXXX` escapes, because a Windows
   control can only use one font and icon fonts contain no letters.
3. The icon font is detected at runtime: **Segoe Fluent Icons** with
   **Segoe MDL2 Assets** as fallback (both verified to have every glyph used).
4. Icon colours fixed — white glyphs on the blue/green buttons were invisible,
   so the button icons are now dark.

> If you ever add non-ASCII text to `LauncherGui.cs`, save it as **UTF-8 with
> BOM**, otherwise the compiler will mangle it again.

---

## 🩹 1.1.1 hotfix — "Server failed to start" on paths ending with `\`

**Symptom:** the launcher reported

```
Server failed to start or exited immediately.
Error: ENOENT: no such file or directory, mkdir 'C:\...\FTP"\data'
```

**Cause:** the launcher passed paths as command-line arguments wrapped in
quotes:

```csharp
psi.Arguments = string.Format("--root \"{0}\"", appDir);
```

`BaseDirectory` ends with a backslash, producing `--root "C:\...\FTP\"`. In
Windows quoting `\"` is an **escaped quote**, so the closing quote was swallowed
and the engine received `C:\...\FTP"\` — a path that cannot exist. Any install
path ending in a separator, or a folder the user pasted with quotes, hit this.

**Fix:**
1. **Paths are now passed by environment variable** (`RX_CLOUDE_ROOT`,
   `RX_CLOUDE_DIR`, `RX_CLOUDE_PORT`), which no quoting layer can corrupt.
   Command-line arguments still work and are used as a fallback.
2. **Input sanitising** in the launcher and both CLIs: surrounding quotes and
   trailing `\` `/` are stripped, and an empty result falls back to the
   executable folder.
3. **Proper Windows argument quoting** for anything still passed on the command
   line (handles spaces, quotes and trailing backslashes).
4. **Port validation** in the GUI (digits only, 1–65535, otherwise 8080).
5. **The engine now prints its resolved paths at startup**, so a bad path is
   visible immediately instead of surfacing as an ENOENT deep in the data layer:

```
[Server] Starting: version v1.1.1, port 8084
[Server] App root: C:\Users\RABBI-IT\Desktop\FTP
[Server] Data folder: C:\Users\RABBI-IT\Desktop\FTP\data
[Server] Shared folder: C:\Users\RABBI-IT\Desktop\FTP\shared_files
```

Verified with the shipped exe in a folder named `Rx Cloude GUI Test` (spaces),
with trailing `\` in arguments, and with quoted path values — all start cleanly
and create `data\` in the right place.

---

## 🔄 What changed in 1.1.1 (UI fixes)

Measured in a real browser across 320 / 390 / 430 / 768 / 834 / 900 / 1024 / 1280 / 1440 px.

- **CRITICAL: the packaged EXE had no web UI at all.** `pkg` silently ignored the
  `pkg.assets` configuration (`launcher.html`, `public/**/*`), so every built
  `.exe` answered **404 on `/`, `/app.js`, `/style.css`** … — verified with globs,
  an explicit file list, an absolute entry path and an external `--options`
  config. The UI is now embedded as base64 in a generated `assets-bundle.js`
  (which `pkg` does bundle) and extracted to `data/web` on first run, so
  `RxCloudeEngine.exe` / `RxCloude.exe` serve the full interface.
  `npm run build:assets` regenerates the bundle and runs automatically as part
  of `build:all`.
- **Header no longer overflows.** The filter pills row was being squeezed to
  **28 px** on a 1024 px screen while needing 628 px, pushing content out of the
  header; at 768–834 px the profile avatar and action buttons ran off the right
  edge. The header is now a wrapping layout: on phones the search field moves to
  its own row, and labels collapse progressively (`xl` → icon-only).
- **Upload modal shows the real limit.** The "Max: …" element did not exist in the
  markup, so the JS update silently did nothing; the hardcoded "up to 50 GB" text
  was wrong whenever a global limit was set. Both are now driven by the server
  config (`Max: 1024 MB/file`).
- **Public share page no longer throws.** `share.html` used the Tailwind **v3**
  API (`tailwind.config = {...}`) against the bundled Tailwind **v4** browser
  build, raising `ReferenceError: tailwind is not defined` on every visit. The
  theme is now declared with Tailwind v4's `@theme` block.
- **Accessibility pass.** Every icon-only button now has an `aria-label`
  (19 buttons, including each file/folder action menu with `aria-haspopup` and
  `aria-expanded`), form labels are associated with their fields (`for`/`id`),
  range inputs and the share link are labelled, and the login error uses
  `role="alert"`. Removed the browser warnings about password fields and
  restored `autofocus` with proper `autocomplete` hints.
- **Version stamping** across `package.json`, `LauncherGui.cs`, `public/sw.js`
  (cache tag `rx-cloude-v5`) and the `/api/version` endpoint.

### Build files added
| File | Purpose |
|---|---|
| `build-assets.js` | Generates `assets-bundle.js` from `public/` + `launcher.html` |
| `assets-bundle.js` | Generated base64 web UI (do not edit by hand) |
| `stamp-version.js` | Writes the version into the `.exe` file properties |

### Where the version now appears

| Location | Example | Source |
|---|---|---|
| **EXE file properties** (all three) | `FileVersion 1.1.1.0`, `ProductName Rx Cloude`, `Company ARG RABBI` | `stamp-version.js` (build step) |
| **Launcher title bar** | `Rx Cloude - Portable Server v1.1.1` | `LauncherGui.cs` → `AppVersion` |
| **Login screen** (bottom right) | `v1.1.1` | `GET /api/version` |
| **Sidebar** (under Storage Status) | `Rx Cloude v1.1.1` · `Node v18.5.0` | `GET /api/version` |
| **Settings → Server Build card** | `v1.1.1` · `Node runtime v18.5.0` | `GET /api/version` |
| **Public share page footer** | `Rx Cloude v1.1.1` | `GET /api/version` |
| **API** | `GET /api/version` → `{"name","version","node"}` | `package.json` |
| **PWA cache tag** | `rx-cloude-v5` | `public/sw.js` |

A release now needs the version changed in exactly **one** place
(`package.json` → `version`); `npm run build:all` propagates it to the exe
properties and the web UI. Only `LauncherGui.cs` (`AppVersion`) and
`public/sw.js` (`CACHE_NAME`) are still manual — both are noted in the file.

---

## 🔄 What changed in 1.1.0

- **Fixed `--root` being ignored.** The data layer was loaded before the root
  argument was applied, so `--root` silently had no effect and the server read
  and wrote `data\` in its current directory instead. `--root` now governs the
  data folder, the TLS folder and the default shared folder.
- **Upload limit is enforced before the file is written.** Oversized uploads are
  rejected with HTTP 413 and nothing is left on disk, instead of being written
  out and then deleted.
- **`Session Days` setting actually works.** Login token lifetime used to be
  hardcoded to 7 days; it now follows the configured value (1-365 days).
- **`/api/config` no longer leaks the storage path or port** to unauthenticated
  visitors on the login page.
- **HTTPS certificate renews automatically** when it is missing, unreadable or
  within 30 days of expiry. The expiry date is printed on startup.
- **The launcher no longer runs a stale server engine.** Engine freshness is
  verified by size **and** SHA-256 hash (previously size only), and the engine is
  replaced atomically.
- **`/api/version` added**, and the version is shown in the admin settings page
  and in the launcher title bar.
- **Removed the legacy `admin123` fallback** that forced a password change for
  anyone whose password happened to equal it.

---

## 🚀 সার্ভারে ব্যবহারের নিয়ম (Server Usage)

সার্ভারের টার্মিনাল বা কমান্ড প্রম্পটে গিয়ে সহজ কমান্ড দিন:

### ১. ডিফল্টভাবে চালু করতে (Port 8080):
```powershell
.\RxCloude.exe
```
*(যদি আর্গুমেন্ট ছাড়া সরাসরি টার্মিনালে চালু করেন, এটি আপনাকে পছন্দের Port এবং Folder Path টাইপ করতে বলবে। জাস্ট Enter চাপলেই ডিফল্টভাবে চালু হয়ে যাবে)*

### ২. নির্দিষ্ট Port এবং Folder সিলেক্ট করে চালু করতে:
```powershell
.\RxCloude.exe -p 9090 -d "D:\SharedDrive"
```
বা বড় ফর্মে:
```powershell
.\RxCloude.exe --port 9090 --dir "C:\Users\Administrator\Files"
```

### ৩. ডাটা ফোল্ডার আলাদা জায়গায় রাখতে (`--root`):
```powershell
.\RxCloude.exe --port 9090 --root "D:\RxCloudeData" --dir "D:\RxCloudeData\files"
```
`--root` ঠিক করে দেয় `data\` (ইউজার, সেটিংস, TLS সার্টিফিকেট) কোথায় তৈরি হবে।
না দিলে ডাটা `RxCloude.exe`-এর ফোল্ডারেই থাকবে।

### ৪. সাহায্য মেনু দেখতে:
```powershell
.\RxCloude.exe --help
```

---

## 🔑 প্রথমবার চালু করলে (First Run)
- **Username:** `admin`
- শুরুর পাসওয়ার্ড নির্ধারণ করতে প্রথমবার চালুর **আগে** environment variable সেট করুন:
```powershell
$env:RX_CLOUDE_ADMIN_PASSWORD = "একটি-শক্তিশালী-পাসওয়ার্ড"
.\RxCloude.exe
```
- এটি সেট না করলে সার্ভার একটি র‍্যান্ডম পাসওয়ার্ড তৈরি করে কনসোলে দেখাবে।
- প্রথম লগইনের পর **অবশ্যই পাসওয়ার্ড পরিবর্তন করতে হবে** (এর আগে অ্যাডমিন API বন্ধ থাকে)।

---

## ⚙️ সেটিংস (Admin → Users & Access Control)
- **Max Single File Upload Limit (MB):** `0` দিলে সীমা থাকবে না (সর্বোচ্চ 50 GB)।
- **Allow Public Self-Registration:** পাবলিক রেজিস্ট্রেশন চালু/বন্ধ।
- **Login Session Length (days):** নতুন লগইনের টোকেন কত দিন চলবে (1-365)।
- **Server Build:** বর্তমানে চলা সার্ভারের ভার্সন।

---

## 🛠️ ডেভেলপারদের জন্য (Development & Build)
```powershell
npm ci                 # ডিপেন্ডেন্সি ইনস্টল
npm start              # সোর্স থেকে চালানো (node launcher.js)
npm run build:all      # তিনটি .exe তৈরি (engine → server → GUI)
```
> বিল্ড ক্রম গুরুত্বপূর্ণ: GUI `.exe`-এর ভেতরে `RxCloudeEngine.exe` রিসোর্স হিসেবে
> ঢুকিয়ে কম্পাইল করা হয়, তাই `build:engine` আগে চালাতে হবে।

ভার্সন এক জায়গায় নেই — রিলিজের সময় এই তিনটি জায়গায় একসাথে বদলান:
`package.json` → `version`, `public/sw.js` → `CACHE_NAME`, `LauncherGui.cs` → `AppVersion`।

---

## 🛡️ সার্ভার ফিচারসমূহ
- **Standalone Binary:** সার্ভারে অন্য কোনো সফটওয়্যার ইনস্টল লাগবে না।
- **CLI Logging:** কনসোলে লাইভ কে কোন ফাইল ডাউনলোড/আপলোড করল তা প্রিন্ট হবে।
- **Background Service:** চাইলে Windows Task Scheduler বা NSSM দিয়ে ব্যাকগ্রাউন্ড উইন্ডোজ সার্ভিস বানিয়ে রাখা যাবে।
- **Google Drive Web UI:** ক্লায়েন্টরা ব্রাউজারে `http://SERVER_IP:PORT` দিয়ে ঢুকলে প্রিমিয়াম গুগল ড্রাইভ ইন্টারফেস পাবে।
- **Self-signed HTTPS:** LAN-এর জন্য স্বয়ংক্রিয়ভাবে সার্টিফিকেট তৈরি ও নবায়ন হয়।
- **Vault:** PIN দিয়ে আলাদা এনক্রিপ্টেড স্টোরেজ (AES-256-GCM)।
