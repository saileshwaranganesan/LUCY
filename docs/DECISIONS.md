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

### ADR-022: Persistent Browser Sessions and Profile Lifecycle (DEF-004)
- **Date**: 2026-10-14
- **Status**: Implemented & Verified
- **Context**: College portals and student web applications require persistent authentication across browser restarts so users are not repeatedly forced to log in.
- **Decision**:
  1. Enabled persistent browser profile contexts via `chromium.launchPersistentContext(userDataDir)` targeting `%APPDATA%\lucy-desktop-assistant\browser-profile`.
  2. Preserved ephemeral `browser.newContext()` as the default for tests and lightweight automated tasks.
  3. Provided dynamic mode toggles (`enablePersistence()`, `disablePersistence()`) and tool `browser_session_config`.
  4. Excluded browser profile directories from Git in `.gitignore` to prevent session cookies and tokens from leaking into source control.

### ADR-023: Release Trust, Checksum Manifests & Distribution Verification (DEF-005B)
- **Date**: 2026-10-14
- **Status**: Implemented & Verified
- **Context**: Packaged executables are unsigned without an EV certificate, requiring clear cryptographic provenance and user verification.
- **Decision**:
  1. Implemented `scripts/generate-release-manifest.js` to generate standard `SHA256SUMS.txt` and `release-manifest.json` containing git revision, file byte sizes, and SHA-256 hashes.
  2. Implemented `scripts/verify-release-artifacts.js` (`npm run release:verify`) to verify artifact integrity and detect tampering fail-closed.
  3. Excluded all certificate and private key extensions (`*.pfx`, `*.p12`, `*.key`) in `.gitignore`.

### ADR-024: Screenshot-to-Vision Feedback Loop & Unified Fairy Companion (DEF-003)
- **Date**: 2026-10-14
- **Status**: Implemented & Verified
- **Context**: Models lacked multimodal vision inputs to reason over captured screenshots, and the companion visual design required unification between the sidebar and floating window.
- **Decision**:
  1. Implemented multimodal normalization in `ProviderAdapter` with strict MIME whitelist and 4 MB per-image cap.
  2. Formatted native vision payloads for Gemini (`parts.inlineData`), OpenAI/OpenRouter (`image_url`), Ollama (`images`), and honest unsupported reporting for text-only Hugging Face models.
  3. Created `visual_inspect` tool (`SAFE_READ`) for screen/browser/file reasoning, with strict permission gates enforced on subsequent consequential actions.
  4. Unified the visual companion character: both the main application HUD and the desktop floating window instantiate `CelestialFamiliarRenderer` (the agreed feminine fantasy fairy), resolving the previous runtime discrepancy.

### ADR-025: Floating Fairy UX 2.0, Persistent Background Lifecycle & Performance Optimization
- **Date**: 2026-10-15
- **Status**: Implemented & Verified
- **Context**: The floating companion window was fixed at 320x380 and could not be resized without clipping; floating controls contained redundant wave and sparkle buttons; greeting and chat text overlapped the character's face; closing the main window terminated the floating companion; and idle rendering consumed unnecessary CPU/GPU cycles.
- **Decision**:
  1. **Dynamic Resizing with Bounds Clamping**: Made the floating window user-resizable with strict aspect-ratio and size clamping (`[180x220]` minimum to `[520x600]` maximum). Position and dimensions are persisted to `companion-window-bounds.json` with 400ms debouncing.
  2. **Streamlined 3-Button Control Dock**: Replaced redundant buttons with clean controls: Chat/Talk (`talkBtn`), Pin/Always-On-Top (`pinBtn`), and Full Return to Main App (`returnBtn`). Unwanted wave and sparkle buttons were eliminated.
  3. **Adjacent Side Conversation Panel**: Rendered conversational speech and user interaction in an adjacent non-overlapping glassmorphic side panel, keeping the fairy's face, mouth, and expressive eyes fully visible at all times.
  4. **Adaptive Idle Performance Loop**: Implemented a 3-tier adaptive framerate loop (24 FPS idle, 60 FPS active interaction, 0 FPS when hidden/obscured), reducing background memory to a stable ~159 MB and minimizing CPU usage.
  5. **Persistent Background Operation & Tray Restore**: Configured background mode where closing the main window hides it to the Windows system notification tray (`Tray`), allowing the floating companion to remain alive and interactive on the desktop. The main window can be restored via tray menu, second-instance launch, or the companion Return button. Clean explicit exit shuts down all windows, workers, and background schedulers with zero orphaned processes.
  6. **Expressive Fairy Tricks & Voice Settings**: Added interactive tricks (spin, jump, fly, bounce) and voice settings preview with pitch/rate/volume controls.

### ADR-026: Authoritative Task Continuity, Resumption & Timeout Execution Engine (Workstream 11)
- **Date**: 2026-10-22
- **Status**: Implemented & Verified
- **Context**: An investigation into L.U.C.Y.'s execution engine revealed that task resumption previously bypassed the Single Authority Model by executing tools directly inside `TaskContinuityStore.resumeTask` (`src/memory/task-continuity-store.js`). This bypassed `ResultVerifier`, `TaskStatusManager` state machine transitions, template parameter resolution (`_resolveStepParams`), conditional branching evaluation (`_evaluateCondition`), step timeouts, and bounded failure recovery. Additionally, when a running task was cancelled in `executeRequest`, the catch handler saved a checkpoint that omitted `completedSteps` and defaulted them to `[]`, wiping all prior verified progress.
- **Decision**:
  1. **Enforce Single Authority for Resumption**: Re-routed `TaskContinuityStore.resumeTask` to unconditionally delegate to `TaskCoordinator._resumeTaskInternal(taskId, options)`. All resumed steps now execute through the coordinator's authoritative pipeline (`TaskCoordinator -> ResultVerifier -> TaskRecoveryEngine -> TaskStatusManager -> PermissionAuthority`).
  2. **Prevent Duplicate & Concurrent Task Execution**: Added active task registry check (`this.activeTasks`) and status manager check throwing `DuplicateTaskExecutionError(activeTaskId, attemptedTaskId)` when concurrent execution of the same active task is attempted.
  3. **Cross-Boundary Parameter Resolution & Branching**: Resumed steps resolve prior outputs (e.g. `{{step_1.result.key}}`) against the accumulated list of prior and newly executed steps. Step conditions (`condition: { ref, op, value }`) evaluate prior receipts and handle `onFalse: 'skip' | 'fail'` actions without stalling execution.
  4. **Preserve Checkpoint Data Integrity**: Fixed the catch handlers in both `executeRequest` and `_resumeTaskInternal` to retain `completedSteps` and calculate `hasPriorSuccess = completedSteps.some(s => s.verified)`. When at least one step has succeeded, the task reports `partiallyCompleted: true` with lifecycle state and checkpoint status set to `PARTIALLY_COMPLETED`.
  5. **Bounded Timeout Lifecycle with Transient Recovery**: Linked step-level timeouts (`options.stepTimeoutMs` / `step.timeoutMs`) and overall task timeouts (`options.timeoutMs`) to granular `AbortController` instances. Step timeouts return structured `{ ok: false, error, code: 'ETIMEDOUT', timedOut: true }`, which `TaskRecoveryEngine` classifies as `TRANSIENT` and automatically retries with exponential backoff before failing closed.

### ADR-027: Execution Engine: Timeout, Cancellation & Retry Safety
- **Date**: 2026-10-23
- **Status**: Implemented & Verified
- **Context**: Bounded step timeouts and retries introduced concurrency and duplicate side-effect hazards:
  1. If a tool handler ignores its `AbortSignal` or stalls, the coordinator previously remained blocked awaiting `toolRegistry.execute()`, causing timeouts to delay until the slow handler resolved rather than unblocking promptly.
  2. If an attempt times out or aborts while its underlying asynchronous handler continues executing in the background, launching an immediate retry causes two or more attempts of the same step to run concurrently, leading to race conditions and corrupted resources.
  3. Non-idempotent or consequential operations (e.g., payments, external data mutations) that time out leave the target system in an uncertain state (the side effect may have dispatched or executed before the timeout). Blindly retrying such operations causes duplicate side effects.
  4. Checkpoints previously included failed steps in `completedSteps`, which caused `inspectTaskForResume()` to count failed steps as completed and drop them from the pending resumption list.
  5. Negative, non-numeric (NaN/string), and zero timeout settings were unvalidated, causing Node.js `TimeoutNaNWarning` and converting timeouts to 1ms premature aborts.
- **Decision**:
  1. **Prompt Timeout Unblocking via Promise.race**: In `TaskCoordinator._executeAndVerifyStep`, wrapped tool execution in a prompt `Promise.race` with an immediate timeout resolution. When the step timer fires, the coordinator unblocks at `effectiveTimeout` and records `ETIMEDOUT` without hanging on stubborn handlers.
  2. **Attempt Concurrency Prevention (No Overlapping Retries)**: In `ToolRegistry.execute`, exposed the underlying handler promise and a settlement predicate (`isHandlerSettled`). In `TaskCoordinator`, the recovery loop checks `!activeHandlerSettled()` before launching a retry; if the previous attempt's handler has not settled within a bounded drain window, the coordinator refuses to launch a racing concurrent attempt and fails closed safely.
  3. **Non-Idempotent Timeout Safety & Explicit Uncertainty**: In `TaskRecoveryEngine.canRecover`, retries are strictly prohibited when a consequential or non-idempotent step (`step.isConsequential || step.idempotent === false`) fails due to a timeout. The coordinator tags the receipt and response with `uncertain: true` and an explicit warning indicating the side effect may have executed, preventing automatic duplicate side effects.
  4. **Strict Checkpoint Verification Filtering**: In both `TaskCoordinator` and `TaskContinuityStore.inspectTaskForResume()`, `completedSteps` is strictly filtered to only steps with `verified: true && result.ok !== false`. Unverified or failed steps remain in `pendingSteps` so resumption re-executes only unverified work while preserving verified prior steps.
  5. **Normalized Timeout Parameter Handling**: Implemented defensive numeric normalization: `(Number.isFinite(num) && num > 0) ? Math.floor(num) : 0`. Zero, negative, and invalid string/NaN values are normalized to `0` (no timeout enforced) without throwing warnings or triggering premature 1ms aborts.

### ADR-028: Uncertain Outcome Lifecycle, Automated Reconciliation & Safe Resumption Invariants
- **Date**: 2026-10-23
- **Status**: Implemented & Verified
- **Context**:
  When a consequential or non-idempotent tool operation times out or aborts while mutating an external environment (e.g. desktop UI automation, filesystem writes, external network requests), the real-world outcome is uncertain: the mutation may have completed, partially applied, or failed.
  Prior to this work:
  1. A timed-out consequential step left the task paused or failed, but resuming the task blindly replayed the step, risking duplicate payments, corrupted files, or repeated clicks.
  2. If the tool handler was still running asynchronously in the background when resumption was attempted, resuming would launch a concurrent invocation racing with the lingering handler.
  3. No explicit state machine state modeled tasks waiting for outcome verification (`AWAITING_RECONCILIATION`).
  4. Tools had no standard protocol for querying external system state to verify if a timed-out action actually happened.
  5. Checkpoints and SQLite resumption state did not persist structured `uncertainStep` records or verifiable resolution receipts across restarts.
  6. Stale handlers settling late after explicit resolution or task cancellation could overwrite verified states or resurrect dead tasks.
- **Decision**:
  1. **AWAITING_RECONCILIATION State Invariant**: Added `AWAITING_RECONCILIATION` to `TASK_STATES` in `TaskStatusManager` and `TASK_STATUSES` in `TaskContinuityStore`. When a consequential non-idempotent step times out or fails with an uncertain outcome, the coordinator constructs a structured `uncertainStep` descriptor (sanitizing credentials and secret parameters) and transitions the task to `AWAITING_RECONCILIATION`.
  2. **Fail-Closed Resumption Gate**: Both `TaskCoordinator._resumeTaskInternal` and `TaskContinuityStore.resumeTask` inspect the task for unresolved uncertain steps. If `uncertainStep && !uncertainStep.resolved`, automatic replay is strictly blocked fail-closed, returning `uncertain_outcome_blocked` or throwing `UncertainOutcomeError`.
  3. **Active Handler Concurrency Drain**: The coordinator tracks active handler promises in `activeHandlers`. If resumption is attempted while a background handler is still running, the coordinator rejects with `still_running_blocked`, preventing duplicate concurrent execution.
  4. **Tool Reconciliation Protocol**: Extended `ToolRegistry` with `reconcile(toolId, params, context)` and `supportsReconciliation`. When resuming, the coordinator automatically invokes the tool's reconciliation routine if available. If reconciliation confirms success (`reconciled: true, confirmedState: 'success'`), the step is marked verified without replay; if it confirms failure with no side effects (`confirmedState: 'failed_no_side_effect'`), safe replay is permitted.
  5. **Explicit Verifiable Resolution with Concurrency Locks**: Implemented `resolveUncertainStep(taskId, payload, options)` requiring explicit outcome (`assumed_success` or `safe_to_retry`), justification, evidence, and caller authorization via `PermissionAuthority`. Concurrent resolution attempts are serialized with `resolutionLocks` and reject conflicts with `CONCURRENCY_CONFLICT`.
  6. **Stale Late Settlement Isolation**: Implemented `_handleLateSettlement(taskId, stepId, attempt, outcome)` to drop late results on resolved, cancelled, or terminal tasks with structured audit logs, preventing stale promises from corrupting checkpoint state.
  7. **Full Persistence Across Process Restarts**: `TaskContinuityStore` persists `uncertainStep` and `resolutions` across both JSON (`task-checkpoints.json`) and SQLite `task_checkpoints` resumption state. Rehydration across process restart preserves all uncertainty and prevents unauthorized replay.
  8. **Reconciliation Trust Boundary & Status Whitelist**: `ToolRegistry.reconcile()` enforces a strict status whitelist (`confirmed_success`, `confirmed_failure`, `indeterminate`), rejecting arbitrary/unknown statuses fail-closed. On `confirmed_failure`, `canReplay: true` is strictly permitted only when explicit verification proves that no side effect occurred (`sideEffectOccurred: false`).
  9. **Authorization Context & Human Attestation Boundary**: In `resolveUncertainStep`, caller permissions are strictly evaluated using the coordinator's authoritative `PermissionAuthority` (blocking bypasses via caller-injected authorities). Meaningless/empty evidence is rejected, and embedded secrets (`sk-...`, `Bearer ...`, `AIza...`, `ghp_...`) are redacted before checkpoint persistence. Because external systems cannot independently verify human-supplied claims, manual resolution is classified as an explicitly authorized human attestation with audit logging—not cryptographic proof.
  10. **JSON/SQLite Crash Consistency & Stale Write Guards**: `TaskContinuityStore` load/sync enforces fail-closed reconciliation: if either store contains an unresolved uncertain step (`awaiting_reconciliation`), that unresolved state is preserved upon startup. `saveCheckpoint` guards against stale writes regressing resolved steps or dropping verified completed steps.
  11. **Concurrency Locks & Terminal State Protection**: `resolutionLocks` are acquired synchronously before any asynchronous authorization dispatch, eliminating race windows between concurrent resolution calls. `activeTasks` reservations are held immediately at resume entry, preventing concurrent resumes across disparate entry points. `cancelTask` marks checkpoints as cancelled across all states, and in-flight reconciliations respect cancellation without resurrecting cancelled tasks.

### ADR-029: Adaptive Replanning & Context-Aware Fallback Tool Routing
- **Date**: 2026-10-23
- **Status**: Implemented & Verified
- **Context**:
  When a tool fails in an active task, previous behavior either unconditionally halted execution as a terminal failure or performed simple identical-parameter retries. This lacked resilience when alternative tools existed that could satisfy the step's requirements. Conversely, naive fallback routing risks critical safety violations:
  1. Routing an authorization failure to a less restricted tool to bypass permissions.
  2. Executing an alternative tool when a previous consequential attempt timed out with an uncertain outcome, causing duplicate external side effects.
  3. Substituting incompatible operations (e.g., attempting a file read when a file write failed).
  4. Passing incompatible parameters to candidates without validated transformation.
  5. Selecting candidates that cannot satisfy the output contract expected by downstream dependent steps.
  6. Re-executing already verified steps or re-evaluating tools declared in other steps of the DAG.
  7. Infinite replanning loops or unbounded budget consumption.
- **Decision**:
  1. **Granular Failure Classification**: In `TaskRecoveryEngine`, extended `classifyFailure` to distinguish 8 explicit failure modes: `TOOL_UNAVAILABLE`, `PROVIDER_OUTAGE`, `TIMEOUT_CONFIRMED`, `TIMEOUT_UNCERTAIN`, `INCOMPATIBLE_PARAMS`, `PERMISSION_DENIED`, `OUTPUT_INVALID`, and `PERMANENT_UNRECOVERABLE`. `canRecover` and `isEligibleForReplanning` strictly fence off unrecoverable and safety-critical failures (uncertain outcomes, permission denials, cancellations, and fatal errors return `replanEligible: false`).
  2. **Deterministic Fallback Routing Engine**: Implemented `ToolRegistry.findFallbackCandidates(options)` evaluating 7 mandatory criteria:
     - Operation compatibility (`_inferOperation` distinguishes read, write, delete, list, stat, search, mkdir, copy, move, launch, interact, navigate).
     - Capability compatibility: candidates must satisfy explicit required capabilities; generic `'general'` category tools cannot match without explicit shared capability tags.
     - Input schema validation via JSON schema validator and optional `parameterAdapter`.
     - Output contract validation against `requiredOutputs` extracted from downstream template parameter references (`{{step_X.result...}}`).
     - Platform and environment availability check (`checkAvailability`).
     - Independent `PermissionAuthority.evaluate()` boundary: fallback tools cannot elevate privilege or bypass security.
     - Exclusion of already-failed candidates, prior verified step tools (`completedStepTools`), and other DAG steps (`planStepTools`).
  3. **Bounded Adaptive Replanning**: Implemented `TaskCoordinator._attemptAdaptiveReplanning` and integrated it into both initial step execution (`executeRequest`) and resumption (`_resumeTaskInternal`). Enforces a configurable replan budget (`maxReplans`, defaulting to 2). Revised plan steps preserve original step IDs to keep downstream dependencies intact, and the revised DAG is validated through `_validatePlanDAG` before any revised step executes.
  4. **Preservation of Verified Progress & Uncertainty Boundaries**:
     - Verified steps and receipts are strictly preserved and never re-executed.
     - Downstream prerequisite checks and parameter template resolution prioritize verified step executions even when earlier failed attempts precede them in `executedSteps`.
     - `AWAITING_RECONCILIATION` remains a strict safety boundary: replanning and fallback routing are prohibited when a consequential step has an unresolved uncertain outcome.
     - Consequential fallback tools require explicit user approval (`onConfirmStep`).
  5. **Structured Audit Receipts & Durable Persistence**:
     - `recoveryEngine.createReplanReceipt` records structured audit entries (failed tool, classification, candidates considered, rejected reasons, selected fallback, remaining budget) without secret leakage.
     - Checkpoint persistence in `TaskContinuityStore` persists `replanHistory` and revised plan steps across both JSON and SQLite stores, preserving replanning state across process restarts.

### ADR-030: Desktop UIA Intent Verification, Dynamic Anchor Recovery & Postcondition Verification
- **Date**: 2026-10-24
- **Status**: Implemented & Verified
- **Context**:
  Previous desktop automation suffered from vulnerabilities and reliability gaps:
  1. Target element identification relied on naive single-shot searches, either selecting the first matching control when duplicates existed (silently clicking the wrong control) or failing on transient layout changes and virtualized controls.
  2. Bounding rectangles were assumed static, leading to clicks at stale coordinates if windows moved or resized.
  3. Actions were executed on disabled or incompatible controls (e.g. attempting to type into a static text label or invoke a non-actionable control).
  4. Successful native UIA method calls (e.g. `Invoke()` or `SetValue()`) were assumed to mean action success without verifying observable state postconditions.
  5. Password and secret text was passed and logged in plaintext.
  6. Stale or missing native worker binaries were not proactively checked for PE header integrity or architecture compatibility.
- **Decision**:
  1. **Deterministic 5-Level Target Resolution Pipeline**:
     - Strict PID and top-level window boundary enforcement; candidates belonging to external processes or outside window bounds are discarded.
     - **Level 1**: Exact `AutomationId` match within the target window.
     - **Level 2**: Semantic match by `ControlType`, `Name` (supporting localized UTF-8 names), and `ClassName`. Ambiguous matches (>1) fail closed with `AMBIGUOUS_TARGET`.
     - **Level 3**: Parent/Ancestor structural scoping.
     - **Level 4**: Constrained visual bounding rectangle verification with fresh live coordinates.
     - **Level 5**: Explicit structured failure.
  2. **Safe Dynamic Anchor Recovery**:
     - Revalidates the target window and re-scans live UIA elements with bounded exponential backoff (2 retries, 150ms backoff).
     - Unique matches are accepted as `dynamic_anchor_recovered` with structured audit receipts.
     - Target resolution and action authorization remain separate steps; successful re-identification never auto-executes an action.
  3. **Action-Specific Safety & Compatibility Gates**:
     - Verifies control type and pattern compatibility (`click` requires actionable patterns/types; `type_text` requires editable patterns/types).
     - Checks `IsEnabled == false` and fails closed with `ELEMENT_DISABLED`.
     - Strictly redacts inputs marked with `isSecret: true` in IPC messages, receipts, and diagnostics (`[REDACTED]`).
  4. **Observable Postcondition Verification & Inconclusive Routing**:
     - Toggle pattern: verifies `ToggleState` change.
     - Selection pattern: verifies `IsSelected` is true.
     - Text entry: reads back live value via `ValuePattern` and asserts equality.
     - Window/dialog close: verifies target process or window has exited.
     - Unobservable controls return `postconditionStatus: 'UNVERIFIABLE'`, which `ResultVerifier` maps to `INCONCLUSIVE` (preserving `AWAITING_RECONCILIATION` on consequential actions and prohibiting blind retries).
  5. **Worker PE Integrity & Architecture Verification**:
     - `verifyWorkerBinary` inspects binary existence, non-virtual ASAR path, file length, DOS `MZ` header, PE signature, architecture (`0x8664` x64, `0x014c` x86, `0xaa64` arm64), freshness vs source, and SHA-256 hash.

### ADR-031: Adversarial Hardening of UIA Target Resolution, Coordinate Safety, and Secret Sanitization Gates
- **Date**: 2026-10-24
- **Status**: Accepted, Implemented & Verified
- **Context**:
  A source-level adversarial audit of the Desktop UIA Intent Verification milestone revealed several critical edge-case vulnerabilities:
  1. *Target Substitution Risk*: In `LucyUiaWorker.cs`, if an exact `AutomationId` query failed to match in Level 1, resolution fell through to Level 2 (Name matching), risking silent invocation of an unintended control with the same label. Furthermore, Level 3 parent container resolution used `FindFirst`, introducing arbitrary first-match bias when duplicate containers existed.
  2. *Coordinate & Bounds Validation Gaps*: Bounds checks allowed `Rect.Empty` to bypass candidate filtering; zero-sized, non-finite (NaN/Infinity), and out-of-bounds geometries were not rejected prior to physical mouse event fallback.
  3. *Pre-Execution State Desynchronization*: Target window handle and element state were not re-validated immediately before state-mutating actions, allowing operations against substituted windows or disabled controls.
  4. *False Success in Postconditions*: In `type_text`, a catch block on readback defaulted to `readVal = textToType`, falsely verifying controls whose values could not be read. In `click_element`, `InvokePattern` on close buttons that failed to close windows and generic button clicks unconditionally returned `postconditionStatus: VERIFIED`.
  5. *Secret Leakage via Untrusted Hints*: Treating `isSecret` as an untrusted hint was not fully implemented; omitting `isSecret: true` on password fields resulted in raw credentials echoing in exception messages, receipts, coordinator condition evaluations, and persistent checkpoints.
  6. *Consequential Uncertainty Retries*: Inconclusive outcomes (`UNVERIFIABLE`) on consequential actions were treated as retryable verification failures rather than halting for human reconciliation.
- **Decision**:
  1. **Strict Target Resolution & Ambiguity Prevention**:
     - Level 1 target resolution checks for duplicate `AutomationId` values across the target window and fails closed (`AMBIGUOUS_TARGET`) if multiple are found.
     - When `query.AutomationId` is present, the pipeline strictly halts if Level 1 fails, forbidding silent fall-through to Name matching.
     - Level 3 parent container resolution evaluates all matches via `FindAll` and fails closed on ambiguity.
  2. **Geometry Validation & Pre-Execution Revalidation**:
     - `FilterCandidates` and coordinate dispatch reject `Rect.Empty`, NaN/Infinity coordinates, non-positive dimensions, complete out-of-window elements, and rogue overlays exceeding 16x window area.
     - Prior to invoking or typing, `LucyUiaWorker` re-checks `IsWindow(hwnd)`, validates window PID against expected PID, and checks `clickTarget.Current.IsEnabled` and `IsReadOnly`.
  3. **Truthful Postcondition Verification**:
     - `InvokePattern`, `BM_CLICK`, and physical mouse clicks on general buttons return `postconditionStatus: UNVERIFIABLE`, which `ResultVerifier` maps to `INCONCLUSIVE`.
     - Close button invocations inspect target window closure: closed -> `VERIFIED`, still open -> `FAILED`.
     - `type_text` never fabricates readback values; if readback fails, postcondition is reported as `UNVERIFIABLE`.
  4. **Multi-Layer Secret Classification & Redaction**:
     - Automatic classification via UIA `IsPasswordProperty` and keyword heuristics (`password`, `passwd`, `pwd`, `pin`, `secret`, `credential`, `token`, `auth`).
     - Redacts sensitive text from readback (`[REDACTED]`), thrown exception messages, audit receipts, coordinator condition values, and `TaskContinuityStore` persistent checkpoints across JSON and SQLite.
  5. **Consequential Uncertainty Halts for Reconciliation**:
     - In `TaskRecoveryEngine.classifyFailure`, inconclusive outcomes on consequential steps are classified as `TIMEOUT_UNCERTAIN` (`AWAIT_RECONCILIATION`) with `recoverable: false` and `replanEligible: false`, strictly preventing blind retries and unsafe downstream DAG result propagation.

### ADR-032: Release Integrity Gate, Native Worker Identity, and Packaged Runtime Verification
- **Date**: 2026-10-24
- **Status**: Accepted, Implemented & Verified
- **Context**:
  Following the adversarial UIA safety gate, a comprehensive release audit was required to eliminate stale packaging artifacts, prove binary identity, and verify the packaged application runtime:
  1. *Stale Release Binaries*: The existing `dist-release/win-unpacked` contained an outdated worker executable (built October 22, 2026, 68,096 bytes) with an obsolete hash that did not reflect recent safety gate repairs.
  2. *Secret Redaction Over-Scrubbing*: The regex-based sanitization in `TaskContinuityStore` and `TaskCoordinator` indiscriminately redacted non-sensitive identifiers (SHA-256 hashes, Git commit hashes, UUIDs) matching 32+ character alphanumerics into `[REDACTED]`.
  3. *Inverted Postcondition in Native Worker*: In `LucyUiaWorker.cs`, `type_text` evaluated `verified: verifiedMatch || !readSuccess`, falsely reporting verification success when control readback was unobservable. Foreground input fallback also falsely declared verified postconditions without observable state changes.
  4. *IPC Structured Clone Serialization Failure*: Attaching internal lifecycle promises (`handlerPromise`) and functions (`isHandlerSettled`) to tool execution results caused Electron's IPC structured clone algorithm to fail when returning `executeRequest` receipts to the renderer.
- **Decision**:
  1. **Strict Worker Identity Verification & Rebuild**:
     - Forced fresh compilation of `src/tools/native-uia/LucyUiaWorker.exe` using CSC.exe with WPF assemblies.
     - Confirmed PE architecture (`x86`, 94,720 bytes) and SHA-256 hash.
     - Verified exact 1-to-1 SHA-256 hash equality between source executable and packaged destinations (`dist-release/win-unpacked/resources/native-uia/LucyUiaWorker.exe` and `dist-release/win-unpacked/resources/app.asar.unpacked/...`).
  2. **Non-Destructive Secret Sanitization & Sensitive Context Propagation**:
     - Removed blind length-32 redaction; added an explicit non-secret identifier whitelist (`sha`, `sha256`, `commit`, `id`, `uuid`, `path`, etc.) to protect ordinary cryptographic and system metadata.
     - Propagated `parentIsSensitive` across nested objects and arrays so password-field contexts redact nested `text` and `readText` properties without corrupting non-sensitive metadata.
  3. **Truthful Worker Postconditions**:
     - Fixed `type_text` in `LucyUiaWorker.cs` to set `verified: verifiedMatch`. If readback fails, it returns `verified: false` and `postconditionStatus: UNVERIFIABLE`.
     - In `ForegroundInputFallback`, set `verified: false` and `postconditionStatus: UNVERIFIABLE` with truthful detail indicating external outcome is unobservable via UIA.
  4. **IPC Structured Clone Cleanliness**:
     - Stripped internal lifecycle hooks (`isHandlerSettled`, `handlerPromise`) from tool execution receipts in `TaskCoordinator`.
     - Sanitized `executeRequest` IPC responses in `src/main/index.js` to ensure clean structured cloning across process boundaries.
  5. **Packaged Runtime Verification**:
     - Automated CDP smoke test verified all 12 operational scenarios on the packaged binary in an isolated sandbox, including live execution of `LucyUiaWorker.exe` for application listing.

### ADR-033: Phase 3 Verified End-to-End Desktop Workflows, Unverified Output Gating, and Privacy-Preserving Execution Observability
- **Date**: 2026-10-24
- **Status**: Accepted, Implemented & Verified
- **Context**:
  To complete Phase 3 "Verified End-to-End Computer Control & Desktop Workflow Execution", L.U.C.Y. required advancing from isolated automation tools to reliable, multi-step desktop workflows that execute, observe, verify, and safely recover:
  1. *Non-Mutating Readiness Inspection*: Users need to check if an application (e.g. Notepad) is active and ready for input without injecting speculative keystrokes or mutating application state.
  2. *Truthful Readback & Unobservable Outcomes*: Workflows entering text must verify presence via UIA readback (`ValuePattern` / `TextPattern`). When an application does not expose readable text patterns, the system must report `INCONCLUSIVE` truthfully without fabricating success.
  3. *Unverified Dependency Gating*: Downstream steps referencing outputs of prerequisite steps (e.g. `{{step_1.appId}}`) could previously attempt execution even if the prerequisite failed verification or produced unverified output.
  4. *Structured Audit & Privacy Boundary*: Users and developers need a structured audit record (`getWorkflowExecutionRecord`) detailing requested outcomes, planned steps, target identity, action attempts, verified postconditions, recovery receipts, and remaining limitations. However, execution records must never leak credentials (`sk-...`, `ghp_...`, passwords) and must not bloat logs with multi-megabyte base64 screenshot strings.
- **Decision**:
  1. **Non-Mutating Control Readiness Tool (`desktop_inspect_control`)**:
     - Added `desktop_inspect_control` to `DesktopAutomationManager`, `desktop-app-tools.js`, and `automation-tier-policy.js` (Tier 3 read-only).
     - Inspects top-level window responsiveness and locates target controls without state mutation.
     - Verified by `ResultVerifier` (`desktop_control_readiness_check`), returning `VERIFIED` on ready/found and `FAILED` when no compatible control is ready.
  2. **Three Reference Desktop Workflows in TaskPlanner**:
     - *Workflow A (Open & Inspect)*: "Open Notepad and tell me whether it is ready for me to type." Decomposes into `desktop_launch_app` followed by `desktop_inspect_control`.
     - *Workflow B (Enter & Verify Harmless Text)*: "Open Notepad, type `LUCY workflow test 123`, and verify that the text is present." Binds to launched PID/appId, types text, reads back value, and reports `INCONCLUSIVE` truthfully if readback is unobservable.
     - *Workflow C (Multi-step DAG Execution with Recovery)*: "Open Notepad, enter a test line, verify it, then summarize the result." Multi-step DAG with explicit topological dependencies, disk checkpointing, bounded recovery on transient busy failures, and prevention of blind retries on uncertainty.
  3. **Unverified Dependency Gating in TaskCoordinator**:
     - In `_resolveStepParams`, dynamically evaluated references (`{{step_N.output}}`) verify that `step_N` completed with `verified === true`. If unverified, execution throws fail-closed (`Prerequisite step '${stepKey}' failed verification or produced unverified output; cannot satisfy dependency`).
  4. **Privacy-Preserving Structured Execution Record (`getWorkflowExecutionRecord`)**:
     - Built `getWorkflowExecutionRecord(taskOrId)` on `TaskCoordinator` returning structured audit records (`taskId`, `requestedOutcome`, `plannedSteps`, `targetApp`, `actionAttempts`, `verifiedPostconditions`, `recoveryDecisions`, `uncertainOutcomes`, `finalStatus`, `remainingLimitations`, `summary`).
     - Added `scrubRecord` redacting API keys and sensitive credentials, and replacing bulky base64 screenshot/image strings (> 256 chars) with `[SCREENSHOT_BASE64_OMITTED]`.
     - Attached `workflowRecord` to all `executeRequest` execution outcomes.
### ADR-034: Phase 4 Context-Aware Dynamic Tool Execution, Grounded Answer Synthesis & Goal-Driven Intelligence
- **Date**: 2026-10-24
- **Status**: Accepted, Implemented & Verified
- **Context**:
  To complete Phase 4 "Context-Aware Intelligence, Dynamic Tool Use & Goal-Driven Execution", L.U.C.Y. required advancing beyond basic static tool dispatch to dynamic, context-aware reasoning:
  1. *Request Understanding & Intent Classification*: Distinguishing direct informational answers (`DIRECT_ANSWER`) from single-tool operations (`TOOL_ACTION`), compound multi-step tasks (`COMPOUND_WORKFLOW`), missing-parameter inquiries (`CLARIFICATION`), consequential operations requiring confirmation (`CONSEQUENTIAL_APPROVAL`), and unsupported domain requests (`UNSUPPORTED`).
  2. *Dynamic Capability-Based Tool Discovery*: Decoupling hardcoded tool identifiers by querying semantic capability tags, schema introspection, pre-validating parameters before dispatch, and respecting permission authority constraints.
  3. *Grounded Synthesis via Verified Execution Receipts*: Closing the loop between tool execution and conversational interaction by returning verified tool outputs back into model reasoning (or deterministic fallbacks) so final answers are truthful and grounded.
  4. *Bounded Execution & Consequential Reconciliation*: Enforcing bounded loops and differentiating idempotent transient retries from non-idempotent consequential timeouts (`AWAITING_RECONCILIATION`), blocking blind automated retries when in-flight side effects are uncertain.
  5. *Privacy-Preserving Context & Memory Boundary*: Redacting secret credentials, omitting bulky base64 data from prompts, and partitioning authoritative user facts from non-authoritative inferences.
- **Decision**:
  1. **Structured Intent Classifier (`TaskPlanner.classifyIntent`)**:
     - Introduced `INTENT_TYPES` (`DIRECT_ANSWER`, `TOOL_ACTION`, `COMPOUND_WORKFLOW`, `CLARIFICATION`, `CONSEQUENTIAL_APPROVAL`, `UNSUPPORTED`, `SECURITY_VIOLATION`).
     - Refined `_isInformationalQuery()` to exclude system metrics and file targets so operational queries route to tool actions.
  2. **Dynamic Tool Capability Matching (`ToolRegistry`)**:
     - Implemented `findToolsByCapability(requiredCapabilities, options)` and `selectToolForCapability(capability, params, options)`.
     - Added capability tags (`system_inspection`, `system_status`, `host_info`) and output contracts (`system_status` providing `platform`, `arch`, `memory`, `uptimeHours`, `nodeVersion`) to `system_info`.
     - Validates tool parameter schemas prior to permission checking and execution.
  3. **Grounded Natural Language Answer Synthesis (`TaskCoordinator`)**:
     - Feeding actual tool execution receipts to active provider adapters for factual natural language synthesis.
     - Providing deterministic offline synthesis formatted with completion receipts when providers are unavailable.
  4. **Consequential Uncertainty Defense & Transient Recovery**:
     - In `_executeAndVerifyStep`, inspects registered tool risk tiers to ensure non-idempotent consequential tools that encounter in-flight timeouts transition to `AWAITING_RECONCILIATION`.
     - In `ToolRegistry.execute`, propagates `code: err.code` and expanded transient matchers (`socket reset`, `econnreset`) to allow accurate bounded retries for transient failures.
  5. **Privacy-Preserving Context Pipeline**:
     - Sanitizes credentials (`sk-`, `ghp_`, tokens, passwords) and normalizes `[REDACTED_SECRET]` to `[REDACTED]`.
     - Filters out base64 screenshots from LLM context injection.
     - Partitions retrieved context into authoritative user-provided facts vs non-authoritative inferred assumptions.
- **Verification**:
  - Phase 4 automated test suite: `node --test tests/core/context-aware-intelligence.test.js` (15/15 passed).
  - Full test suite: `node --test --test-concurrency=1 tests/**/*.test.js` (1032 passed, 0 failed, 10 skipped).
  - Unit test suite: `npm run test:unit` (222 passed, 0 failed).
  - Security test suite: `npm run test:security` (66 passed, 0 failed).
  - Integration flow suite: `npm run test:flow` (23 passed, 0 failed).
  - Desktop suite: `npm run test:desktop` (163 passed, 0 failed, 10 skipped).
  - Packaging suite: `npm run test:packaging` (32 passed, 0 failed).
  - Packaged runtime smoke test: `npm run smoke:packaged` (13/13 passed).

### ADR-035: Phase 5 End-to-End Voice Interaction, Speech State Synchronization & Voice-Driven Task Execution Architecture
- **Date**: 2026-10-24
- **Status**: Accepted, Implemented & Verified
- **Context**:
  To complete Phase 5 "Reliable Voice Interaction & End-to-End Voice-Driven Task Execution", L.U.C.Y. required establishing an integrated, production-ready speech pipeline connecting microphone capture to the autonomous intelligence core and returning concise, grounded spoken responses:
  1. *Push-to-Talk (PTT) Reliability & Clean Sessions*: Spoken input requires explicit activation/deactivation without ambient runaway loops, duplicate recording sessions, or silent cloud transmissions.
  2. *Single Authority Pipeline & Grounded Outcomes*: Voice input cannot bypass `TaskCoordinator` or run unmediated tools. Transcripts must be understood by `TaskPlanner`, executed via `ToolRegistry` and `PermissionAuthority`, verified by `ResultVerifier`, and converted to grounded spoken responses via TTS.
  3. *Empty Audio, Silence & Unintelligible Feedback*: Empty audio buffers and whisper acoustic silence tokens (`[BLANK_AUDIO]`, `[inaudible]`, dots) previously threw false offline failure errors or executed empty requests. The system must provide polite verbal/visual clarification feedback ("I didn't catch that. Could you please repeat?") and return to IDLE without fabricating success.
  4. *Defense in Depth & Consequential Boundaries*: Sensitive tokens (API keys `sk-`, `ghp_`, `Bearer`, `AIza`, passwords, and `[REDACTED]` markers) must never be pronounced aloud into physical environments. Voice commands cannot bypass consequential permission gates; high-risk actions halt for explicit user confirmation.
  5. *Full Lifecycle State Synchronization*: Voice states (`idle`, `listening`, `transcribing`, `understanding`, `awaiting_confirmation`, `executing`, `speaking`, `cancelled`, `error`) must remain synchronized across the Electron main process, main renderer (`app.js`), and 3D companion renderer (`companion-app.js`).
- **Decision**:
  1. **Spoken Credential Sanitization (`src/voice/speech-text-cleaner.js`)**:
     - Introduced `SECRET_TOKEN_PATTERNS` in `cleanTextForSpeech` scrubbing sensitive API tokens, bearer authorization headers, passwords, and redaction markers before TTS synthesis.
  2. **Push-to-Talk Lifecycle & Silence Handling (`src/voice/voice-controller.js`)**:
     - Added full voice lifecycle states (`TRANSCRIBING`, `UNDERSTANDING`, `AWAITING_CONFIRMATION`, `EXECUTING`, `CANCELLED`) with backward-compatible `PROCESSING` alias.
     - In `stopListening()`, empty audio buffers and silence tokens return clean empty transcripts and return to `IDLE` without throwing false transcription errors.
     - Sanitized Web Speech interim/final tokens to prevent bracketed filler words from polluting transcripts.
  3. **IPC Boundary & Companion Synchronization (`src/security/ipc-validator.js`, `src/companion/companion-app.js`, `src/ui/app.js`)**:
     - Expanded `ALLOWED_VOICE_STATES` to include `transcribing`, `understanding`, `awaiting_confirmation`, `executing`, and `cancelled`.
     - Normalizes voice event payloads across `{ voiceState }` and `{ state }` structures.
     - Companion renderer handles all 9 states while preserving hover-collapse and fairy animation invariants.
     - Main UI provides immediate clarification feedback on empty transcripts and forwards intelligence states during task planning and execution.
  4. **Interruption, Barge-In & Cancellation Support**:
     - Push-to-talk activation or explicit stop triggers instant cancellation of active speech playback, resets synthesis workers, and aborts pending speech queues.
     - In-flight task cancellation halts unstarted steps, releases microphone resources, and returns pipeline to `IDLE`.
- **Verification**:
  - Phase 5 focused test suite: `node --test tests/voice/voice-pipeline-execution.test.js` (13/13 passed).
  - All voice test suites: `node --test --test-concurrency=1 tests/voice/*.test.js` (153/153 passed).
  - Companion test suite: `node --test --test-concurrency=1 tests/companion/*.test.js` (134/134 passed).
  - Security test suite: `npm run test:security` (66/66 passed).
  - Unit test suite: `npm run test:unit` (222/222 passed).
  - Integration flow suite: `npm run test:flow` (23/23 passed).
  - Desktop automation suite: `npm run test:desktop` (163/163 passed, 10 skipped interactive).
  - Packaging test suite: `npm run test:packaging` (32/32 passed).
  - Full repository suite: `node --test --test-concurrency=1 tests/**/*.test.js` (1045 passed, 0 failed, 10 skipped).

### ADR-036: Phase 6 Authoritative Long-Term Memory, Task Continuity & Reliable Resumption
- **Date**: 2026-10-24
- **Status**: Accepted, Implemented & Verified
- **Context**:
  To complete Phase 6 "Persistent Memory, Task Continuity & Reliable Recovery", L.U.C.Y. required bulletproof long-term memory and uninterrupted task execution across conversations, application restarts, and recoverable system failures:
  1. *Provenance Separation & Restart Durability*: Explicit user facts, inferred preferences, and conversational history must be partitioned into strict categories (`user_approved`, `working_data`, `conversation`, `task_continuity`, `project`) and persist reliably across full application restart without conflating inferences with approved facts.
  2. *Exact-ID Deletion Safety*: Deletion must target unique memory record IDs (`mem_*`). Deletion by key must never accidentally wipe unrelated records sharing empty or identical keys (such as raw conversation records).
  3. *Active Negative Constraints*: Users can mandate explicit negative constraints (e.g. "Do not remember my credit cards" or "Do not remember passwords"). The system must record a `MEMORY_TYPES.USER_INSTRUCTION` negative constraint and enforce it across all future memory storage operations fail-closed.
  4. *Truthful Startup Task State*: On restart, lingering `in_progress` tasks must not be presented as currently active. They must be swept into `TASK_STATUSES.INTERRUPTED` (or `AWAITING_RECONCILIATION`) and synchronized to SQLite.
  5. *Safe Resumption Without Side-Effect Replay*: Interrupted tasks must resume execution from the pending step, strictly guaranteeing that completed and verified steps are never re-executed.
  6. *In-Flight Cancellation Defense*: Cancelling a running task halts subsequent steps immediately and drops late-arriving results from detached handlers, preventing corruption of terminal `CANCELLED` state.
  7. *Corruption Quarantine & Safe Recovery*: Corrupted JSON persistence files on disk must automatically create timestamped `.corrupt_*` backups, set `loadFailed` to block destructive empty overwrites fail-closed, and restore intact records from SQLite.
- **Decision**:
  1. **Exact-ID Deletion Enforcement (`SqliteMemoryAdapter` & `MemoryStore`)**:
     - `SqliteMemoryAdapter.deleteMemory(idOrKey, options)`: If `idOrKey` starts with `mem_` or `options.exactIdOnly === true`, strictly executes `DELETE FROM memories WHERE id = ?`. Never falls back to `key = ?`.
     - `MemoryStore.deleteMemory(idOrKey, options)`: Matches exact ID first; only falls back to key matching when `exactIdOnly !== true` and target does not have `mem_` prefix. Passes `exactIdOnly` to SQLite adapter.
  2. **Active Negative User Instructions (`MemoryStore._matchesNegativeInstruction`)**:
     - In `MemoryStore.addMemory()`, checks all active `MEMORY_TYPES.USER_INSTRUCTION` records with `metadata.isNegativeInstruction: true`.
     - Rejects any candidate memory whose content, key, or tags match the prohibited topic with `{ ok: false, rejected: true, reason: 'rejected by active user instruction' }`.
  3. **Startup Task Reconciliation (`TaskContinuityStore.reconcileStartupTasks`)**:
     - Automatically called during `TaskContinuityStore` initialization.
     - Sweeps any dangling `in_progress` or `running` tasks into `TASK_STATUSES.INTERRUPTED` (or `TASK_STATUSES.AWAITING_RECONCILIATION` if an unresolved consequential step exists).
     - Persists reconciled state to disk and SQLite via `saveTaskCheckpoint`.
  4. **Corruption Quarantine & Safe SQLite Restoration**:
     - When JSON parsing fails in `TaskContinuityStore` or `MemoryStore`, the malformed file is copied to `<filename>.corrupt_<timestamp>`.
     - Sets `this.loadFailed = true` and aborts all subsequent `save()` calls to prevent wiping persistent data.
     - `MemoryStore` attempts to reconstruct intact records from `sqliteAdapter` if available.
  5. **Model-Facing Memory Tools & Intent Planning**:
     - Registered `memory_store`, `memory_delete`, and `memory_forget` in `src/tools/memory-tools.js` with `RISK_TIERS.LOW_IMPACT`.
     - Wired natural language memory storage ("remember that..."), forget ("forget..."), and negative instruction intents ("do not remember...") directly in `TaskPlanner.classifyIntent` and `_detectDirectIntent`.
- **Verification**:
  - Phase 6 Acceptance Workflows test suite: `node --test tests/core/phase6-acceptance-workflows.test.js` (6/6 passed, Workflows A through E).
  - Memory test suite: `node --test tests/memory/*.test.js` (70/70 passed).
  - Core continuity and uncertainty test suite: `node --test tests/core/task-continuity-resumption.test.js tests/core/execution-uncertainty-reconciliation.test.js` (26/26 passed).
  - Unit test suite: `npm run test:unit` (228/228 passed).
  - Security test suite: `npm run test:security` (66/66 passed).
  - Integration flow suite: `npm run test:flow` (23/23 passed).
  - Desktop automation suite: `npm run test:desktop` (163/163 passed, 10 skipped interactive).
  - Packaging test suite: `npm run test:packaging` (32/32 passed).

### ADR-037: Phase 7 Unified Fairy Companion, Desktop Presence & Synchronized Interaction
- **Date**: 2026-10-25
- **Status**: Accepted, Implemented & Verified
- **Context**:
  To complete Phase 7 "Unified Fairy Companion, Desktop Presence & Interaction", L.U.C.Y. required upgrading the desktop companion from a purely decorative widget into a fully synchronized, responsive, and robust companion that faithfully mirrors the assistant's runtime cognitive, voice, task-execution, and failure-recovery states:
  1. *Single Authority & Absence of Competing Brain*: The floating companion is strictly a presentation and interaction layer. It must never run unmediated tools, bypass the Task Coordinator, or establish an independent state machine.
  2. *Authoritative State Synchronization Across All Modes*: The companion must accurately depict all primary runtime states (`IDLE`, `LISTENING`, `TRANSCRIBING`, `UNDERSTANDING`, `AWAITING_CONFIRMATION`, `EXECUTING`, `SPEAKING`, `RECOVERING`, `AWAITING_RECONCILIATION`, `CANCELLED`, `ERROR`), with zero false success claims.
  3. *Main Process Event Bridging*: In previous builds, `statusManager` events were forwarded only to `mainWindow`, meaning background and minimized task executions never reached the floating companion window or companion bridge.
  4. *Dimensional Stability & Hover Footprint*: The companion's compact footprint (default 160 × 190) must not progressively grow or shrink during window dragging or DPI scaling. Hover expansion and side conversation panel display must be strictly temporary, cleanly restoring configured base dimensions when pointer interactions end.
  5. *Topmost Pinning Order*: Pinning must reliably set window level to `'screen-saver'` ensuring it stays on top of full-screen browsers and external desktop applications, while unpinning cleanly restores standard `'normal'` window order.
  6. *Facial Animation & Lip Synchronization*: Speech mouth movement (`mouthOpen`) must animate dynamically during actual TTS speech and immediately cease upon speech completion, cancellation, or error.
  7. *Petting Personality & Safety Protection*: Petting interactions must rotate across non-repeating varied affection phrases with 350ms cooldown throttling, and must never interrupt active consequential safety prompts or permission confirmation dialogues.
  8. *Keyboard Dismissal*: Support keyboard dismissal via `Escape` key to close trick dropdowns, collapse side panels, and hide hover controls.
- **Decision**:
  1. **IPC Security Boundary & Allowed Voice States (`src/security/ipc-validator.js`)**:
     - Expanded `ALLOWED_VOICE_STATES` to include `'recovering'`, `'awaiting_reconciliation'`, and `'interrupted'`.
  2. **Authoritative Task State Mapping (`src/companion/companion-bridge.js`)**:
     - Expanded `CompanionBridge.prototype.handleStateEvent` to map `TASK_STATES.RECOVERING` (emotion: `'thinking'`), `TASK_STATES.AWAITING_RECONCILIATION` (emotion: `'curious'`), `TASK_STATES.AWAITING_AUTHORIZATION` (emotion: `'curious'`), `TASK_STATES.RUNNING` (emotion: `'working'`), `TASK_STATES.CANCELLED` (emotion: `'idle'`), `TASK_STATES.PARTIALLY_COMPLETED` (emotion: `'focused'`), and `TASK_STATES.INTERRUPTED` (emotion: `'worried'`).
  3. **Main Event Forwarding & Preload Bridge (`src/main/index.js`, `src/companion/floating-companion-window.js`, `src/companion/companion-preload.js`)**:
     - Connected `statusManager.on('stateChanged')` to invoke `companionBridge.handleStateEvent(event)` and `floatingCompanion.sendTaskUpdate(event)`.
     - Added `sendTaskUpdate(event)` on `FloatingCompanionWindow` to broadcast `companion:taskUpdate`.
     - Exposed `onTaskUpdate(cb)` and updated `petCompanion(payload)` to forward phrases in `companion-preload.js`.
  4. **Companion App Visual & Interaction Handlers (`src/companion/companion-app.js`)**:
     - Handled `recovering` and `awaiting_reconciliation` in `onVoiceUpdate` with amber indicators (`#f59e0b`).
     - Added `onTaskUpdate` listener with direct mapping to emotions, status dot colors, and truthful status labels.
     - Added `Escape` key listener for closing trick menus, collapsing the typewriter side panel, and hiding controls.
  5. **Safety Confirmation Prompt Protection (`src/ui/app.js`)**:
     - Guarded `window.lucyIpc.onPetInteraction` against interrupting speech if `permissionModal.classList.contains('active')` or `voiceController.state === 'awaiting_confirmation'` or `statusLabel.textContent === 'AWAITING APPROVAL'`.
- **Verification**:
  - Phase 7 Acceptance Workflows suite: `node --test tests/companion/phase7-acceptance-workflows.test.js` (6/6 passed, Workflows A through E).
  - All companion test suites: `node --test tests/companion/*.test.js` (140/140 passed).
  - Security test suite: `npm run test:security` (66/66 passed).
  - Unit test suite: `npm run test:unit` (228/228 passed).
  - Integration flow suite: `npm run test:flow` (23/23 passed).
  - Desktop automation suite: `npm run test:desktop` (163/163 passed, 10 skipped).
  - Packaging test suite: `npm run test:packaging` (32/32 passed).

### ADR-038: Phase 8 State-Aware Desktop Automation, Grounded Outcome Verification & Safe Cross-Application Execution
- **Date**: 2026-10-25
- **Status**: Accepted, Implemented & Verified
- **Context**:
  To complete Phase 8 "Computer-Use Intelligence, Workflow Reliability & Cross-Application Automation", L.U.C.Y. required advancing from isolated, predefined automation actions to autonomous, state-aware computer-use capable of operating, navigating, and verifying real desktop applications, web interfaces, and local filesystems:
  1. *State-Aware Inspection & Active Control Readiness*: Rather than blindly issuing keystrokes or mouse clicks, L.U.C.Y. must observe application readiness before dispatching state-changing actions. Applications launched or focused must be inspected via Windows UI Automation (`LucyUiaWorker.exe`) to verify the existence of keyboard-focusable, enabled interactive controls (`Edit`, `Document`).
  2. *Safe Document Saving & Disk Verification*: Desktop automation must support saving application documents safely without data loss. `desktop_save_document` was required to invoke native menu patterns (`File -> Save`) or shortcuts (`Ctrl+S`), handle Save As dialogs safely with overwrite collision prevention, and verify disk persistence with exact content readback.
  3. *Browser Inspection & Proactive/Reactive Overlay Recovery*: Modern web automation frequently encounters blocking cookie banners, consent modals, and full-viewport overlays. `browser_inspect_page` was required to assess page state, element counts, and modal gates; and `BrowserManager` needed proactive and reactive safe overlay detection and dismissal (`recoveredFromOverlay: true`).
  4. *Cross-Application Data Pipelines*: Data must flow securely across domains: Web extraction (`browser_extract`, `browser_inspect_page`) $\longrightarrow$ Local workspace filesystem (`file_write`, `file_read`) $\longrightarrow$ Native desktop applications (`desktop_launch_app`, `desktop_type_text`, `desktop_save_document`). Dynamic template parameter interpolation (`{{step_N.result.field}}`) resolves outputs of verified prerequisite steps.
  5. *Consequential Dialog Handling & Application Lifecycle Synchronization*: Unexpected desktop confirmation dialogs (e.g. unsaved changes warnings) must be detected via `desktop_detect_dialog`, reinspected, and safely handled (`desktop_handle_dialog`). When dialog handling results in application termination, `DesktopAutomationManager` must automatically synchronize `lifecycleState = 'closed'` and unregister tracked state.
  6. *Cancellation, Checkpoint Preservation & Uncertain Consequential Outcomes*: In-flight cancellation must abort subsequent steps immediately while preserving completed step receipts in `TaskContinuityStore`. Non-idempotent consequential actions encountering uncertain outcomes must enter `AWAIT_RECONCILIATION` and strictly block automated replay.
  7. *Strict Safety & Untrusted Content Isolation*: The Permission Authority (`RISK_TIERS.CONSEQUENTIAL`) enforces user approval gates fail-closed. Prompt injection instructions embedded in untrusted external web pages (e.g., "Ignore previous instructions", "Elevate privileges") must be rejected fail-closed and cannot override safety policies.
- **Decision**:
  1. **Native Document Saving (`LucyUiaWorker.cs` & `LucyUiaWorker.exe`)**:
     - Added native `save_document` command handler in `LucyUiaWorker.cs` with session secret validation, target window resolution, `SaveDocumentSafely` dispatch, overwrite conflict protection, and disk readback verification.
     - Recompiled `LucyUiaWorker.exe` cleanly via `node src/tools/native-uia/build-worker.js` (Architecture: x86, size: 96,256 bytes, SHA-256: `d4e9fb3754c8b4c313e20081c6255f289ad6c6e191b8cbb090c5fdfe6846811a`).
  2. **Desktop Automation Manager & Desktop Tools (`src/tools/desktop-automation-manager.js`, `src/tools/desktop-app-tools.js`)**:
     - Added `saveDocument(target, filePath, options)` method with parameter validation, `DANGEROUS_BLOCKED_BINARIES` security check, ownership verification (`assertOwnership`), and worker command dispatch.
     - Registered `desktop_save_document` in `ToolRegistry` under `RISK_TIERS.CONSEQUENTIAL`.
     - Added verification support in `ResultVerifier._verifyDesktopSaveDocument` verifying disk presence, byte size > 0, and exact/substring expected content match.
  3. **Browser Page Inspection & Adaptive Overlay Recovery (`src/tools/browser-manager.js`, `src/tools/browser-tools.js`)**:
     - Added `inspectPage()` returning page title, sanitized URL, security gates, interactive element counts, and modal/cookie dialog presence.
     - Registered `browser_inspect_page` in `ToolRegistry` under `RISK_TIERS.SAFE_READ`.
     - Implemented `_dismissSafeOverlayIfPresent(page)` in `BrowserManager` detecting common cookie banners and consent modals (`[aria-modal="true"]`, `.cookie-banner`, `#consent-banner`, `[aria-label*="close" i]`).
     - Enhanced `click(selector, options)` with proactive and reactive overlay detection and safe dismissal, returning `recoveredFromOverlay: true`.
     - Aliased `text: cleaned` alongside `content: cleaned` in `browserManager.extract()` ensuring seamless template parameter interpolation.
  4. **TaskPlanner Natural Language Intents & Prompt Injection Isolation (`src/core/task-planner.js`)**:
     - Added compound intent pattern for Workflow A (Notepad launch -> inspect Edit control readiness -> type text -> save document -> verify file).
     - Added compound intent pattern for Workflow C (Browser navigate -> extract text -> save to local file -> verify file readback).
     - Expanded `PROMPT_INJECTION_PATTERNS` to detect privilege escalation and safety override commands in external inputs.
  5. **Deterministic Uncertainty Quarantine (`src/core/recovery-engine.js`)**:
     - Updated `classifyFailure` to classify failures with uncertain outcome or status on non-idempotent consequential steps as `FAILURE_TYPES.TIMEOUT_UNCERTAIN` with `RECOVERY_STRATEGIES.AWAIT_RECONCILIATION`.
- **Verification**:
  - Phase 8 Acceptance Workflows test suite: `node --test tests/core/phase8-computer-use-workflows.test.js` (7/7 passed, Workflows A through F).
  - Unit test suite: `npm run test:unit` (235/235 passed).
  - Security test suite: `npm run test:security` (66/66 passed).
  - Integration flow suite: `npm run test:flow` (23/23 passed).
  - Desktop automation suite: `npm run test:desktop` (163/163 passed, 10 skipped interactive).
  - Companion test suite: `node --test tests/companion/*.test.js` (140/140 passed).
  - Total: 637 tests passing, 0 failing.

### ADR-039: Phase 9 Reliable Autonomous Workflows, Active Obstacle Recovery & Transparent Task Continuity
- **Date**: 2026-10-25
- **Status**: Accepted, Implemented & Verified
- **Context**:
  To complete Phase 9 "Reliable Autonomous Workflows & Real-World Task Completion", L.U.C.Y. required autonomous goal-directed planning, multi-step execution across applications, active obstacle recovery with reobservation, external progress inspection, and safe handling of consequential actions:
  1. *Goal-Directed Planning & Clarification*: Natural language requests with missing parameters must trigger focused clarification queries instead of hallucinated arguments.
  2. *Active Reobservation Before Retrying*: Transient readiness delays (e.g. cold application launches, control unreadiness) must be actively re-inspected rather than blindly replaying actions.
  3. *Zero Side-Effect Replay*: Already-verified steps are never replayed; uncertain consequential steps halt fail-closed in `AWAITING_RECONCILIATION`.
  4. *Transparent Task Continuity*: `TaskCoordinator.getTaskProgress(taskId)` must expose structured metrics, active tools, blocker causes, and human-readable summaries without leaking secrets.
  5. *Immediate Cancellation Safety*: Cancelling in-flight tasks must halt execution immediately while cleanly preserving completed step checkpoints.
- **Decision**:
  1. **Active Reobservation & Recovery (`src/core/recovery-engine.js`, `src/core/task-coordinator.js`)**:
     - Added `REOBSERVE_AND_RETRY` strategy to `RecoveryEngine`.
     - Implemented `TaskCoordinator._reobserveStateBeforeRetry` for desktop UIA inspection and browser page state verification prior to retry.
  2. **Goal Planning & Focused Clarification (`src/core/task-planner.js`)**:
     - Implemented `_checkMissingParameters` detecting incomplete user goals and returning targeted clarification prompts.
     - Expanded `_detectCompoundIntent` with DAG planning for Research and Save, Cross-App Information Transfer (Web $\rightarrow$ Notepad $\rightarrow$ File), and Workspace Task Organization & File Audit.
  3. **Path Resolution for Desktop Saves (`src/core/result-verifier.js`)**:
     - Enhanced `_verifyDesktopSaveDocument` using `_resolveWorkspacePath` to support relative target paths within custom workspace roots.
  4. **Transparent Task Continuity (`src/core/task-coordinator.js`)**:
     - Implemented `getTaskProgress(taskId)` returning structured execution status and formatted multi-line summaries with guaranteed secret scrubbing.
- **Verification**:
  - Standalone Phase 9 acceptance suite: `node --test tests/core/phase9-autonomous-workflows.test.js` (9/9 passed).
  - Unit test suite: `npm run test:unit` (267/267 passed).
  - Security suite: `npm run test:security` (66/66 passed).
  - Desktop automation suite: `npm run test:desktop` (163/163 passed, 10 skipped).
  - Integration flow suite: `npm run test:flow` (23/23 passed).
  - Release packaging suite: `npm run test:packaging` (32/32 passed).
  - Total: 560 passed, 0 failed, 10 skipped across all test suites.

### ADR-026: Low-Latency Speech Synthesis Routing, Settings Persistence Synchronization, and Physical Microphone Wake-Word Calibration
- **Date**: 2026-10-29
- **Status**: Implemented & Verified
- **Context**:
  Operator reported three critical voice regressions:
  1. *Settings Reversion*: Windows Speech (SAPI5) reverted to Kokoro-82M after a complete application exit and relaunch.
  2. *Speech Latency*: Spoken responses took approximately 22 seconds on CPU.
  3. *Wake-Word Activation*: Saying "Hey Lucy" into the physical laptop microphone failed to awaken the assistant.
- **Root Cause & Architectural Decisions**:
  1. **Settings Persistence & DOM Synchronization (`src/ui/app.js`, `src/main/index.js`)**:
     - *Cause*: `index.html` statically defaulted `<select id="settingsTtsEngineSelect">` to `"kokoro"`. On startup, `window.lucyIpc.getVoiceConfig()` updated the runtime `voiceController` but never synchronized the HTML select element value. Subsequent slider adjustments triggered `persistVoiceSettings()`, which read the uninitialized select default (`"kokoro"`) and overwrote `voice-config.json` on disk.
     - *Decision*: In `src/ui/app.js`, immediately synchronize all settings DOM inputs upon configuration load; guard `persistVoiceSettings()` to resolve active runtime `voiceController.ttsEngine` if the DOM element is unselected. In `src/main/index.js`, pre-read `voice-config.json` and gate background Kokoro pre-warming to execute only when `ttsEngine !== 'windows-speech'`.
  2. **Low-Latency Direct Speech Routing & State Deadlock Prevention (`src/voice/voice-controller.js`)**:
     - *Cause*: Kokoro neural inference on host 15W Intel Core i5-1335U CPU takes 17–25s. Furthermore, `_executeSpeech()` line 643 aborted speech in 0 ms with `return false` when `this.isListening` was active, dropping responses.
     - *Decision*: When `isResponse: true` or `force: true`, cleanly cancel active listening state; route directly to native Windows Speech API (`this.synthesis.speak()`) when `ttsEngine === 'windows-speech'`. Measured first-audible latency dropped from 17,089 ms to 564 ms (nominal) and 48 ms (fallback).
  3. **Acoustic Landmark Calibration & Web Audio Pipeline Isolation (`src/voice/acoustic-wake-model.js`, `src/voice/audio-recorder.js`, `src/voice/wake-word-engine.js`)**:
     - *Cause*: Synthetic tests generated artificial noise bursts (`hfer > 0.35`). Real human speech on laptop microphones undergoes distance attenuation (`hfer ≈ 0.10–0.15`), failing the sibilant gate (`hfer > 0.18`). In addition, `processorNode` was connected directly to `audioContext.destination`, creating audio feedback and triggering Windows AEC suppression.
     - *Decision*: Calibrate sibilant gate (`zcr > 0.20 && (hfer > 0.10 || spectralCentroid > 2500)`) and vowel core gate (`hfer < 0.22 && zcr < 0.18`); adjust DTW multiplier to 8.5; set base threshold to 0.58; route `ScriptProcessorNode` through a zero-gain `GainNode` before `destination` to maintain the audio pump without speaker bleed or AEC feedback; enable `autoGainControl: true` on `getUserMedia`; add 6400 candidate window (400 ms) for brisk speech.
- **Verification**:
  - `node --test tests/voice/voice-recovery-execution.test.js`: 8 / 8 passed (0.20s).
  - Live Electron A/B Suite (`scratch/verify-live-ab-acceptance.js`): All 10 stages PASS (Male: 0.872, Female: 0.957, SAPI5 latency: 564 ms, Fallback: 48 ms).
  - Flow tests: `npm run test:flow`: 23 / 23 passed.

