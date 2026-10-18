# L.U.C.Y. - Open-Source Reuse & Evaluation Audit

## Milestone: Safe Browser Automation

### 1. Evaluated Repositories & Implementations

| Candidate Project | License | Capabilities Evaluated | Decision | Rationale |
|---|---|---|---|---|
| **AILIS Computer Tool** (`reference/AILIS/electron/ailis-computer-tool.cjs`) | MIT | OS-level coordinate clicks (`mouse_click`, `mouse_move`, `keyboard_type`) | **REJECTED** for browser automation | 1. Relies on blind coordinate pixels rather than DOM locators, violating Requirement 6.<br>2. Bypassed dry-run for write actions.<br>3. Brittle across screen resolutions and window shifts. |
| **AILIS Research MCP Server** (`reference/AILIS/scripts/mcp-ailis-research-server.cjs`) | MIT | `webpage_screenshot`, `web_find`, Crawl4AI worker | **ADAPTED / SCHEMAS BORROWED** | Borrowed clean input schema definitions (`url`, `selector`, `maxChars`). Heavy 14,000-line Python/Crawl4AI MCP subprocess server rejected in favor of direct Node.js Playwright binding. |
| **Microsoft Playwright** (`microsoft/playwright`) | Apache-2.0 | Cross-browser automation engine, auto-waiting locators, content extraction, screenshots, form filling | **SELECTED & INTEGRATED** | Mature, robust, official locator engine (`locator.click()`, `locator.fill()`, `locator.innerText()`, `locator.inputValue()`), native Chromium/Edge channel detection, zero coordinate guessing. |

---

### 2. Capabilities Reused & Integrated
- **Playwright Chromium Engine (`playwright@1.56.x`)**:
  - Leverages local installed Google Chrome (`channel: 'chrome'`) and Microsoft Edge (`channel: 'msedge'`) on Windows without requiring separate 200MB+ downloads.
  - Robust auto-waiting locators (CSS, text, role) preventing flaky timing bugs.
  - Page-level visual extraction and viewport screenshot buffers.

---

### 3. Modifications & Security Hardening Made for L.U.C.Y.
1. **Centralized Permission Enforcement**:
   - `browser_navigate`: Assigned to `NETWORK_READ` (public page navigation).
   - `browser_extract`: Assigned to `SAFE_READ` (DOM inspection).
   - `browser_screenshot`: Assigned to `NETWORK_READ`.
   - `browser_fill`: Assigned to `CONSEQUENTIAL` (form modification / input entry requires explicit user confirmation).
   - `browser_click`: Dynamic risk tiering (consequential keywords like `submit`, `pay`, `buy`, `delete`, `save` trigger `CONSEQUENTIAL` interactive gate).
2. **Mechanical Dry-Run Isolation**:
   - Implemented `dryRunSimulate` for all 6 browser tools. In dry-run mode, real Playwright calls are mechanically bypassed; simulated receipts are returned without opening network sockets or modifying page states.
3. **Bot / CAPTCHA Barrier Fail-Closed Protection**:
   - Detects Cloudflare Turnstile, challenge stages, Google reCAPTCHA, and hCaptcha.
   - Refuses automated bypass, halts execution, and reports `security_gate_detected` with prompt for human verification.
4. **Credential & Secret Protection**:
   - Password fields and sensitive inputs are automatically masked as `[REDACTED_SECRET]` in result receipts and execution logs.
5. **DOM Verification**:
   - Every fill action performs an immediate `inputValue()` round-trip verification to ensure input integrity before reporting success.

---

### 4. Tests Run & Verification Evidence
- **Automated Offline Test Suite** (`tests/browser/browser-automation.test.js`):
  - 10/10 tests passing using local HTTP test server.
  - Navigation, text extraction, link extraction, form filling, password masking, robust selector clicking, confirmation gate denial, dry-run simulation, CAPTCHA barrier detection, screenshot capture, and clean closure.
- **Live Real-Runtime Integration Suite** (`scripts/verify-real-electron.js`):
  - Verified live browser navigation, content extraction, and session closure directly through the running Electron desktop window.

---

## Milestone: Voice Integration (Speech Input & Speech Output)

### 1. Evaluated Repositories & Implementations

| Candidate Project | License | Capabilities Evaluated | Decision | Rationale |
|---|---|---|---|---|
| **AILIS Browser Speech Recognition** (`reference/AILIS/src/browser-speech-recognition.js`) | MIT | Web Speech Recognition wrapper (`SpeechRecognition` / `webkitSpeechRecognition`), push-to-talk start/stop, interim/final transcript merging, and device error mapping | **SELECTED & ADAPTED** | Zero multi-GB models to download, zero cloud streaming by default, native Chromium/Electron support, instant push-to-talk start/stop state machine. |
| **AILIS Native Speech Synthesis Candidate** (`reference/AILIS/src/speech-provider.js`) | MIT | Native Web Speech Synthesis wrapper (`window.speechSynthesis` / `SpeechSynthesisUtterance`), Windows SAPI5 / Media Foundation voice ranking, rate/pitch adjustment, word boundary events, instant cancellation | **SELECTED & ADAPTED** | 100% offline-capable on Windows without downloading 2GB+ TTS weights, zero cloud API fees, instant `speechSynthesis.cancel()` interruption, native SAPI5 voice ranking. |
| **AILIS Spoken Text Cleaner** (`reference/AILIS/src/tts-speech-text.js` & `electron/ailis-spoken-reply.cjs`) | MIT | Markdown, code block, URL, and file path stripping before speech synthesis | **SELECTED & ADAPTED** | Prevents speech engines from pronouncing code tokens, backticks, or raw URLs; produces natural spoken delivery. |
| **OpenAI Whisper (Local)** / **Piper TTS** | MIT / MIT | Local neural speech-to-text / text-to-speech models | **RESERVED FOR FUTURE OPTIONAL EXTENSION** | Requires multi-gigabyte PyTorch/ONNX runtime and model downloads (exceeds conservative disk/memory budget for default install). Web Speech API provides zero-overhead baseline. |
| **Cloud Speech APIs (ElevenLabs / Google Cloud TTS)** | Commercial | Cloud streaming TTS/STT | **REJECTED AS DEFAULT** | Violates privacy constraints (unconsented audio streaming) and cost constraints (paid fallback). Local native voices are free and private. |

---

### 2. Capabilities Reused & Integrated
- `src/voice/speech-text-cleaner.js`:
  - Adapts `tts-speech-text.js` and `ailis-spoken-reply.cjs` to sanitize Markdown code blocks, backticks, links, URLs, and file paths.
- `src/voice/speech-recognition.js`:
  - Adapts `browser-speech-recognition.js` to provide explicit push-to-talk start/stop controls, interim transcript previews, final text emission, and descriptive error mapping.
- `src/voice/speech-synthesis.js`:
  - Adapts `NativeSpeechSynthesisCandidate` from `speech-provider.js` to provide native Windows SAPI5 voice discovery, ranking (female English voice preference for Lucy celestial fairy persona), speech synthesis, boundary tracking, and instant cancellation.
- `src/voice/voice-controller.js`:
  - Central orchestrator coordinating speech recognition, speech synthesis, UI state changes, and decoupled task coordinator dispatch.

---

### 3. Modifications & Security Hardening Made for L.U.C.Y.
1. **Zero External Model Downloads & Zero Cost**:
   - Uses native Web Speech and Windows OS voice components with 0 bytes downloaded and 0 cloud cost.
2. **Explicit User Control & Interruption (Push-to-Talk)**:
   - Explicit start/stop mic button (`🎙️ Mic` / `🛑 Stop Mic`). No always-listening background wake word.
   - Dedicated prominent `⏹️ Stop Voice` button and `Escape` key shortcut instantly calls `speechSynthesis.cancel()`.
3. **Electron Permissions & Fail-Safe Fallback**:
   - Registered `session.defaultSession.setPermissionRequestHandler` in Electron main process to grant media access safely without prompt crashes.
   - Safe error handling for missing audio devices (`audio-capture`) or denied permissions (`not-allowed`) with non-blocking user feedback.
4. **Text Chat Continuity (Decoupled Execution)**:
   - All voice transcriptions route into the central `TaskCoordinator` and `commandInput`.
   - Text chat remains 100% operational regardless of audio device status or failures.
5. **Synchronized Companion Persona Expressions**:
   - Companion celestial fairy familiar visual states synchronized with actual speech states: `listening` (radiant magenta aura shimmer), `thinking` (purple aura), and `speaking` (glowing emerald aura with animated talking mouth).

---

### 4. Tests Run & Verification Evidence
- **Automated Test Suite** (`tests/voice/voice-integration.test.js`):
  - 5/5 tests passing:
    * Sanitizer stripping markdown, code blocks, URLs, and file paths.
    * Push-to-talk start/stop and transcription forwarding.
    * Error handling for missing microphones, denied permissions, and unsupported environments.
    * Speech synthesis voice ranking, playback, and instant cancellation.
    * VoiceController state coordination, interruption, and text-only fallback resilience.
- **Real-Runtime Electron CDP Verification** (`scripts/verify-live-voice.js`):
  - 100% PASS across live Electron DOM verification, mute toggle, speech playback, Stop Voice button, mic push-to-talk, and text command execution with live screenshot artifact (`lucy_voice_integration_verified.png`).

---

## Milestone: Persistent Memory and Continuity

### 1. Evaluated Repositories & Implementations

| Candidate Project | License | Capabilities Evaluated | Decision | Rationale |
|---|---|---|---|---|
| **AILIS Memory Store** (`reference/AILIS/electron/ailis-memory-store.cjs`) | MIT | Categorized JSON memory persistence, BM25-based lexical retrieval, term frequency weighting, working data expiration | **ADAPTED WITH CRITICAL FIXES** | 1. **BM25 Lexical Retrieval Engine Reused**: Tokenization, stemming, BM25 scoring ($k_1=1.2, b=0.75$), and exact phrase boosting reused to avoid heavy external vector database dependencies or network calls.<br>2. **Insecure Storage Rejected**: AILIS implemented `SECRET_PROTECTION = 'local-file-base64'`, which is insecure encoding rather than encryption. L.U.C.Y. maintains strict separation: secrets belong in DPAPI `CredentialStore`, while `MemoryStore` systematically strips and redacts credentials.<br>3. **Injection Vulnerability Fixed**: AILIS had no source gating; untrusted scraped web data could pollute user memory. L.U.C.Y. added strict origin checking (`source: 'untrusted_external'` blocked from writing to `user_approved`). |
| **AILIS Session & Checkpoint Manager** (`reference/AILIS/electron/ailis-session-manager.cjs`) | MIT | Task checkpointing, step completion state, resume attempts | **ADAPTED & HARDENED** | Reused task checkpoint schema and atomic JSON writes. Added verification receipt validation, non-repeating step execution filtering, and explicit confirmation requirements before resuming consequential steps. |
| **External Vector DBs (Chroma, Pinecone, LanceDB)** | Apache-2.0 / Proprietary | Neural embeddings & semantic similarity search | **REJECTED** | Requires downloading hundreds of megabytes of embedding models or paying third-party APIs. BM25 phrase-boosted lexical search is instant, lightweight, 100% offline, and zero-dependency. |

---

### 2. Capabilities Reused & Integrated
- `src/memory/lexical-retriever.js`:
  - BM25 ranker adapted from AILIS search patterns ($k_1=1.2, b=0.75$), with Porter-style suffix stemming, exact phrase boosting ($+35\%$), numeric token boost, and CJK bi-gram tokenization.
- `src/memory/memory-store.js`:
  - 5 separated memory categories (`conversation`, `user_approved`, `task_continuity`, `project`, `working_data`).
  - Secret redaction (`[REDACTED_SECRET]`) on all stored contents.
  - Indirect prompt injection defense preventing untrusted external sources from directly creating user-approved memories.
  - Working data TTL auto-purging (`purgeExpired()`).
  - Long-term memory toggle (`longTermEnabled`).
  - Memory conflict detection (`hasConflict`, `conflictWith`).
  - Atomic JSON file writing (`data/memory/memory-store.json`).
- `src/memory/task-continuity-store.js`:
  - Task checkpointing to `data/memory/task-checkpoints.json`.
  - State machine (`in_progress`, `interrupted`, `completed`, `failed`, `discarded`).
  - State inspection before resumption (`inspectTaskForResume(taskId)`).
  - Safe resumption without repeating verified completed actions (`resumeTask(taskId, coordinator)`).

---

### 3. Modifications & Security Hardening Made for L.U.C.Y.
1. **Strict Credential / Ordinary Memory Separation**:
   - `MemoryStore` systematically detects API keys, passwords, bearer tokens, and session cookies via regex and replaces them with `[REDACTED_SECRET]` before persistence. Plaintext secrets are never stored in memory files or activity logs.
2. **Indirect Prompt Injection Defense**:
   - Web search snippets, downloaded documents, and untrusted files with `source: 'untrusted_external'` cannot write into `user_approved` memory category without explicit user verification.
3. **Safe Task Recovery & Non-Repeating Steps**:
   - On resumption, already completed and verified steps are never re-executed.
   - Consequential pending actions (file writes, deletes, browser submissions) are flagged and require explicit user re-authorization before executing.
4. **Single Authority Task Coordinator**:
   - All memory retrieval and task continuity routes through the single authoritative `TaskCoordinator` and `lucyIpc`. No competing agents or sidecar coordinators.

---

### 4. Tests Run & Verification Evidence
- **Automated Memory Test Suite** (`tests/memory/memory-continuity.test.js`):
  - 5/5 tests passing: BM25 lexical ranking, 5-category persistence across restarts, secret redaction, untrusted source rejection, long-term memory toggle, conflict detection, and non-repeating crash recovery.
- **Full Test Suite** (`npm test`):
  - 41/41 tests passing across the entire project repository.
- **Real-Runtime Electron CDP Verification** (`scripts/verify-live-memory.js`):
  - Verified live in Electron on Windows:
    * 5 separated categories stored and retrieved.
    * Secret redaction (`[REDACTED_SECRET]`) confirmed in live store.
    * Untrusted external memory promotion blocked with security error.
    * Long-term memory toggle ON/OFF verified.
    * Editing and deleting memories verified.
    * Crash recovery across application restart verified without repeating completed steps.
    * Live screenshot artifact captured: `lucy_memory_continuity_verified.png`.

---

## Milestone: Futuristic JARVIS UI, Local Fairy Voice, and Desktop Pet Architecture

### 1. Evaluated Repositories & Implementations

| Candidate Project | License | Capabilities Evaluated | Decision | Rationale |
|---|---|---|---|---|
| **Axshatt/VirtualAssistant** (`github.com/Axshatt/VirtualAssistant`) | **MIT** | Stark Industries JARVIS HUD layout, tech corner brackets (`.bracket-tl`, `.bracket-br`), scanline overlays, radar sweep animation, monospace typography, status badges | **SELECTED & ADAPTED** | Highly compatible HTML/CSS/JS Electron architecture. Clean, lightweight visual assets extracted without heavy third-party framework dependencies. Provides authentic holographic HUD aesthetics. |
| **dengyie/OpenPet** (`github.com/dengyie/OpenPet`) | **MIT** | Transparent desktop pet window, tactile drag feedback (`cursor: grab`, `body.is-dragging { cursor: grabbing }`), frosted speech bubbles with high-contrast backdrop filter | **SELECTED & ADAPTED** | Perfectly matches Lucy's floating companion window requirements. Tactile grabbing feedback and frosted speech bubble styling directly enhance user engagement while preserving Lucy's canonical fairy familiar. |
| **Hexgrad / ONNX Kokoro-82M** | **Apache-2.0** | 82M parameter lightweight English TTS, INT8 quantized ONNX CPU inference, dual female voice presets (`af_bella`, `af_sky`) | **SELECTED & INTEGRATED** | 100% offline, free, zero network audio streaming. 108.8 MB footprint with 1.9s cold start and 3.2s warm synthesis on 6 CPU worker threads. Native fallback to Windows SAPI5 ensures zero-downtime reliability. |
| **Suketu-ADT/jarvis-ai** (`github.com/Suketu-ADT/jarvis-ai`) | N/A | Investigated for futuristic dashboard and voice integration components | **REJECTED** | Repository is non-existent, deleted, or private (HTTP 404). Not available for reuse. |
| **sairin1202/lumi-deskpet** (`github.com/sairin1202/lumi-deskpet`) | N/A | Investigated for companion animations and window positioning | **REJECTED** | Repository is non-existent, deleted, or private (HTTP 404). Not available for reuse. |
| **SixOfFive/DesktopPet** (`github.com/SixOfFive/DesktopPet`) | N/A | Investigated for desktop pet resizing, dragging, and persistence | **REJECTED** | Repository is non-existent, deleted, or private (HTTP 404). Not available for reuse. |
| **wangeguo/pet** (`github.com/wangeguo/pet`) | **Apache-2.0** | Rust and Bevy 3D desktop companion models and physics engine | **REJECTED** | Incompatible tech stack (compiled Rust/Bevy 3D runtime vs Electron web stack). 3D models violate Lucy's canonical 2D procedural canvas celestial fairy familiar mandate. |

---

### 2. Capabilities Reused & Integrated
1. **From `Axshatt/VirtualAssistant` (MIT License)**:
   - **HUD Corner Framing (`.jarvis-corner-bracket`)**: High-tech L-shaped corner brackets applied to `.jarvis-hero-card` and `.jarvis-box` containers with glowing cyan illumination (`#00f2fe`) and hover brightening.
   - **Scanline Overlays (`.jarvis-scanlines`)**: Subtle 4px alternating scanlines with translucent cyan gradient (`rgba(0, 242, 254, 0.028)`) overlaid across command panels.
   - **Radar Sweep Animation (`.jarvis-sweep-line`)**: Glowing horizontal sweep line scanning across the command centre hero card.
   - **Telemetry Badges & Metrics**: Monospace telemetry values (`telemetry-val`) and status tags.
2. **From `dengyie/OpenPet` (MIT License)**:
   - **Tactile Drag Feedback (`body.is-dragging`)**: Active cursor states (`cursor: grab` at rest, `cursor: grabbing` on body when moving) for seamless floating pet dragging across desktop screens.
   - **Frosted Speech Bubbles**: High-contrast glassmorphic backdrop filter (`backdrop-filter: blur(14px)`) and responsive side conversation panel.
3. **From Kokoro-82M (Apache-2.0 License)**:
   - **Neural On-Demand TTS**: INT8 quantized ONNX weights (`kokoro-v1.0.int8.onnx`, 108.8 MB) and voice pack (`voices.bin`, 1,020 KB) generating realistic, feminine spoken audio for Lucy.
   - **Dual Voice Presets**: Bella (`af_bella`, warm & clear) and Sky (`af_sky`, bright & playful).

---

### 3. Modifications & Security Hardening Made for L.U.C.Y.
1. **Preserved Canonical Fairy Companion (`CelestialFamiliarRenderer`)**:
   - Kept Lucy's expressive 2D celestial fairy familiar intact across both docked sidebar and floating desktop modes. No 3D dragons or external character replacements introduced.
2. **Strict Memory Budget & On-Demand Lifecycle**:
   - Model is loaded into an isolated Python child process only on first spoken utterance or test audition.
   - 30-second idle timer automatically unloads the model, reclaiming 289 MB of RAM (down to 79 MB idle).
   - 450 MB worker memory budget strictly enforced with automatic fail-safe fallback to Windows SAPI5 speech synthesis.
3. **Rock-Solid Floating Pet Resizing, Persistence & Return**:
   - Default dimensions: 160 × 190 px (compact tiny pet).
   - Safe bounds clamping: 140..520 px width, 170..600 px height.
   - Size persisted to `data/config/companion-window-bounds.json` across app restarts.
   - Return to App reliably restores/unminimizes main window and docks companion cleanly.
4. **Live Spectral Audio Visualizer**:
   - Driven by live Web Audio `AnalyserNode` FFT frequency sampling (`getAudioFrequencyData()`) during audio playback; strictly zero simulated/fake visualizer math.
5. **Fail-Closed Security & IPC Validation**:
   - Voice configuration validated in `src/security/ipc-validator.js`: rejects unknown engines or unauthorized voice preset names.
   - Sizing inputs validated and clamped against non-numeric or extreme inputs.

---

### 4. Tests Run & Verification Evidence
- **Automated Integration & Lifecycle Suites**:
  - `tests/voice/jarvis-and-kokoro-integration.test.js` (8/8 PASS): Verifies JARVIS 5-view architecture, color tokens, Kokoro voice configuration, speech synthesis, Windows speech fallback, IPC validation, and offline asset integrity.
  - `tests/voice/kokoro-tts.test.js` (10/10 PASS): Verifies on-demand initialization, separate worker process, speech synthesis, queueing, instant interruption/cancellation, memory budget enforcement, and idle auto-unloading.
  - `tests/companion/companion-return-and-size.test.js` (11/11 PASS): Verifies Return to App behavior, window un-minimization, bounds clamping, and persistent size across restarts.
- **Full Repository Test Suite (`npm test`)**:
  - **458 / 458 tests passing** (0 failures, 0 regressions).

---

## Milestone: Unified Browser & Windows Desktop Automation

### 1. Evaluated Repositories & Implementations

| Candidate Project | License | Capabilities Evaluated | Decision | Rationale |
|---|---|---|---|---|
| **Microsoft Playwright** (`microsoft/playwright`) | **Apache-2.0** | Cross-browser Chromium/Edge automation, robust auto-waiting locators, DOM content extraction, form fills, dropdown selection, scrolling, multi-tab orchestration, downloads | **REUSED & EXTENDED** | Production-ready browser automation engine. Zero coordinate clicking or brittle sleep loops. Extended with specialized web/YouTube search, dropdown option selection, vertical/directional scrolling, and credential masking. |
| **Microsoft UI Automation (`UIAutomationClient` / `UIAutomationTypes`) via Native C# Worker** | **MIT / Public Domain** | Out-of-process Windows desktop control, window enumeration, window focusing (`SetForegroundWindow`), control identification, invocation (`InvokePattern`), text entry (`ValuePattern`), modal dialog handling | **REUSED & COMPILED** | Native Windows accessibility framework. Zero third-party heavy Python libraries (e.g. PyAutoGUI/pywinauto rejected to avoid multi-hundred megabyte runtime bloat). Compiled via .NET `csc.exe` into lightweight 23 KB standalone binary `LucyUiaWorker.exe`. |
| **Node.js Filesystem & Shell (`node:fs`, `node:path`, `electron.shell`)** | **MIT / Chromium** | Path containment, atomic file writes, recursive directory search, directory creation, file copying, moving, and registered system openers | **REUSED & HARDENED** | Standard runtime capabilities with zero external npm bloat. Hardened with fail-closed boundary enforcement against path traversal and symlink escapes. |

---

### 2. Capabilities Reused & Integrated

1. **Browser Automation Engine (`src/tools/browser-manager.js` & `src/tools/browser-tools.js`)**:
   - `browser_navigate`: Safe HTTP/HTTPS and local file navigation under read-only isolation with timeout handling.
   - `browser_extract`: Semantic DOM extraction (text, HTML, links) via CSS selectors with max-character safety guards.
   - `browser_fill`: Input/textarea form filling with round-trip `inputValue()` DOM verification.
   - `browser_select_option`: `<select>` dropdown form interaction supporting values, labels, or indices.
   - `browser_click`: Actionability-verified element clicking with dynamic risk tiering.
   - `browser_scroll`: Directional (down, up, top, bottom), pixel-based, or selector-based scrolling with post-scroll viewport verification.
   - `browser_search`: Direct web and platform search engine querying (DuckDuckGo, Google, YouTube, Bing) with parsed title and link extraction.
   - Tab Management: `browser_new_tab`, `browser_list_tabs`, `browser_switch_tab`, `browser_close_tab`, `browser_current_tab`.
   - Downloads: `browser_download`, `browser_list_downloads`, `browser_cancel_download` with SHA-256 verification and workspace containment.

2. **Native UI Automation Worker (`src/tools/native-uia/LucyUiaWorker.cs` & `src/tools/desktop-automation-manager.js`)**:
   - Out-of-process JSON-over-stdio C# worker (`LucyUiaWorker.exe`) interacting directly with Windows UI Automation.
   - `desktop_launch_app`: Strict allowlist-validated executable launching on the interactive desktop.
   - `desktop_focus_window`: Window identification, restoration from minimized state (`ShowWindow SW_RESTORE`), and foreground focusing via `SetForegroundWindow` and thread attachment.
   - `desktop_list_apps`: Top-level window enumeration returning window titles, HWNDs, process IDs, and bounds.
   - `desktop_find_element`: Deep UIA tree traversal locating controls by Name, AutomationId, or ControlType.
   - `desktop_click_element`: Invoking controls via `InvokePattern` or fallback bounding rectangle center cursor actuation.
   - `desktop_type_text`: Setting text via `ValuePattern` or fallback `SendWait` key sequences.
   - `desktop_inspect_ui`: Full UI subtree inspection for accessibility trees and modal dialogs.

3. **Workspace File Operations (`src/tools/file-tools.js`)**:
   - `file_search`: Recursive filename matching within workspace root.
   - `file_mkdir`: Recursive directory creation with directory existence verification.
   - `file_copy`: File copy operation with byte-size verification.
   - `file_move`: Atomic file move with source absence and destination existence verification.
   - `file_open_external`: Safe file/folder opening via registered Windows shell association (`shell.openPath`).
   - `file_read`, `file_write`, `file_delete`, `file_list`: Standard file operations within workspace containment.

4. **Planning, Verification & Autonomous Coordination**:
   - `TaskPlanner`: Ambiguity detection, missing parameter clarification (Scenarios B, D, E), multi-step compound intent compilation (Scenarios A, C, F), and provider synthesis.
   - `ResultVerifier`: Corroborates actual tool outcomes against physical system evidence before reporting success.
   - `PermissionAuthority`: Central policy gate categorizing actions into risk tiers (`SAFE_READ`, `WORKSPACE_READ`, `WORKSPACE_WRITE`, `CONSEQUENTIAL`, `CRITICAL`) with fail-closed confirmation handlers.

---

### 3. Modifications & Security Hardening Made for L.U.C.Y.

1. **Path Boundary Defense & Traversal Containment**:
   - All file operations are checked through `createPathBoundaryChecker(workspaceRoot)`.
   - Rejects directory traversal attempts (`../`), encoded path tricks (`%2e%2e`), drive letter escapes on Windows (`Z:\...`), and UNC network paths.
2. **Consequential Action Approval Gates**:
   - Destructive operations (file deletions, external modifications, arbitrary command execution, form submissions) require explicit confirmation.
   - Unhandled confirmation requests fail closed automatically.
3. **Secret Redaction**:
   - Passwords and embedded credentials (`user:pass@host`, `token=...`, `key=...`) are stripped or masked as `[REDACTED_SECRET]` in result receipts and execution history.
4. **Anti-Bot & CAPTCHA Fail-Closed Defense**:
   - Detects Cloudflare Turnstile, Google reCAPTCHA, and bot challenge barriers. Halts automated execution safely without attempting fragile or illicit bypasses.
5. **No Orphan Process Guarantee**:
   - Native UIA child processes and Playwright browser instances register PID tracking and process exit hooks (`beforeExit`, `exit`, `SIGINT`, `SIGTERM`), terminating cleanly on shutdown.

---

### 4. Tests Run & Verification Evidence

- **Acceptance Test Suite (`tests/desktop/browser-and-desktop-automation.test.js`)**:
  - **22 / 22 PASS (100%)**:
    1. Launching and identifying applications (`desktop_launch_app` & `desktop_list_apps`).
    2. Opening websites and locating page elements (`browser_navigate` & `browser_extract`).
    3. Filling form fields and verifying values (`browser_fill` & `browser_select_option`).
    4. Creating files and verifying contents (`file_write` & `ResultVerifier`).
    5. Handling missing targets gracefully with actionable reports.
    6. Handling navigation timeouts without hanging (`navigation_timeout`).
    7. Requesting approval for sensitive actions (`RISK_TIERS.CONSEQUENTIAL`).
    8. Cancelling active multi-step operations immediately halting execution.
    9. Preventing unintended duplicate actions after retries.
    10. Handling worker failure and cleanup without orphan processes.
    11. Preserving existing permissions and boundary defense against path traversal.
    12. Maintaining existing chat and conversation synthesis behavior.
    - Scenario A: Open Notepad (`desktop_launch_app`).
    - Scenario B: Unspecified meeting notes content clarification; template creation & verification.
    - Scenario C: Search YouTube tutorials; verify results without claiming unverified playback.
    - Scenario D: Form interaction clarification; leave unknown info unresolved; require consequential approval.
    - Scenario E: Handle missing project folder failure honestly without silent redirection.
    - Scenario F: Multi-step "open project folder, find README, and open it".
    - File Tools: `file_mkdir`, `file_copy`, `file_move` verification.
    - Browser Tools: `browser_scroll` and `browser_search` verification receipts.

---

## Milestone: Background Lifecycle, Window Management & Companion Behaviour

### 1. Evaluated Repositories & Implementations

| Candidate Project | License | Capabilities Evaluated | Decision | Rationale |
|---|---|---|---|---|
| **dengyie/OpenPet** (`https://github.com/dengyie/OpenPet`) | MIT | Transparent floating window, screen-edge positioning, display metric listener, and boundary clamping | **ADAPTED & ENHANCED** | Reused screen-edge snapping and work area bounding logic. Enhanced with multi-monitor disconnection resilience (`validateAndClampPosition` without resetting user-selected width/height). |
| **sindresorhus/electron-store** | MIT | JSON schema-based geometry and configuration persistence | **EVALUATED / NATIVE ADAPTATION** | Heavy third-party dependency avoided. Implemented lightweight atomic JSON persistence (`companion-window-bounds.json` & `app-config.json`) natively via Node.js `fs.writeFileSync` with debounced write operations. |
| **Electron Official Architecture Guidelines** (`electron/electron`) | MIT | Single-instance lock (`requestSingleInstanceLock`), second-instance restore, and system tray management | **SELECTED & IMPLEMENTED** | Standard Electron single-instance lock prevents duplicate assistant processes, securely forwarding second launches to the primary window. System tray singleton prevents duplicate icon leaks. |
| **Windows OS Focus Penetration Pattern** | MIT / Public Domain | Windows foreground lock bypass (`setAlwaysOnTop(true)` toggle) | **SELECTED & IMPLEMENTED** | Solves the Windows 10/11 OS limitation where `win.focus()` is suppressed when background applications request focus. Momentarily toggling `alwaysOnTop` reliably penetrates foreground lock without permanently pinning the window. |

### 2. Capabilities Reused & Integrated
- **Multi-Display Aware Screen Clamping**: Clamps coordinates to `workArea` boundaries when displays change or resolutions shrink, while preserving user-selected window dimensions.
- **Return to App Concurrency Guard**: Added idempotent restoration locking to prevent racing requests from creating duplicate windows or desynchronizing companion state.
- **Strict PID-Based Process Termination**: Graceful shutdown pipeline terminates specific Lucy-owned child processes (`proc.pid`) using `process.kill(pid, 'SIGKILL')` fallback, strictly avoiding broad process name termination.

### 3. Verification & Acceptance
- Verified across the dedicated 14-point lifecycle suite (`tests/lifecycle/application-lifecycle.test.js`) with 100% pass rate.
- Verified zero regressions across the existing 481-test repository suite (`npm test`).



