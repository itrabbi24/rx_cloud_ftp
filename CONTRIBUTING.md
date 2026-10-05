# Contributing to Rx Cloude

Thanks for helping. This guide covers how to set up the project, our conventions, and how to send a change.

## Getting started

1. Fork the repository and clone your fork.
2. `npm install`
3. `npm run dev` runs the server from source on `http://localhost:8090`. The first run prints the admin login in the console.
4. Make your change, then run `npm run check`.
5. If you changed anything that ships in the exe, run `npm run build` and test `dist/RxCloude.exe` **by itself in an empty folder**. That is how users deploy it.

## Ground rules

- **One concern per pull request.** A bug fix and a redesign belong in separate PRs.
- **Keep the single-exe promise.** Don't add runtime dependencies that need native binaries, an installer or files next to the exe. Anything the UI needs must live in `public/`, which gets bundled.
- **Test on a phone-sized screen.** The UI has to work at 360–430 px wide as well as on desktop. The phone layout lives in `public/mobile.css` and `public/mobile.js`.
- **Security first.** Never put file names or user input into HTML without `escHtml()` or `jsArg()` (see `public/app.js`). Every file path from a client must go through `resolveSafePath()` on the server.
- **Removing code:** comment it out with a short note explaining why, rather than deleting it. This keeps changes easy to trace and revert.

## Code style

- JavaScript: 2-space indent in `src/`, 4-space indent in `public/` (match the file you're editing). Use `const`/`let`, async/await and single quotes.
- Comments explain *why*, not *what*. When you fix a bug, say what used to go wrong.
- `launcher/LauncherGui.cs` must stay **pure ASCII**. The C# 5 compiler reads BOM-less files in the system code page, so write non-ASCII characters as `\uXXXX`. `npm run check` enforces this.
- Don't write source files with PowerShell `Set-Content`/`Out-File`, because they re-encode text.

## Commit messages

Use short, imperative subjects, optionally with a scope:

```
fix(vault): re-encrypt files when the PIN changes
feat(ui): bottom tab bar on phones
docs: explain --root option
```

## Pull requests

- Fill in the PR template: what changed, why, and how you tested it.
- Add screenshots (desktop and phone) for UI changes.
- CI must pass (`npm run check` and a Windows build).
- Update `CHANGELOG.md` under **Unreleased**.

## Reporting bugs and ideas

Use the issue templates. For bugs, include the version (shown in the launcher title and the web sidebar), your Windows version, the browser, and the launcher log lines around the error.

Security issues go through [SECURITY.md](SECURITY.md), not public issues.
