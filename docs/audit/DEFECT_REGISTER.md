# L.U.C.Y. — Defect Register & Forensic Vulnerability Analysis

**Audit Date:** October 14, 2026  
**Auditor:** Antigravity AI Engineering / QA Lead & Application Security Reviewer  
**Total Tracked Defects:** 7 (Confirmed & Evidence-Backed)

---

## 1. Confirmed Defect Summary

| Defect ID | Title | Severity | Impact Area | Confidence | Status |
| :--- | :--- | :---: | :--- | :---: | :---: |
| **DEF-001** | Task Planner Regex Precedence & Literal Content Extraction | **High (P1)** | Natural Language Planning & Execution | High (100%) | **Resolved (Workstream 1B — `tests/core/def-001-reproduction.test.js`)** |
| **DEF-002** | Absence of Native Tool/Function Calling Schemas | **High (P1)** | Model-to-Tool Dispatch & Reliability | High (100%) | **Resolved (Workstream 1B — `tests/core/def-002-structured-tool-calling.test.js`)** |
| **DEF-003** | Missing Screenshot-to-Vision Multimodal Feedback Loop | **Medium (P2)** | Desktop & Web Visual Verification | High (100%) | **Resolved (`tests/core/def-003-vision-loop.test.js`)** |
| **DEF-004** | Ephemeral Playwright Browser Contexts (No Persistent Auth) | **Medium (P2)** | Browser Automation & Session Continuity | High (100%) | **Resolved (`tests/browser/persistent-browser-session.test.js`)** |
| **DEF-005A** | Workspace Missing Version Control (No Git Repository) | **Medium (P2)** | Configuration & Change Safety | High (100%) | **Resolved (Workstream 1A — commit `16d88a86`)** |
| **DEF-005B** | Unsigned Windows Executables & Release Trust Verification | **Low (P3)** | Distribution & SmartScreen Trust | High (100%) | **Resolved (`scripts/verify-release-artifacts.js`, `tests/packaging/release-trust-verification.test.js`)** |
| **DEF-006** | Orphaned Background Packaged App Process (`LUCY.exe`) | **Low (P3)** | Process Contention & Port Safety | High (100%) | **Mitigated (Single-instance lock & procedural termination)** |

---

## 2. Detailed Forensic Analysis

---

### DEF-001: Task Planner Regex Precedence & Literal Content Extraction

- **Severity:** High (P1)
- **Status:** **Resolved in Workstream 1B**
- **Component:** `src/core/content-discriminator.js`, `src/core/task-planner.js`
- **Requirement Linked:** REQ-001, REQ-002
- **Description:**
  In `TaskPlanner.prototype.plan()`, hardcoded regular expressions in `_detectCompoundIntent` and `_detectDirectIntent` previously executed **before** invoking the AI model, capturing unquoted generative requests (e.g. `"a thank-you letter to Bob"`) as literal keystroke payloads for `desktop_type_text`.
- **Reproduction Steps:**
  1. Call `planner.plan('Open Notepad and type a thank-you letter to Bob')`.
  2. Inspect the resulting plan step for `desktop_type_text`.
  3. Observe `params.text` was `"a thank-you letter to Bob"` instead of composed letter content.
- **Remediation Implementation (Workstream 1B):**
  1. Implemented `classifyTextIntent()` in `src/core/content-discriminator.js` to distinguish explicit literal/quoted text from generative document/composition requests.
  2. Added `_planGenerativeCompoundTask()` in `TaskPlanner` to synthesize generative content using the configured model when composition is needed.
  3. Preserved deterministic literal handlers for explicit quoted strings and unambiguous offline commands.
  4. Returns honest `unconfigured_provider` status if a generative request is issued without an active AI key.
- **Verification Evidence:**
  - Automated test suite `tests/core/def-001-reproduction.test.js` passes 4/4 tests:
    - Generative request composes content via provider before typing into Notepad.
    - Explicit quoted string preserves exact literal text deterministically.
    - Missing provider returns informative guidance without crashing.

---

### DEF-002: Absence of Native Tool/Function Calling Schemas

- **Severity:** High (P1)
- **Status:** **Resolved in Workstream 1B**
- **Component:** `src/tools/schema-validator.js`, `src/tools/tool-registry.js`, `src/providers/provider-adapter.js`, `src/core/task-planner.js`
- **Requirement Linked:** REQ-003
- **Description:**
  `TaskPlanner` previously omitted `tools` when calling `providerAdapter.complete()` and relied on fragile regex markdown extraction (`_extractJson()`). Furthermore, Ollama and Hugging Face provider adapters did not pass or parse tool call payloads.
- **Remediation Implementation (Workstream 1B):**
  1. Implemented `validateToolArguments(schema, params)` in `src/tools/schema-validator.js` verifying types, required parameters, and enums.
  2. Updated `ToolRegistry` with `validateParams()` and pre-execution validation.
  3. Standardized native structured tool calling across Google Gemini (`functionDeclarations` + `functionCall` parsing), OpenAI / OpenRouter (`tools` + `tool_calls` parsing), local Ollama (`/api/chat` `tools` + `message.tool_calls`), and Hugging Face (`tools` + `tool_calls`).
  4. Updated `TaskPlanner.plan()` to supply `tools: availableTools` and directly consume structured `res.toolCalls`.
  5. Implemented `_validatePlanSteps()` to validate tool names and JSON schema parameters before execution, failing closed on unknown tools or invalid arguments.
  6. Enforced `PermissionAuthority` on all model-generated plans, ensuring model output cannot bypass user confirmation for consequential actions.
- **Verification Evidence:**
  - Automated test suite `tests/core/def-002-structured-tool-calling.test.js` passes 9/9 tests.
  - Full application test suite `npm test` passes 257/257 tests with 0 failures.

---

### DEF-003: Missing Screenshot-to-Vision Multimodal Feedback Loop

- **Severity:** Medium (P2)
- **Status:** **Resolved (`tests/core/def-003-vision-loop.test.js`)**
- **Component:** `src/providers/provider-adapter.js`, `src/tools/visual-tools.js`, `src/core/task-planner.js`, `src/core/task-coordinator.js`, `src/tools/browser-manager.js`, `src/tools/desktop-app-tools.js`
- **Requirement Linked:** REQ-012, REQ-013
- **Description:**
  Both `desktop_take_screenshot` and `browser_screenshot` previously captured visual PNG buffers and wrote them to disk without forwarding base64 images into the model reasoning pipeline.
- **Remediation Implementation:**
  1. Implemented multimodal message normalization (`_normalizeMultimodalMessage`) in `ProviderAdapter`, parsing OpenAI content arrays, strings, and raw image arrays into uniform `{ mimeType, base64, dataUri }` structures.
  2. Enforced strict MIME allowlist (`image/png`, `image/jpeg`, `image/webp`, `image/gif`) and 4 MB per-image payload cap fail-closed before network dispatch.
  3. Added native vision payload formatting for Google Gemini (`parts: [{ inlineData: { mimeType, data: base64 } }, { text }]`), OpenAI/OpenRouter (`content: [{ type: 'image_url' }, { type: 'text' }]`), Ollama (`images: [base64]`), and honest unsupported reporting for text-only Hugging Face models.
  4. Upgraded `browserManager.screenshot()` and `desktopManager.takeScreenshot()` to return base64 and data URIs.
  5. Implemented central `visual_inspect` tool (`SAFE_READ`) resolving images from base64, files, or dynamic window/browser captures, executing through the configured vision provider.
  6. Enhanced `TaskPlanner` with intent recognition for visual understanding, compound screenshot + inspect tasks, and visual action chaining.
  7. Enforced interactive permission gates on subsequent consequential actions while allowing visual inspections to execute safely.
- **Verification Evidence:**
  - Automated test suite `tests/core/def-003-vision-loop.test.js` passes 10/10 tests covering normalization, validation, provider encoding, tool execution, intent decomposition, and permission gates.
  - Full application test suite `npm test` passes 281/281 tests with 0 failures.

---

### DEF-004: Ephemeral Playwright Browser Contexts (No Persistent Auth)

- **Severity:** Medium (P2)
- **Status:** **Resolved (`tests/browser/persistent-browser-session.test.js`)**
- **Component:** `src/tools/browser-manager.js`, `src/tools/browser-tools.js`
- **Requirement Linked:** REQ-014, REQ-015, REQ-036
- **Description:**
  `BrowserManager.ensureContext()` previously created only in-memory browser contexts via `browser.newContext()`. When L.U.C.Y. closed the browser or completed an automated task, all session cookies, local storage, and authentication states were discarded.
- **Remediation Implementation:**
  1. Added optional, explicitly configured persistent browser profile directory (`userDataDir`), defaulting to application-owned user data storage (`lucy-desktop-assistant/browser-profile`).
  2. Integrated `chromium.launchPersistentContext()` with Windows browser channel detection (`chrome` -> `msedge` -> bundled chromium).
  3. Preserved ephemeral context as the safe default for automated tests and sessions not requiring persistence.
  4. Added `enablePersistence()` and `disablePersistence()` dynamic toggling that safely closes contexts without deleting on-disk profile data.
  5. Registered `browser_session_config` tool to inspect and configure session persistence mode under `SAFE_READ` risk tier.
  6. Added lock error detection (`_isLockedError`) handling profile collisions safely.
  7. Hardened `.gitignore` to prevent browser profile directories, cookies, and tokens from ever being tracked in Git.
- **Verification Evidence:**
  - Automated test suite `tests/browser/persistent-browser-session.test.js` passes 8/8 tests.
  - Test login session (cookies and localStorage) survives closing and reopening persistent context across sessions.
  - Separate profiles do not share sessions; multi-tab navigation functions seamlessly.
  - All 51 browser tests pass with 0 failures; full test suite passes 265/265 tests.

---

### DEF-005A: Workspace Missing Version Control (No Git Repository)

- **Severity:** Medium (P2)
- **Status:** **Resolved (Workstream 1A — commit `16d88a86`)**
- **Component:** Workspace root (`C:\Users\admin\Desktop\LUCY`)
- **Requirement Linked:** Safety & Change Management (Rule E)
- **Description:**
  The workspace `C:\Users\admin\Desktop\LUCY` initially contained no `.git` directory. Running `git status` failed with `fatal: not a git repository`.
- **Resolution:**
  Initialized Git repository, configured hardened `.gitignore` excluding live memory, database journals, swap files, build outputs, and credentials, and committed the verified passing baseline as commit `16d88a86`.

---

### DEF-005B: Unsigned Windows Packaged Executables & Release Trust Verification

- **Severity:** Low (P3)
- **Status:** **Resolved (`scripts/verify-release-artifacts.js`, `tests/packaging/release-trust-verification.test.js`)**
- **Component:** `dist-release/`, `electron-builder.yml`, `scripts/`
- **Requirement Linked:** REQ-026, Distribution & Release Trust
- **Description:**
  Packaged release executables (`L.U.C.Y-Setup-0.1.0-win-x64.exe` and `L.U.C.Y-Portable-0.1.0-win-x64.exe`) are unsigned (`Status: NotSigned`). On initial download from the internet, Microsoft Defender SmartScreen displays an "Unknown Publisher" advisory.
- **Code Signing Evaluation:**
  - Standard OV / Individual Code Signing: Authenticode signs binaries, but new keys require building download reputation before SmartScreen ceases warning users.
  - EV (Extended Validation) Code Signing: Requires commercial entity verification (DUNS number, corporate registration) and a hardware token or cloud HSM ($300–$700/yr). Immediate SmartScreen reputation.
  - Azure Trusted Signing: Requires active Azure enterprise tenant and identity verification.
  - Decision: Without purchasing a certificate, cryptographic hash verification (SHA-256) is the industry standard for open-source integrity.
- **Remediation Implementation:**
  1. Implemented `scripts/generate-release-manifest.js` creating standard `dist-release/SHA256SUMS.txt` and structured `dist-release/release-manifest.json` with source git revision, file sizes, and SHA-256 hashes.
  2. Implemented `scripts/verify-release-artifacts.js` (`npm run release:verify`) recalculating hashes, checking Authenticode status, and detecting file tampering.
  3. Added `*.pfx`, `*.p12`, `*.cer`, `*.crt`, `*.key` exclusions to `.gitignore` ensuring zero private keys enter source control.
  4. Corrected inaccurate release hashes in `docs/PACKAGING_AND_INSTALLATION_GUIDE.md`.
- **Verification Evidence:**
  - Automated test suite `tests/packaging/release-trust-verification.test.js` passes 6/6 tests.
  - Verified detection of tampered bytes (`hash_mismatch`) and missing files (`missing_file`).
  - Production artifacts verified:
    - `L.U.C.Y-Setup-0.1.0-win-x64.exe`: `d5b1cd9690ee8b39eae084945e2e8ac0d9ef1f0a2375635f46defc2221f2f059`
    - `L.U.C.Y-Portable-0.1.0-win-x64.exe`: `3d7650d089f49d62b72ad255a9d8741e5793740251a999e7522eca6028ca481c`

---

### DEF-006: Orphaned Background Packaged App Process (`LUCY.exe`)

- **Severity:** Low (P3)
- **Component:** Operating System Process Table
- **Requirement Linked:** Process Isolation & Single Instance Lock
- **Description:**
  Process inspection revealed an installed instance of `C:\Users\admin\AppData\Local\Programs\LUCY\LUCY.exe` running in the background. While the single-instance lock (`SEC-004`) successfully prevents secondary processes from opening conflicting windows, background processes can lock files in `%APPDATA%\LUCY\memory` if pointing to the same data directory.
- **Smallest Safe Correction:**
  Document procedure to terminate background `LUCY.exe` before conducting live GUI testing.
