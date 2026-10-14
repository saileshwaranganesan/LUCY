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

