# L.U.C.Y. — Developer Setup, Build & Operations Guide

> **Authoritative Document:** `docs/DEVELOPMENT.md`  
> **Target Environment:** Windows 10 (1809+) / Windows 11 (64-bit)  
> **Last Updated:** October 29, 2026

---

## 1. Prerequisites & Toolchain

| Component | Minimum Version | Verified Host Version | Role |
| :--- | :--- | :--- | :--- |
| **Operating System** | Windows 10 (1809+) x64 | Windows 11 Enterprise (NT 10.0.26300.0) | Desktop OS & UI Automation host |
| **Node.js** | >= 20.0.0 LTS | v24.12.0 | Main runtime & Electron execution host |
| **npm** | >= 10.0.0 | 11.6.2 | Package manager & script runner |
| **Python** | >= 3.10 (64-bit) | 3.13.12 | Kokoro-82M ONNX local neural TTS service |
| **C# Compiler (`csc.exe`)**| .NET Framework 4.8 | `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` | Compiles native `LucyUiaWorker.exe` |
| **Git** | >= 2.30.0 | 2.36.1.windows.1 | Version control & source tracking |

---

## 2. Initial Workspace Setup

### 2.1 Clone and Install Dependencies
```powershell
# Clone the repository
git clone https://github.com/saileshwaranganesan/LUCY.git
cd LUCY

# Install production and development dependencies
npm install
```

### 2.2 Compile Native UI Automation Worker
L.U.C.Y. includes a native C# worker (`LucyUiaWorker.exe`) for fast, non-intrusive Windows UI Automation:
```powershell
# Compiles src/tools/native-uia/LucyUiaWorker.cs using Windows csc.exe
npm run build:worker
```

### 2.3 Provision Offline Speech Assets (Optional)
If local offline speech recognition via `whisper.cpp` is needed:
```powershell
# Downloads whisper-cli.exe and ggml-tiny.en.bin into bin/ and models/
npm run provision:whisper

# Verify offline speech model readiness
npm run verify:whisper
```

---

## 3. Running L.U.C.Y. in Development

### 3.1 Launch Desktop Application
```powershell
npm start
```
* **Main Window:** Loads [src/ui/index.html](file:///c:/Users/admin/Desktop/LUCY/src/ui/index.html) with the 2D canvas fairy companion and chat interface.
* **Floating Companion:** Spawns a frameless, always-on-top floating pet window docked to the primary display.
* **Background Mode:** When closed, L.U.C.Y. minimizes to the Windows system notification tray (`TrayIcon`). Right-click the tray icon to restore or select **Exit L.U.C.Y.** to shut down cleanly.

### 3.2 Configuration Storage Locations
User settings and state are stored outside the code repository in Windows user profile directories:

* **Packaged / Standard Path:** `%APPDATA%\lucy-desktop-assistant\`
  * `voice-config.json` — Active TTS engine (`windows-speech` or `kokoro`), volume, pitch, speed, and wake-word sensitivity.
  * `app-config.json` — Window geometry, close behavior (`background` vs `exit`), and theme preferences.
  * `memory/` — WASM SQLite database (`lucy-memory.sqlite`) and JSON fallback stores.
  * `secure/` — DPAPI-encrypted API keys and provider credentials.
* **Development Fallback:** `%APPDATA%\LUCY\` (Used when `app.getPath('userData')` is mocked or absent).

---

## 4. Build & Distribution Packaging

L.U.C.Y. produces reproducible Windows distribution packages using `electron-builder`:

```powershell
# 1. Unpacked Directory Build (win-unpacked/)
npm run package:dir

# 2. Production NSIS Installer (Setup executable)
npm run package:installer

# 3. Production Portable Executable (Self-extracting single binary)
npm run package:portable

# 4. Full Release Pipeline (Validates environment, compiles, packages, and hashes)
npm run release
```

### 4.1 Packaging Integrity Invariants
* **`sql.js` ASAR Inclusion:** `electron-builder.yml` explicitly packages `node_modules/sql.js/**/*` to prevent SQLite WASM missing-module crashes in production.
* **Portable NSIS Isolation (`DEF-UIA-001`):** `electron-builder.yml` sets `unpackDirName: false`, paired with the `scripts/patch-electron-builder.js` postinstall hook, ensuring portable instances extract into isolated `$PLUGINSDIR\app` directories to prevent file locking collisions.
* **Cryptographic Verification:** Every production release artifact is hashed and verified against `SHA256SUMS.txt`:
  ```powershell
  npm run release:verify
  ```

---

## 5. Diagnostics, Logging & Safety Practices

### 5.1 Verbose Logging
Launch Electron with chromium and Node logging enabled:
```powershell
$env:ELECTRON_ENABLE_LOGGING="1"
npm start
```

### 5.2 Single-Instance Mutex
Electron enforces a single-instance lock via `app.requestSingleInstanceLock()`. Launching a second instance will focus the existing window and terminate the secondary process with exit code 0.

### 5.3 Zero Secrets Policy
* **Never commit API keys, personal paths, or tokens.**
* Credentials added via the Settings Center are automatically encrypted via Windows DPAPI before being saved to disk.
* All logs, console outputs, and task checkpoints pass through `src/security/credential-store.js` and `src/security/ipc-validator.js` secret redactor regexes.
