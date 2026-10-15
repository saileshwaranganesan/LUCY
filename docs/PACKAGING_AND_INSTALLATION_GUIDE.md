# L.U.C.Y. — Packaging, Installation & User Guide

**Application Version:** `0.1.0-alpha`  
**Target Platform:** Windows 10 / Windows 11 (64-bit x64 / AMD64)  
**Distribution Type:** Standalone Windows Installer (NSIS) & Portable Executable  

---

## 1. Release Deliverables & Cryptographic Checksums

The release artifacts are stored in the project's release output directory: `dist-release/`.

| File Name | File Size | Target Description | SHA-256 Digest |
|---|---|---|---|
| **`L.U.C.Y-Setup-0.1.0-win-x64.exe`** | 170,176,539 B (~162.29 MB) | Standard Windows Installer (NSIS). Creates Start Menu & Desktop shortcuts, includes uninstaller. | `988fff53569ae9817759a029723329fa24bb3f6faac4b37274849a52e58b8861` |
| **`L.U.C.Y-Portable-0.1.0-win-x64.exe`** | 169,946,909 B (~162.07 MB) | Portable executable. Runs directly without installation or administrator privileges. | `54acd25258a5285c9c97a8111acef71352ee638889762747c696193c646503d8` |
| **`L.U.C.Y-Setup-0.1.0-win-x64.exe.blockmap`** | 179,473 B (~0.17 MB) | Differential update blockmap for Electron auto-updater. | `7912854e6492f7dbf72f452233d3c752b30b83ed15d4bca50faa7d34aaecc6ce` |
| **`SHA256SUMS.txt`** | Standard GNU format | Cryptographic checksum manifest for verification with `sha256sum -c` or PowerShell. | — |
| **`release-manifest.json`** | ~3.4 KB | Machine-readable release metadata with source revision commit, build timestamps, and hashes. | — |

To verify artifact integrity on Windows:
```powershell
# Verify using built-in verification script:
npm run release:verify

# Or verify manually via PowerShell:
Get-FileHash dist-release\L.U.C.Y-Setup-0.1.0-win-x64.exe -Algorithm SHA256
```

---

## 2. System Requirements

- **Operating System:** Windows 10 (version 1809+) or Windows 11 (64-bit).
- **Architecture:** x64 (AMD64 / Intel 64-bit).
- **Hardware:**
  - Minimum 4 GB RAM (8 GB recommended for multitasking and desktop automation).
  - Standard display adapter (hardware acceleration supported).
- **External Dependencies:** **NONE.**
  - Node.js, Python, or .NET development tools are **NOT** required.
  - The native Windows UI Automation engine (`LucyUiaWorker.exe`) is pre-compiled and bundled directly with the application.
  - The canonical `CelestialFamiliarRenderer` fairy companion engine is fully bundled with zero external asset dependencies.
  - The offline speech recognition runtime (`whisper-cli.exe` and `ggml-tiny.en.bin`) is pre-packaged.

---

## 3. Installation & First Launch (For Non-Developers)

### Step 1: Run the Installer
Double-click `L.U.C.Y-Setup-0.1.0-win-x64.exe`.

### Step 2: Windows SmartScreen Notice
Because this open-source build is distributed without an expensive commercial EV Code Signing Certificate, Windows SmartScreen may show an alert:
> *"Windows protected your PC — Microsoft Defender SmartScreen prevented an unrecognized app from starting."*

**How to proceed safely:**
1. Click **"More info"**.
2. Click **"Run anyway"**.
*(You can verify the SHA-256 checksum in Section 1 using PowerShell: `Get-FileHash L.U.C.Y-Setup-0.1.0-win-x64.exe -Algorithm SHA256`)*

### Step 3: Complete Setup
1. The installer defaults to installing in your user directory:
   `%LOCALAPPDATA%\Programs\LUCY\`
   *(Administrator privileges are **not** required).*
2. Choose whether to create a Desktop shortcut and Start Menu shortcut.
3. Click **Install**. The setup takes approximately 5–10 seconds.
4. Check **"Run L.U.C.Y."** and click **Finish**.

---

## 4. First-Time Configuration & Features

### Offline Mode
L.U.C.Y. launches immediately in **Offline Mode**. You do not need an internet connection or an AI API key to:
- Inspect running desktop applications (`desktop_list_apps`).
- Automate allowlisted Windows applications such as Notepad or Calculator.
- Interact with the floating fairy companion (drag, pet, float/dock, resizable bounds, tricks).
- Store and retrieve local memories via BM25 keyword search in SQLite.
- Test system tools in safe dry-run mode.

### Adding an AI Provider (Optional)
To enable cloud intelligence:
1. Click the **⚙️ Settings** icon in the top header.
2. Select your AI Provider:
   - **Google Gemini API** (recommended for speed and multimodal capabilities)
   - **OpenRouter**
   - **Ollama** (for local offline LLMs)
   - **Hugging Face** (serverless inference router)
3. Enter your API key. Keys are masked (`type="password"`) and encrypted using **Windows DPAPI** (`CryptProtectData`), keyed to your current Windows user account.
4. Click **Save Configuration**.

---

## 5. Directory Structure & Data Separation

L.U.C.Y. maintains a strict physical separation between application program files and user data:

| Content Category | Path on Windows | Purpose & Persistence |
|---|---|---|
| **Program Files** | `%LOCALAPPDATA%\Programs\LUCY\` | Application executable (`LUCY.exe`), ASAR bundles, libraries, and uninstaller. Replaced during upgrades; removed on uninstall. |
| **User Memory Store** | `%APPDATA%\lucy-desktop-assistant\memory\lucy-memory-store.json` | Persistent conversation history, semantic facts, user preferences, and routines. **Preserved across reinstalls and uninstalls.** |
| **Task Continuity** | `%APPDATA%\lucy-desktop-assistant\memory\task-checkpoints.json` | Checkpoints for interrupted multi-step workflows. |
| **Window State** | `%APPDATA%\lucy-desktop-assistant\companion-window-bounds.json` | Saved screen coordinates and dimensions for the floating fairy companion. |
| **User Workspace** | `%APPDATA%\lucy-desktop-assistant\workspace\` | Safe contained directory for file read/write operations. |
| **Protected Credentials** | `%APPDATA%\LUCY\secure\credentials.dpapi` | Windows DPAPI encrypted API keys. **Preserved across reinstalls.** |

---

## 6. Backup and Recovery

### How to Back Up Your L.U.C.Y. Data
To back up your conversation memory, custom preferences, and routines:
1. Press `Win + R`, type `%APPDATA%\lucy-desktop-assistant`, and press Enter.
2. Copy the `memory` folder to your backup location or external drive.

### How to Restore
1. Install L.U.C.Y. on your new computer.
2. Copy your backed-up `memory` folder into `%APPDATA%\lucy-desktop-assistant\`.
3. Launch L.U.C.Y. Your memories and routines will be loaded immediately.

---

## 7. Reinstallation & Uninstallation Lifecycle

### Updating or Reinstalling
- To upgrade or reinstall L.U.C.Y., simply run the new installer.
- The installer automatically detects the existing installation, updates program files in `%LOCALAPPDATA%\Programs\LUCY\`, and **preserves all existing memories, workspaces, and credentials**.

### Uninstallation & Data Retention Policy
- To uninstall, use **Windows Settings > Apps > Installed apps > L.U.C.Y. > Uninstall**, or run:
  `%LOCALAPPDATA%\Programs\LUCY\Uninstall LUCY.exe`
- **Data Retention Guarantee:**
  - The uninstaller deletes all program files, application shortcuts, and registry uninstall keys.
  - Per L.U.C.Y.'s data retention policy (`deleteAppDataOnUninstall: false`), your personal memory files in `%APPDATA%\lucy-desktop-assistant` and DPAPI credentials in `%APPDATA%\LUCY` are **intentionally preserved** so you do not accidentally lose your notes or configurations.
- **To completely delete all user data (Full Purge):**
  If you wish to delete all stored history and credentials after uninstalling, manually delete:
  ```powershell
  Remove-Item -Recurse -Force "$env:APPDATA\lucy-desktop-assistant"
  Remove-Item -Recurse -Force "$env:APPDATA\LUCY"
  ```

---

## 8. Developer Guide: Building from Source

To build and validate release artifacts from the repository:

```powershell
# 1. Compile the native Windows UI Automation worker
npm run build:worker

# 2. Run the complete automated test regression suite
npm test

# 3. Build the NSIS installer and portable executable
npm run dist

# 4. Validate output binaries, calculate checksums, and generate manifest
npm run release:validate
```

Output files will be generated in `dist-release/`.

---

## 9. Code-Signing Status & Security Disclosure

- **Current Status:** **Unsigned Open-Source Release.**
- **Rationale:** Code signing on Windows requires an Extended Validation (EV) hardware token certificate or Microsoft Azure Trusted Signing account. For development and community builds, binaries are distributed unsigned.
- **Verification Guarantee:** Users can independently verify file authenticity by checking that the SHA-256 hash of their downloaded executable matches the official release hash in Section 1.
