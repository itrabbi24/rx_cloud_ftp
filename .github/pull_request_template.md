## What and why

<!-- What does this change, and what problem does it solve? Link issues: "Fixes #123". -->

## How it was tested

- [ ] `npm run check` passes
- [ ] Tested from source (`npm run dev`)
- [ ] Rebuilt (`npm run build`) and tested `dist/RxCloude.exe` alone in an empty folder (if it affects the exe)
- [ ] Checked on a phone-width screen (if it affects the UI)

## Screenshots

<!-- Desktop and phone, for UI changes. -->

## Checklist

- [ ] `CHANGELOG.md` updated under **Unreleased**
- [ ] No user input is rendered without `escHtml()`/`jsArg()`; new file paths go through `resolveSafePath()`
