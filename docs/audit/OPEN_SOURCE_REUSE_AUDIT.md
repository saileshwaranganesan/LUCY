# L.U.C.Y. — Mandatory Open-Source Reuse Audit Report
**Audit Date:** 2026-10-13  
**Auditor:** Antigravity Autonomous Engineering & Audit Agent  
**Context:** L.U.C.Y. is an integration project. This document audits the actual use, adaptation, rejection, and potential future reuse of mature open-source projects.

---

## 1. Executive Summary of Open-Source Reuse

L.U.C.Y. follows a strict policy: **Reuse mature existing implementations rather than reinventing from scratch**, while **strictly rejecting external components that introduce competing AI brains, autonomous agent loops, or permission bypasses**.

Of the 9 investigated repositories:
- **1 is installed and wrapped directly** via npm dependency: **Microsoft Playwright** (`playwright@^1.64.0`).
- **1 is present locally in `reference/AILIS`** (70.3MB extracted archive): Selectively **adapted** (BM25 lexical ranking, spoken text cleaner, speech provider abstraction); critical security vulnerabilities and competing agent loops were rejected.
- **2 are designated for near-term wrapping/adaptation**: **WinApp MCP** (`desktop-pilot-mcp`) for native Windows UIA desktop application automation, and **AVATAR** (`ARPAHLS/avatar`) for 3D transparent companion window overlays and audio-driven lip sync.
- **5 are evaluated as architectural references or rejected** due to runtime bloat, competing agent loops, or language mismatches.

---

## 2. Upstream Candidate Inventory & Detailed Evaluation

### Candidate 1: AILIS (`haowenGuo/AILIS`)
- **Upstream Repository:** `https://github.com/haowenGuo/AILIS`
- **Local Source Presence:** **Confirmed present locally** at `reference/AILIS` (70.3 MB extracted archive, 34 root files, 21 subdirectories).
- **Upstream Commit/Version:** Snapshot extraction of the active main branch (October 2026).
- **Licensing Audit:**
  - Code: MIT License (`reference/AILIS/LICENSE`).
  - Bundled Assets: `reference/AILIS/Resources/VRMA_MotionPack` contains a specific license from **pixiv Inc.** with commercial restrictions and mandatory attribution.
  - Avatar Asset: `reference/AILIS/model.vroid` (9.8 MB) is a human anime girl VRoid (`AILIS.vrm`), conflicting with L.U.C.Y.'s fantasy-creature companion vision.
- **Capabilities Provided by Upstream:**
  - Multi-agent Electron desktop assistant with React/Vite renderer.
  - Categorized JSON memory store with BM25 lexical retriever.
  - Push-to-talk Web Speech recognition and native speech synthesis wrapper.
  - Coordinate-based OS control tool (`ailis-computer-tool.cjs` using `mouse_click`, `keyboard_type`).
  - Heavy Crawl4AI Python research MCP server (`mcp-ailis-research-server.cjs`).
  - Session and checkpoint management.
- **Classification:** **Adapted from upstream** (modular components selected; monolithic shell and agent loops rejected).
- **Capabilities Reused in L.U.C.Y.:**
  1. `src/memory/lexical-retriever.js`: Adapted BM25 scoring algorithm ($k_1=1.2, b=0.75$), suffix stemming, and phrase boosting from `reference/AILIS/electron/ailis-memory-store.cjs`.
  2. `src/voice/speech-text-cleaner.js`: Adapted markdown/URL stripping from `reference/AILIS/src/tts-speech-text.js` and `ailis-spoken-reply.cjs`.
  3. `src/voice/speech-synthesis.js` & `speech-recognition.js`: Adapted NativeSpeechSynthesisCandidate and BrowserSpeechRecognition patterns from `reference/AILIS/src/speech-provider.js` and `browser-speech-recognition.js`.
  4. Task Checkpoint JSON schema patterns adapted from `ailis-session-manager.cjs`.
- **Upstream Flaws Detected & Remediated by L.U.C.Y.:**
  - *Secret Storage:* Upstream stored secrets using trivial Base64 (`SECRET_PROTECTION = 'local-file-base64'`). Remediated in L.U.C.Y. with native Windows DPAPI (`CredentialStore`).
  - *Dry-Run Leakage:* Upstream `ailis-computer-tool.cjs` bypassed `dryRun` on write/exec actions. Remediated in L.U.C.Y. with mechanical interception in `ToolRegistry`.
  - *Coordinate Clicks:* Upstream used blind pixel clicks. Remediated with Playwright DOM locators.
- **Unintegrated Capabilities Worth Future Consideration:**
  - Native window enumeration and window title tracking logic in `reference/AILIS/electron/native-window-helper.cjs`.

---

### Candidate 2: Microsoft Playwright (`microsoft/playwright`)
- **Upstream Repository:** `https://github.com/microsoft/playwright` / `https://playwright.dev`
- **Local Source Presence:** **Installed in `node_modules/playwright`** (version 1.64.0).
- **Licensing Audit:** Apache License 2.0 (fully compatible with L.U.C.Y.'s MIT license; attribution preserved in `NOTICE`).
- **Capabilities Provided by Upstream:**
  - Full headless and headful Chromium, Firefox, WebKit automation.
  - Auto-waiting locators (`locator.click()`, `locator.fill()`, `locator.innerText()`).
  - Detection of existing system Google Chrome and Microsoft Edge channels on Windows (`channel: 'chrome'`, `channel: 'msedge'`), eliminating separate 200MB+ binary downloads.
  - Viewport and full-page screenshot capture.
- **Classification:** **Wrapped through an adapter**.
- **Capabilities Reused in L.U.C.Y.:**
  - Wrapped inside `src/tools/browser-manager.js` and exposed via 6 tools in `src/tools/browser-tools.js` (`browser_navigate`, `browser_extract`, `browser_click`, `browser_fill`, `browser_screenshot`, `browser_close`).
- **Hardening Added by L.U.C.Y.:**
  - Gated behind `PermissionAuthority` with confirmation modals for consequential actions (`browser_fill`, `browser_click` on submit/pay/delete).
  - Mechanical dry-run isolation (`dryRunSimulate`).
  - Password and token masking (`[REDACTED_SECRET]`).
  - Cloudflare Turnstile / reCAPTCHA / hCaptcha fail-closed detection.

---

### Candidate 3: WinApp MCP (`floatingbrij/desktop-pilot-mcp`)
- **Upstream Repository:** `https://github.com/floatingbrij/desktop-pilot-mcp`
- **Local Source Presence:** Remote only (not currently cloned into `reference/`).
- **Upstream Version/Commit:** Active main branch.
- **Licensing Audit:** MIT License.
- **Capabilities Provided by Upstream:**
  - Model Context Protocol (MCP) server for Windows UI automation.
  - Direct integration with native Windows UI Automation (UIA) APIs.
  - Automates WinUI3, WPF, WinForms, UWP, and Win32 applications using accessibility element trees rather than blind screen coordinates.
  - Capabilities: element discovery, window focusing, invoke/click actions, text entry, inspect element properties.
- **Classification:** **Evaluated — Recommended for Next Milestone Integration**.
- **Duplicated Implementation in L.U.C.Y.:** None. L.U.C.Y. currently only automates the browser and local filesystem; it does not yet automate desktop native Windows applications.
- **Recommendation:** Wrap `desktop-pilot-mcp`'s UIA logic into `src/tools/desktop-app-tools.js` as an in-process Node.js or lightweight subprocess adapter. Route all actions through L.U.C.Y.'s central `PermissionAuthority`.

---

### Candidate 4: Windows Computer Use MCP (`sandraschi/windows-computer-use-mcp`)
- **Upstream Repository:** `https://github.com/sandraschi/windows-computer-use-mcp`
- **Local Source Presence:** Remote only.
- **Licensing Audit:** Apache-2.0 / MIT.
- **Capabilities Provided by Upstream:**
  - Implements Anthropic Computer Use protocol on Windows.
  - Built using Python and `pywinauto` with desktop screenshot capture and mouse/keyboard injection.
- **Classification:** **Evaluated and deprioritized in favor of `desktop-pilot-mcp`**.
- **Rationale:** Requires a persistent Python runtime with heavy `pywinauto` dependencies. `desktop-pilot-mcp` provides a lighter, more targeted UIA interface without the overhead of external Python subprocesses.

---

### Candidate 5: AVATAR (`ARPAHLS/avatar`)
- **Upstream Repository:** `https://github.com/ARPAHLS/avatar`
- **Local Source Presence:** Remote only.
- **Licensing Audit:** MIT License.
- **Capabilities Provided by Upstream:**
  - Electron-based transparent always-on-top desktop overlay companion.
  - Renders 3D `.vrm` character models via Three.js and `@pixiv/three-vrm`.
  - Dynamic audio-driven real-time lip sync and facial blendshapes synchronized to system audio or speech output.
- **Classification:** **Evaluated — Recommended Architectural Reference for Companion 3D Upgrade**.
- **L.U.C.Y. Reuse Decision:**
  - L.U.C.Y. currently renders a 2D procedural HTML5 Canvas familiar in a sidebar dock (`src/ui/companion-renderer.js`).
  - To achieve the vision of an interactive 3D fantasy companion, AVATAR's transparent overlay window configuration and audio-driven viseme animation engine should be adapted.
  - **Constraint:** Must use a cute fantasy-creature 3D model (GLB/VRM), strictly avoiding human anime avatars or proprietary motion pack license entanglements. The companion must remain a pure presentation layer without an independent agent loop.

---

### Candidate 6: Desk Pet 3D (`woooooooooolf/deskpet3d`)
- **Upstream Repository:** `https://github.com/woooooooooolf/deskpet3d`
- **Local Source Presence:** Remote only.
- **Licensing Audit:** MIT / Open Source.
- **Capabilities Provided by Upstream:**
  - Lightweight 3D desktop pet rendered using Raylib and C/C++.
- **Classification:** **Evaluated and rejected for direct integration**.
- **Rationale:** Built in C/Raylib; integrating compiled C native binaries into an Electron/Node.js desktop app increases packaging fragility, cross-compilation friction, and security attack surface compared to standard WebGL/Three.js inside Electron.

---

### Candidate 7: Wangeguo/Pet (`wangeguo/pet`)
- **Upstream Repository:** `https://github.com/wangeguo/pet`
- **Local Source Presence:** Remote only.
- **Licensing Audit:** Open Source.
- **Capabilities Provided by Upstream:**
  - AI-driven desktop pet with floating window and an independent "intent-aware AI brain".
- **Classification:** **Evaluated and rejected for direct integration**.
- **Rationale:** Violates L.U.C.Y.'s fundamental single-authority architectural rule: *"The companion is a visual and interaction layer. It must not have a separate AI brain, autonomous task coordinator, or permission system."* Its UI floating window techniques can be referenced, but its AI brain must be completely excluded.

---

### Candidate 8: SixOfFive/DesktopPet (`SixOfFive/DesktopPet`)
- **Upstream Repository:** `https://github.com/SixOfFive/DesktopPet`
- **Local Source Presence:** Remote only.
- **Licensing Audit:** Open Source.
- **Capabilities Provided by Upstream:**
  - Desktop pet overlay with basic sprite animations.
- **Classification:** **Evaluated as architectural reference only**.
- **Rationale:** Does not offer advanced 3D or modern WebGL rendering comparable to AVATAR or Three.js.

---

### Candidate 9: ASTRA (`shravan-kapare/ASTRA`)
- **Upstream Repository:** `https://github.com/shravan-kapare/ASTRA`
- **Local Source Presence:** Remote only.
- **Licensing Audit:** MIT.
- **Capabilities Provided by Upstream:**
  - Voice-driven personal assistant pipeline in Python.
- **Classification:** **Evaluated as architectural reference only**.
- **Rationale:** Python stack conflicts with L.U.C.Y.'s lightweight zero-download native Web Speech / SAPI5 architecture. L.U.C.Y.'s voice layer is already fully functional without Python dependencies.

---

## 3. Summary Table: Open-Source Reuse Decisions

| Candidate Repository | Status / Classification | Reused In L.U.C.Y. | Rejected / Avoided | Next Action |
|---|---|---|---|---|
| **haowenGuo/AILIS** | Adapted from upstream (local in `reference/AILIS`) | BM25 retrieval, speech text sanitizer, speech synthesis candidate patterns | Base64 secret storage, dry-run tool bypass, coordinate clicks, anime VRoid | Audit complete; preserve attribution in `NOTICE`. |
| **microsoft/playwright** | Reused directly (wrapped as adapter) | Core browser engine (`playwright@^1.64.0`), auto-waiting locators, Chrome/Edge detection | Unrestricted autonomous execution | Add full multi-page tab management adapter in future phase. |
| **floatingbrij/desktop-pilot-mcp** | Evaluated — Recommended | None yet | Secondary standalone MCP server process | Clone/wrap UIA automation engine into `src/tools/desktop-app-tools.js`. |
| **sandraschi/windows-computer-use-mcp** | Evaluated and deprioritized | None | Heavy Python / pywinauto subprocess dependency | Deprioritized in favor of lightweight UIA adapter. |
| **ARPAHLS/avatar** | Evaluated — Recommended for 3D | None yet | Competing agent loops or anime girl avatars | Adapt transparent window & audio lip-sync for 3D fantasy companion. |
| **woooooooooolf/deskpet3d** | Evaluated and rejected | None | Compiled C / Raylib native binaries | Reject; use WebGL/Three.js inside Electron. |
| **wangeguo/pet** | Evaluated and rejected | None | Competing "intent-aware AI brain" | Reject; preserve single authority coordinator. |
| **SixOfFive/DesktopPet** | Evaluated as reference | None | Low-fidelity 2D sprites | Reject in favor of 3D / WebGL. |
| **shravan-kapare/ASTRA** | Evaluated as reference | Architectural flow | Python voice stack | Retain current native Web Speech / SAPI5 engine. |
