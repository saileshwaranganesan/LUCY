# L.U.C.Y. - Architecture & Engineering Decision Log

## Record of Decisions (ADRs)

### ADR-001: Evaluation and Adoption Boundary of AILIS Upstream Foundation
- **Date**: 2026-10-13
- **Status**: Implemented / Inspected
- **Context**: The upstream repository `https://github.com/haowenGuo/AILIS` was downloaded, extracted to `reference/AILIS`, and audited in depth across Electron runtime, tool dispatcher, memory store, and test harnesses.
- **Findings**:
  1. **Secret Storage**: Confirmed critical vulnerability in `reference/AILIS/electron/ailis-memory-store.cjs` (line 19: `SECRET_PROTECTION = 'local-file-base64'`, line 562: `encodeSecretValue` using simple `Buffer.from(value).toString('base64')`) and `electron/store.cjs` writing plaintext API keys to `desktop-state.json`.
  2. **Dry-Run Tool Isolation**: Confirmed in `reference/AILIS/electron/ailis-computer-tool.cjs` (`AILISComputerTool.execute`) that destructive write actions (`exec`, `pty_start`, `write`, `delete`) have zero check for `args.dryRun` or `context.dryRun`, allowing real side-effects to execute under dry-run mode.
  3. **Cost & Usage Representation**: Verified in `desktop-llm-provider.cjs` and `ailis-runtime-budget.cjs` where missing provider usage data defaults to undefined/0 rather than strictly flagging metrics as unknown.
  4. **Asset Licensing**: Audited `Resources/VRMA_MotionPack/Readme_VRMA_MotionPack_EN.txt` - copyrighted by pixiv Inc. with specific commercial restrictions and required attribution distinct from AILIS's MIT code license.
  5. **Avatar Model**: Upstream bundles a human anime girl VRoid (`AILIS.vrm`), directly conflicting with L.U.C.Y.'s requirement for a cute fantasy-creature companion.
- **Decision**: Scaffold the L.U.C.Y. core assistant with a modular, clean architecture adopting proven patterns from AILIS (clean tool contracts, portable compaction protocol, Electron IPC bridge) while completely replacing the insecure secret storage, adding central permission enforcement with guaranteed dry-run isolation, and building a lightweight fantasy-creature companion layer.

### ADR-002: Single Authority Architecture & Permission Authority
- **Date**: 2026-10-13
- **Status**: Selected
- **Decision**: Exactly one authoritative Task Coordinator, one Permission Authority, and one Tool Registry. The companion layer is strictly a visual presentation layer that never executes tools or runs an independent AI agent loop.

### ADR-003: Secure Credential Storage via Windows DPAPI / Protected Storage
- **Date**: 2026-10-13
- **Status**: Selected
- **Decision**: Insecure Base64 encoding is replaced by Windows DPAPI (Data Protection API) via PowerShell/C# CryptProtectData / CryptUnprotectData or Node native protected memory, ensuring secrets are encrypted at rest with the current Windows user's master key.

### ADR-004: Guaranteed Dry-Run Interception at Tool Registry Boundary
- **Date**: 2026-10-13
- **Status**: Selected
- **Decision**: Dry-run interception occurs before any tool implementation is called. If `dryRun: true`, the central dispatcher intercepts the call, returns an explicit simulated result with `{ dryRun: true, executed: false }`, ensuring side-effecting code can never run.

### ADR-005: Cost & Usage Unknown Semantics
- **Date**: 2026-10-13
- **Status**: Selected
- **Decision**: If token or cost metadata is not explicitly reported by the upstream provider, cost and token usage are explicitly reported as `{ status: 'unknown' }`, never falsely reported as 0.

### ADR-006: Lightweight Expressive Fantasy-Creature Companion
- **Date**: 2026-10-13
- **Status**: Selected
- **Decision**: Use a Three.js / WebGL-based renderer with support for GLB/glTF and procedural glowing creature shader effects (floating wisp/familiar with animated expressive eyes, ears, wings, aura, and emotional blend states: Happy, Focused, Thinking, Warning, Sleepy). Decouple rendering completely from the Task Coordinator using a unidirectional state event stream.

### ADR-007: Safe Headless/Headful Browser Automation via Microsoft Playwright
- **Date**: 2026-10-13
- **Status**: Implemented & Verified
- **Decision**: Wrap Microsoft Playwright (`playwright@^1.64.0`) inside `BrowserManager` and register 6 standard tools (`browser_navigate`, `browser_extract`, `browser_click`, `browser_fill`, `browser_screenshot`, `browser_close`). Enforce all actions through `ToolRegistry` and `PermissionAuthority`. Enforce fail-closed CAPTCHA detection and mechanical dry-run isolation.

### ADR-008: Five-Category Persistent Memory and Multi-Tier Voice Interaction
- **Date**: 2026-10-13
- **Status**: Implemented & Verified
- **Decision**: Implement persistent memory with BM25 lexical retriever across 5 strictly isolated categories (conversation context, episodic task history, semantic facts, user preferences, procedural routines). Implement multi-tier voice interaction (Web Speech API push-to-talk recognition, native speech synthesis, markdown/URL speech cleaner, instant speech interruption).

### ADR-009: Native Windows Desktop UI Automation Engine & WinSta0 Desktop Routing (Workstream 02)
- **Date**: 2026-10-13
- **Status**: Implemented & Verified
- **Context**: Evaluated upstream candidate `floatingbrij/desktop-pilot-mcp` (WinApp MCP v2.0.0, MIT License). Discovered through empirical probing that WinApp MCP is a 152 MB self-contained .NET 8/10 FlaUI executable that communicates over STDIO MCP JSON-RPC. When run in isolated execution environments (such as sandboxes, background runners, or non-default desktops like `exebox-*`), standard process creation inherits the isolated desktop station where 0 user windows exist, resulting in `No windows found on desktop` errors.
- **Decision**:
  1. Built an in-process, high-performance native Windows UI Automation engine (`src/tools/native-uia/LucyUiaWorker.cs` / `.exe`, 18 KB) compiled via Windows's standard pre-installed `csc.exe` (`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`). Zero external npm or Python dependencies; 100% offline.
  2. Implemented clean early thread desktop switching to `WinSta0\default` before any OLE/UIA initialization, enabling seamless discovery, inspection, and manipulation of live interactive user windows (Notepad, Calculator, File Explorer, Chrome, Electron).
  3. Integrated through `DesktopAutomationManager` and registered 8 core tools in `ToolRegistry` (`desktop_list_apps`, `desktop_launch_app`, `desktop_inspect_ui`, `desktop_find_element`, `desktop_type_text`, `desktop_click_element`, `desktop_take_screenshot`, `desktop_close_app`).
  4. Enforced strict `PermissionAuthority` gates (`SAFE_READ` for inspection/screenshots, `WORKSPACE_WRITE` for allowlisted app launches, `CONSEQUENTIAL` for keystrokes, clicks, and closures) with guaranteed mechanical dry-run isolation and action outcome verification receipts.

### ADR-010: 3D Floating Fantasy Companion Engine & Model Selection (Workstream 03)
- **Date**: 2026-10-13
- **Status**: Implemented & Verified
- **Context**: Evaluated candidates for transforming the docked 2D canvas familiar into a cute, expressive 3D desktop fantasy creature living in a transparent, borderless, always-on-top window:
  1. `haowenGuo/AILIS`: MIT code, but bundles a human anime girl model (`model.vroid`) with pixiv Inc. proprietary motion licenses prohibiting redistribution or extraction. Violates product identity (not a human anime girl, but a cute fantasy pet).
  2. `ARPAHLS/avatar`: MIT code, but designed around humanoid VRM avatars.
  3. `wangeguo/pet`: Apache-2.0, but built with a Rust Bevy engine + Iced GUI stack, requiring an incompatible external compiled binary and heavy dual-process architecture.
- **Decision**:
  1. Reused proven Electron transparent window architecture (`transparent: true`, `frame: false`, `alwaysOnTop: true`, `skipTaskbar: true`) managed via `FloatingCompanionWindow`.
  2. Selected Quaternius's Low-Poly Animated Fantasy Dragon (`dragon.glb`, 324 KB) under Creative Commons Zero v1.0 Universal (CC0 1.0 - Public Domain), ensuring 100% legal safety and complete freedom of redistribution.
  3. Rendered via Three.js (`three@^0.174.0` / WebGL) with `GLTFLoader` and `AnimationMixer` for continuous skeletal `Idle` and flourish animations, procedural levitation bobbing, breathing roll, and 36 orbiting starlight particle motes.
  4. Mood-reactive lighting system casting dynamic point light on scales and wings matching coordinator states (cyan, magenta, amber, violet, lavender, emerald, rose).
  5. Speech-synchronized rhythmic head nods and jaw pulses during speech playback, stopping immediately when speech ends or is cancelled.
  6. Provided resilient 2D canvas familiar fallback (`CelestialFamiliarRenderer`) if WebGL is unavailable or model loading fails.
  7. Ensured zero autonomous companion brain: all requests and state route unidirectionally through `TaskCoordinator` and `PermissionAuthority`.

### ADR-011: Production Packaging via Electron Builder, NSIS Per-User Installation, and Data Retention Policy (Workstream 04)
- **Date**: 2026-10-13
- **Status**: Implemented & Verified
- **Context**: Turning L.U.C.Y. into a standalone Windows desktop application requires producing a standard Windows x64 installer that non-developers can run without pre-installed Node.js, Python, or command-line tools. Key technical constraints:
  1. The native C# Windows UI Automation worker (`LucyUiaWorker.exe`, 18 KB) cannot be executed directly from inside an ASAR archive.
  2. `electron-builder` optimizes package sizes by stripping directories named `examples` / `example`, which prunes Three.js's `examples/jsm` (containing `GLTFLoader.js` and dependencies).
  3. Reinstalling, updating, or repairing the application must never wipe or overwrite user conversation memories, custom preferences, project workspaces, or DPAPI credentials.
  4. Uninstallation should cleanly remove installed program files while strictly respecting user data retention policies (`deleteAppDataOnUninstall: false`).
- **Decision**:
  1. Selected `electron-builder` (`electron-builder@^26.15.3`) as the packaging solution. Configured standard NSIS per-user (`perMachine: false`) installer (`dist-release/L.U.C.Y-Setup-0.1.0-win-x64.exe`, 87.8 MB) and a zero-install portable target (`dist-release/L.U.C.Y-Portable-0.1.0-win-x64.exe`, 87.5 MB).
  2. Enabled ASAR packaging (`asar: true`), while explicitly unpacking `LucyUiaWorker.exe` via `asarUnpack: ["src/tools/native-uia/LucyUiaWorker.exe"]` and bundling as an `extraResource`. Implemented dynamic path resolution in `build-worker.js` and `desktop-automation-manager.js` to inspect `app.asar.unpacked` and `resourcesPath`.
  3. Vendored required Three.js ES modules (`three.module.js`, `three.core.js`, `three.tsl.js`, and `addons/` including `GLTFLoader.js`) into `src/companion/vendor/three/` to make companion 3D rendering 100% resilient against packaging pruners.
  4. Preserved user data and credential protection by strictly separating program binaries (`%LOCALAPPDATA%\Programs\LUCY`) from persistent user data (`%APPDATA%\lucy-desktop-assistant` and `%APPDATA%\LUCY`).
  5. Configured NSIS with `deleteAppDataOnUninstall: false`. Verified via automated tests and live silent uninstaller runs that uninstallation deletes program directories but leaves user memories and DPAPI credentials intact.
  6. Documented code-signing status honestly: installers are built without an EV code-signing certificate and will prompt Windows SmartScreen ("Unknown Publisher"). Documented exact steps for end users to click "More info" -> "Run anyway".

### ADR-012: Reliability, Process Lifecycle & Security Hardening (Workstream 06: SEC-004, SEC-005, SEC-007, SEC-008)
- **Date**: 2026-10-13
- **Status**: Implemented & Verified
- **Context**: The Workstream 05 master audit identified four critical security and reliability defects:
  1. SEC-004: Missing single-instance application locking allowed competing operational processes to corrupt persistent memory and DPAPI stores.
  2. SEC-005: Interactive permission confirmations could wait indefinitely, blocking task coordinator state and leaving hanging timers.
  3. SEC-007: Remote custom OpenAI-compatible endpoints lacked HTTPS enforcement, risking credential transmission over plaintext HTTP.
  4. SEC-008: Renderer-to-main IPC handlers lacked defensive parameter type and size validation before invoking privileged operations.
- **Decision**:
  1. **SEC-004 (Single-Instance Application Lock)**: Acquired Electron's `app.requestSingleInstanceLock()` at the earliest possible entry point in `src/main/index.js` before persistent services initialize. If denied, the secondary process exits cleanly (`app.quit()`). When a second launch attempt occurs, the primary instance receives the `second-instance` event and restores, shows, and focuses `mainWindow`.
  2. **SEC-005 (Permission Confirmation Timeout)**: Added a configurable confirmation timeout (default: 60,000 ms) in `PermissionAuthority`. Fails closed (`permitted: false`, `timedOut: true`) if user does not respond within the timeout. Explicit denials (`timedOut: false`) remain strictly distinct from timeouts. Late responses arriving after timeout are ignored and cannot revive or execute expired requests. All pending confirmations are resolved fail-closed with timers cleared upon application shutdown (`before-quit`) or window closure.
  3. **SEC-007 (HTTPS Enforcement for Remote Endpoints & Loopback Policy)**: Implemented strict URL validation before any network dispatch in `ProviderAdapter`. Remote custom endpoints MUST use HTTPS. Plaintext HTTP is strictly permitted only for loopback addresses (`localhost`, `127.0.0.1`, `::1`, and IPv4 `127.0.0.0/8`). Arbitrary private networks (e.g. `192.168.x.x`, `10.x.x.x`) are classified as remote and rejected if using plaintext HTTP. Embedded credentials (`user:pass@host`) and unsupported protocols are rejected. Secret keys are never leaked in error messages.
  4. **SEC-008 (Centralized IPC Schema & Type Validation)**: Created `src/security/ipc-validator.js` providing defensive schemas for all renderer-to-main IPC endpoints (`lucy:executeRequest`, `lucy:setProviderConfig`, `lucy:clearApiKey`, `lucy:permissionResponse`, `lucy:getMemories`, `lucy:addMemory`, `lucy:updateMemory`, `lucy:deleteMemory`, `lucy:clearMemoryCategory`, `lucy:toggleLongTermMemory`, `lucy:inspectTask`, `lucy:resumeTask`, `lucy:discardTask`, `lucy:sendVoiceState`, `companion:moveWindow`, `companion:submitRequest`). Requests failing validation are rejected before invoking underlying privileged handlers.

### ADR-013: Incremental AI Response Streaming Transport & Lifecycle Integration (REQ-029)
- **Date**: 2026-10-13
- **Status**: Implemented & Verified
- **Context**: Users expect immediate streaming feedback as an AI model generates words, rather than waiting for an entire multi-paragraph response to complete. However, streaming introduces lifecycle risks: partial speech playback, duplicate assistant feed entries, dangling background streams on cancellation, and log leakage of partial sensitive data.
- **Decision**:
  1. Implemented protocol-specific streaming in `ProviderAdapter`: SSE (`:streamGenerateContent?alt=sse`) for Gemini, SSE (`stream: true`) for OpenAI/OpenRouter and Hugging Face router, and NDJSON (`stream: true`) for Ollama.
  2. Preserved non-streaming fallback for providers and environments where `onChunk` is not passed.
  3. Propagated streaming via `lucy:streamChunk` IPC events to the renderer, where progressive DOM updates are throttled via `requestAnimationFrame` to ensure zero feed stutter.
  4. Decoupled voice output: speech playback is triggered strictly upon receipt of the final verified message text. Incomplete chunks are never spoken, and responses are never repeated twice.
  5. Implemented `AbortController` cancellation in `TaskCoordinator` and wired `#cancelStreamBtn`. Cancellation cleanly halts HTTP streams without retries or error loops.

### ADR-014: Local Ollama Model Discovery and Safe Selection Policy (REQ-030)
- **Date**: 2026-10-13
- **Status**: Implemented & Verified
- **Context**: Requiring users to manually type exact local Ollama model names (e.g. `qwen2.5:1.5b`, `llama3.2:3b`) leads to typos and failed requests.
- **Decision**:
  1. Implemented `discoverOllamaModels(endpointUrl)` querying `GET /api/tags`.
  2. Enforced loopback-only validation (`validateEndpointUrl`): discovery requests to remote HTTP endpoints are rejected fail-closed before network dispatch.
  3. Populated discovered installed models in the UI `<datalist id="modelDatalist">` with human-readable size labels.
  4. Enforced strict user-intent and offline guarantees: L.U.C.Y. never downloads or installs unapproved models in the background, and never silently falls back to hosted or paid providers if local Ollama is offline.

### ADR-015: Hugging Face Router Architecture and Rate Limit Handling (REQ-031)
- **Date**: 2026-10-13
- **Status**: Implemented & Verified
- **Context**: Hugging Face recently transitioned its serverless inference infrastructure toward an OpenAI-compatible router endpoint (`https://router.huggingface.co/hf-inference/v1/chat/completions`).
- **Decision**:
  1. Selected Hugging Face's official serverless OpenAI router path, configured with default model `meta-llama/Llama-3.2-3B-Instruct`.
  2. Required explicit user opt-in and stored user access tokens encrypted at rest with Windows DPAPI.
  3. Tokens (`hf_...`) are strictly scrubbed from URLs, logs, errors, and UI badges.
  4. Mapped HTTP 401, 404, 429, and 503 status codes to clear, truthful diagnostic messages, explaining serverless rate limits and model loading cold-starts.

### ADR-016: Model-Aware Context Budgeting and Historical Immutability (REQ-032)
- **Date**: 2026-10-13
- **Status**: Implemented & Verified
- **Context**: Long conversations and tool outputs can exceed model context limits, triggering abrupt API errors. Naive truncation drops recent instructions or system safety rules.
- **Decision**:
  1. Implemented `ContextBudgetManager` with explicit `MODEL_CONTEXT_LIMITS` per model family (Gemini: 1M+, OpenRouter: 128k, Hugging Face: 8k-32k, Ollama: 4k).
  2. Implemented conservative token estimation (1.33 tokens/word + 1 token/symbol) that reliably overestimates rather than underestimates token consumption.
  3. Full context accounting measures system prompts, history, retrieved memories, tool schemas, and active user requests.
  4. Implemented bounded context projection: older messages are compacted into structured continuation memory (preserving goals, user preferences, and tool receipts while redacting secrets). Original historical records in `MemoryStore` remain completely immutable.

### ADR-017: Natural Language Task Decomposition and Defensive Interpretation (REQ-033)
- **Date**: 2026-10-13
- **Status**: Implemented & Verified
- **Context**: Users express intentions in colloquial natural language that can be ambiguous, compound, or adversarial.
- **Decision**:
  1. Compound multi-step requests (e.g. open app + type text, create file + read back) decompose into sequential verified tool steps.
  2. Under-specified requests (e.g. "write file", "delete file", "launch app") trigger concise clarifications rather than hallucinating paths or executing destructive guesses.
  3. Built defensive filters against prompt injection attacks (`PROMPT_INJECTION_PATTERNS`), halting execution fail-closed with security rejection receipts.
### ADR-018: Curated Desktop Application Allowlist & Standard-User Execution (Batch 01)
- **Date**: 2026-10-14
- **Status**: Implemented & Verified
- **Context**: Autonomous desktop execution requires balancing helpful application controls against system integrity.
- **Decision**:
  1. Maintained a strictly curated allowlist of approved desktop executables (`notepad.exe`, `calc.exe`, `mspaint.exe`, `explorer.exe`, `code.cmd`/`Code.exe`, `chrome.exe`, `msedge.exe`).
  2. Denied administrative binaries (`regedit.exe`, `diskpart.exe`, `format.com`, `powershell.exe`, etc.) and strictly enforced execution only in the standard user interactive session.
  3. Integrated friendly natural language application name resolution into `TaskPlanner`.

### ADR-019: Multi-Tab Browser Automation & Secure Downloads (Batches 02 & 03)
- **Date**: 2026-10-14
- **Status**: Implemented & Verified
- **Context**: Browser tasks frequently involve multi-page workflows and file downloads.
- **Decision**:
  1. Implemented complete tab lifecycle management (`browser_new_tab`, `browser_list_tabs`, `browser_switch_tab`, `browser_close_tab`) with robust active tab index tracking.
  2. Implemented secure browser downloads strictly constrained within workspace boundaries via `createPathBoundaryChecker`.
  3. Sanitized filenames against Windows reserved device names (`CON`, `PRN`, `NUL`) and forbidden characters (`<>:"/\|?*`).
  4. Enforced collision-safe renaming (`file (1).ext`) to prevent silent data overwrites, with SHA-256 integrity verification.

### ADR-020: Voice Customization & Push-to-Talk Interruption (Batch 04)
- **Date**: 2026-10-14
- **Status**: Implemented & Verified
- **Context**: Spoken feedback should be customizable without risking privacy or uncontrolled audio playback.
- **Decision**:
  1. Made speech pitch (0.5–1.5, default 1.05) and rate (0.5–1.5, default 1.02) configurable and persisted in `voice-config.json`.
  2. Preserved push-to-talk as the strict default; deferred wake-word detection to prevent unapproved continuous microphone capture.
  3. Enforced instant speech interruption on PTT button press so user voice input is never contaminated by ongoing assistant speech.

### ADR-021: WebAssembly SQLite (`sql.js`), Parity Migration & BM25 Retrieval (Batches 05 & 06)
- **Date**: 2026-10-14
- **Status**: Implemented & Verified
- **Context**: Upgrading from JSON memory to SQLite must avoid native C++ build toolchain failures (e.g. `node-gyp`, Visual Studio build tools) and prevent data loss.
- **Decision**:
  1. Adopted `sql.js` (pure WebAssembly SQLite), eliminating all native compilation requirements and Electron ABI incompatibilities.
  2. Implemented `MemoryMigrator` with timestamped JSON backups (`.bak_<timestamp>`), secret scrubbing, exact 5-category parity verification, and automatic rollback on failure. The legacy JSON store is preserved and never deleted.
  3. Unified memory search using local, offline BM25 lexical ranking with English stemming, phrase boosting, and category diversity penalties across all five memory categories. Deferred neural semantic embeddings to avoid cloud dependencies or model downloads.
  4. Integrated `TaskContinuityStore` with SQLite table `task_checkpoints` for resilient crash recovery.




