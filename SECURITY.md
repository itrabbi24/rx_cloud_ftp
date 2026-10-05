# Security Policy

## Supported versions

Only the latest release receives security fixes.

| Version | Supported |
|---|---|
| 1.2.x | Yes |
| < 1.2 | No. Please upgrade: 1.2.0 fixes path traversal in Trash and stored XSS in previews |

## Reporting a vulnerability

**Please don't open a public issue.** Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository.

Please include:

- the affected version and how Rx Cloude was started (launcher, CLI, HTTPS or HTTP)
- steps to reproduce, or a proof of concept
- the impact you expect (data exposure, code execution, denial of service, and so on)

You can expect an acknowledgement within 7 days. Once a fix is released we will publish an advisory and, if you wish, credit you.

## Deployment notes

- Rx Cloude is designed for **trusted local networks**. Before you expose it to the internet, put it behind a reverse proxy with a real TLS certificate.
- Change the first-run admin password straight away. The app enforces this.
- Back up `data\` (accounts, shares, vault metadata) together with your shared folder.
- Vault files are encrypted with a key derived from the user's PIN. If the PIN is lost, the files can't be recovered.
