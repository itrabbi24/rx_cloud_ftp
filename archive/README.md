# Archive

Files that are no longer used, kept here instead of being deleted so they are
easy to restore. Nothing in this folder is packed into the build.

| File | Was at | Why it was retired |
|---|---|---|
| `app_icon.jpg` | `public/app_icon.jpg` | Unused; every page and the manifest use `app_icon.png`. It still added ~640 KB to the `.exe` bundle. |
| `app_icon.assets-copy.jpg` | `assets/app_icon.jpg` | Unused duplicate of the file above; the build only needs `assets/app.ico`. |
| `launcher.html` | `public/launcher.html` | Old HTML launcher. The launcher window is now the C# app (`launcher/LauncherGui.cs`); nothing opens this page. |

To restore one, move it back to its old path and rebuild.
