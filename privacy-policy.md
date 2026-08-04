# Session Share — Privacy Policy

**Last updated: August 4, 2026**

## Overview

Session Share is a browser extension that allows you to capture, store, and share website login sessions (cookies) securely. This privacy policy explains what data we handle, how we use it, and your choices.

## Data We Do NOT Collect

Session Share does **NOT** collect, transmit, or store any of the following:

- Your name, email, or contact information
- Your browsing history
- Your IP address
- Your location
- Analytics or tracking data
- Any personally identifiable information (PII)

## Data Stored Locally on Your Device

The following data is stored **ONLY on your device** in the browser's extension storage:

| Data | Purpose | Encrypted |
|------|---------|-----------|
| Saved session cookies | Login sessions you choose to save | Yes (AES-GCM-256) |
| Master encryption key | Used to encrypt/decrypt saved sessions | Stored as JWK |
| PIN hash + salt | Optional PIN protection (PBKDF2) | Hashed (not reversible) |
| Extension settings | Dark mode, auto-close, notifications | No (not sensitive) |
| Last copied session | Fallback for paste operations | Yes (AES-GCM-256) |
| Favicon URLs | Display website logos | No (just domain names) |
| Custom names | User-defined session labels | No (not sensitive) |

**This data never leaves your device.** It is not sent to any server.

## External Services

The extension communicates with two external services only when you explicitly use specific features:

| Service | When Used | Data Sent |
|---------|-----------|-----------|
| Google Favicon Service (google.com/s2/favicons) | Automatically when saving a session | Only the domain name (e.g., netflix.com) |
| api.qrserver.com | Only when you click "Show QR Code" | The encrypted session token |

## Permissions Explained

| Permission | Why Needed |
|-----------|------------|
| cookies | Read login cookies from websites (core feature) |
| storage | Save encrypted sessions locally on your device |
| tabs | Open target websites when applying sessions |
| activeTab | Access current tab URL for save/copy |
| notifications | Show success/error notifications |
| contextMenus | Right-click "Copy/Paste Session" menu |
| clipboardRead | Read session tokens from clipboard (paste) |
| clipboardWrite | Write session tokens to clipboard (copy/share) |
| host_permissions (<all_urls>) | Read cookies from any website the user visits |

## Data Security

- AES-GCM-256 encryption for all saved sessions
- Per-user master key (no hardcoded keys)
- PBKDF2-SHA-256 PIN hashing (100,000 iterations)
- Token expiry for shared sessions (1h/24h/7d)
- Key rotation option (deletes all data)
- No server — data never leaves your device

## Your Choices

- **Delete all data**: Click "Clear All Data" in footer
- **Disable notifications**: Settings → toggle off
- **Remove PIN**: Settings → Manage PIN → Remove
- **Export data**: Settings → Export (encrypted backup)
- **Uninstall**: Removes all data immediately

## Children's Privacy

This extension is not directed at children under 13. We do not collect any data from children.

## Open Source

Session Share's source code is open and auditable.

## Contact

For privacy questions: session-share@sandeepkumar.dev

## Consent

By installing this extension, you consent to this privacy policy.
