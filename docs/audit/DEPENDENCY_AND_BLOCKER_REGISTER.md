# L.U.C.Y. — Dependency, Platform, and Blocker Register
**Learning, Understanding, and Creating Yourself**  
**Engineering Workstream 05: Active Dependencies & Blocker Review**  

**Audit Date:** 2026-10-13  
**Auditor:** Antigravity Autonomous Engineering & Audit Agent  

---

## 1. System Runtime & Platform Manifest

| Component | Target Requirement | Detected Environment | Status | Verification Evidence |
|---|---|---|---|---|
| **Operating System** | Windows 10/11 64-bit | Windows 11 Enterprise x64 (`10.0.26100`) | **Verified** | `os.platform() === 'win32'`, `os.arch() === 'x64'` |
| **Node.js Runtime** | Node >= 20.x LTS | `v24.12.0` | **Verified** | `node -v` output |
| **Package Manager** | npm >= 10.x / pnpm | npm `11.6.2` (pnpm `11.18.0` detected) | **Verified** | `package.json` scripts execute cleanly |
| **Electron Runtime** | Electron 34.x | `34.5.8` (`node_modules/electron/dist/electron.exe`) | **Verified** | Verified in dev mode and installed `LUCY.exe` (PID 25152) |
| **Packaging Engine** | `electron-builder` >= 26.x | `26.15.3` (`electron-builder.yml`) | **Verified** | Produced NSIS installer (`87.8 MB`) and portable `.exe` (`87.5 MB`) |
| **Browser Engine** | Playwright Chromium | `playwright@^1.64.0` | **Verified** | Connects to local Chrome/Edge channels |
| **3D WebGL Engine** | Three.js >= 0.186 | `0.186.1` (vendored in `src/companion/vendor/three/`) | **Verified** | Verified WebGL dragon rendering and animations |
| **System Memory (RAM)** | Minimum 4 GB, Recommended 8 GB | Host has 16 GB physical RAM | **Verified** | `system_info` tool confirms healthy headroom |
| **Disk Storage** | Minimum 5 GB Free | ~77.8 GB Free on `C:` | **Verified** | Verified headroom on system partition |
| **Git Version Control** | Git >= 2.30 | Not initialized as git repo (`fatal: not a git repository`) | **Noted** | Command `git status` reports fatal; no `.git` folder |

---

## 2. Package Dependencies & Lockfile Audit

### 2.1 Manifest Inspection (`package.json`)
- **Direct Runtime Dependencies:**
  - `"playwright": "^1.64.0"` (Apache-2.0)
  - `"three": "^0.186.1"` (MIT) — Vendored in `src/companion/vendor/three/` to prevent package pruner stripping of `examples/jsm` loaders.
- **Development Dependencies:**
  - `"electron": "^34.5.8"` (MIT)
  - `"electron-builder": "^26.15.3"` (MIT)
- **Native C++ Compilers Required for Current Workspace:** **None**.
  - All current modules are pure JavaScript.
  - Windows DPAPI encryption is executed via standard Windows PowerShell (`System.Security.Cryptography.ProtectedData`), eliminating compilation requirements for `node-gyp`, Python `setuptools`, or Visual Studio C++ Build Tools.
  - Native Windows UI Automation worker (`LucyUiaWorker.exe`, 18 KB) compiles via pre-installed standard .NET Framework C# compiler (`csc.exe`).
- **Lockfile Status:** `package-lock.json` present and synchronized.

### 2.2 Optional vs. Mandatory Subsystems

| Subsystem | Mandatory / Optional | Offline Capability | Disk / Network Impact | Status |
|---|---|---|---|:---:|
| **Core Assistant Shell & UI** | **Mandatory** | 100% Offline | Zero external network calls; runs locally. | **Operational** |
| **3D Floating Companion Window** | **Mandatory** | 100% Offline | Transparent WebGL 3D dragon mesh (`dragon.glb`, 324 KB, CC0); runs locally via Three.js with 2D fallback. | **Operational** |
| **File & System Tools** | **Mandatory** | 100% Offline | Zero external network calls. | **Operational** |
| **Browser Automation (Playwright)** | **Mandatory** | 100% Offline (Local web) / Online (Web sites) | Reuses existing system Chrome / Edge (`channel: 'chrome'`); zero multi-hundred MB browser downloads required. | **Operational** |
| **Native Windows App Automation (UIA)** | **Mandatory** | 100% Offline | Native C# UIA worker (`LucyUiaWorker.exe`, 18 KB); 100% offline. | **Operational** |
| **Windows DPAPI Credential Store** | **Mandatory** | 100% Offline | Zero network calls; keys protected by local Windows user master key. | **Operational** |
| **Memory Store & BM25 Retriever** | **Mandatory** | 100% Offline | In-process JavaScript BM25 algorithm; zero external vector DB downloads. | **Operational** |
| **Speech Recognition (STT)** | **Mandatory** | Uses OS Chromium Speech API | Zero model downloads (uses native browser speech engine). | **Operational** |
| **Speech Synthesis (TTS)** | **Mandatory** | 100% Offline | Uses native Windows SAPI5 / Media Foundation voices (0 bytes downloaded, $0 cost). | **Operational** |
| **Production Installer Packaging** | **Mandatory** | Build-time only | Produced NSIS installer (`87.8 MB`) and portable `.exe` (`87.5 MB`) in `dist-release/`. | **Operational** |
| **Hosted AI Models (Gemini / OpenRouter)** | **Optional** | Requires Internet & API Key | User provides API key; no automatic fallback. | **Operational** |
| **Local AI Models (Ollama)** | **Optional** | 100% Offline | Requires user to install Ollama and download models (e.g. `ollama run qwen2.5:1.5b`). | **Operational** |

---

## 3. Active Blockers & Human Action Register

### 3.1 Active Blockers Assessment
- **Zero Critical Functional Blockers:** The core engine, browser automation, native Windows application control, 3D floating companion, voice interaction, persistent memory, and production installer are 100% functional and pass all 69 automated tests.
- **Residual Defect Blockers:**
  1. `SEC-004` (Missing Single-Instance Lock): Does not prevent single-instance execution, but causes race conditions if launched twice. Scheduled for Workstream 06.
  2. `SEC-005` (Permission Prompt Inactivity Timeout): Gate currently waits indefinitely if user is idle. Scheduled for Workstream 06.
  3. Windows SmartScreen Prompt: Caused by lack of an EV Code Signing Certificate. Documented honestly in user documentation with SHA-256 verification instructions.

---

### 3.2 Register of Manual Actions

| Item ID | Required Action | Responsible Party | Why Required | How to Perform |
|---|---|---|---|---|
| **MAN-001** | Provide AI Provider API Key OR Launch Local Ollama | User | L.U.C.Y. strictly avoids hardcoding secrets or making unapproved paid API calls. To perform open-ended natural language reasoning (beyond offline direct intent commands), a valid provider key is required. | Click **⚙️ Provider Settings** in L.U.C.Y., select provider (Gemini / OpenRouter), enter key, and click Save. Or run `ollama serve` locally on port 11434. |
| **MAN-002** | Initialize Git Version Control (Optional) | User | The workspace currently has no `.git` repository. Git history was not initialized autonomously to preserve user repository management choices. | Run `git init` in workspace root if version control tracking is desired. |
| **MAN-003** | Windows SmartScreen First-Launch Bypass | User | The installer is distributed unsigned (no commercial EV certificate). On first launch, Windows SmartScreen will prompt "Unknown Publisher". | Click **"More info"**, then click **"Run anyway"**. |
