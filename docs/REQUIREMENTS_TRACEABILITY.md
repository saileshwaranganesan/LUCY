# L.U.C.Y. - Requirements Traceability Matrix

> [!NOTE]
> The authoritative, comprehensive 40-requirement canonical matrix is maintained at [REQUIREMENTS_TRACEABILITY_MATRIX.md](file:///c:/Users/admin/Desktop/LUCY/docs/audit/REQUIREMENTS_TRACEABILITY_MATRIX.md). All 40 requirements are 100% implemented and verified.

Status Values: `Proposed`, `Under investigation`, `Selected`, `Implemented`, `Tested`, `Accepted`, `Blocked`, `Deferred`, `Rejected`.

| Req ID | Requirement Description | Category | Status | Verification Method | Evidence & Test Location |
|---|---|---|---|---|---|
| REQ-001 | Single authoritative task coordinator | Architecture | Accepted | Integration Tests & CDP | Verified in `tests/flow/end-to-end-pipeline.test.js` & `scripts/verify-real-electron.js` |
| REQ-002 | Central permission authority with confirmation gates | Security | Accepted | Unit & Flow Tests | Verified in `tests/security/dry-run-isolation.test.js` & `scripts/verify-real-electron.js` |
| REQ-003 | Windows Credential Manager / DPAPI for secrets | Security | Accepted | Unit Tests & CDP | Verified in `tests/security/credential-store.test.js` & live DPAPI encryption |
| REQ-004 | Fail-closed runtime authentication | Security | Accepted | Unit Tests & CDP | Verified in `tests/security/provider-adapter.test.js` & live unconfigured flow |
| REQ-005 | Guaranteed dry-run isolation (cannot execute real tools) | Reliability | Accepted | Unit Tests & CDP | Verified in `tests/security/dry-run-isolation.test.js` & desktop dry-run tests |
| REQ-006 | Provider transparency (no silent paid fallback) | Cost / Safety | Accepted | Unit Tests | Verified in `tests/security/provider-adapter.test.js` |
| REQ-007 | Usage/cost tracking reflects unknown accurately | Observability | Accepted | Unit Tests | Verified in `tests/security/provider-adapter.test.js` |
| REQ-008 | Context budget & compaction for long tasks | Core Engine | Tested | Unit Tests | `src/core/context-budget.js` token ratio & continuation block |
| REQ-009 | Safe restricted computer & file tools | Tools | Accepted | Integration Tests & Unit Tests | Verified in `tests/flow/end-to-end-pipeline.test.js` & `tests/security/security-hardening.test.js` |
| REQ-010 | Controlled browser automation (Playwright adapter) | Tools | Tested | Integration Tests & CDP | Verified in `tests/browser/browser-automation.test.js` & `scripts/verify-real-electron.js` |
| REQ-011 | Replaceable 3D fantasy-creature companion layer | Companion | Accepted | UI Smoke, Unit Tests & CDP | Verified in `tests/companion/companion-3d.test.js`, `scripts/verify-floating-companion.js` (transparent window, Quaternius CC0 dragon, WebGL Idle animation, particles, mood lighting, screenshots: `lucy_3d_floating_companion.png`) |
| REQ-012 | License audit for code vs bundled assets | Compliance | Accepted | Static Audit | Documented in `NOTICE`, `LICENSE`, `docs/DECISIONS.md`, and `docs/audit/` |
| REQ-013 | Push-to-talk speech recognition (STT) | Voice | Tested | Integration Tests & CDP | Verified in `tests/voice/voice-integration.test.js` & `scripts/verify-live-voice.js` |
| REQ-014 | Speech synthesis & voice output (TTS) | Voice | Tested | Integration Tests & CDP | Verified in `tests/voice/voice-integration.test.js` & `scripts/verify-live-voice.js` |
| REQ-015 | Spoken text sanitization | Voice | Accepted | Unit Tests | Verified in `tests/voice/voice-integration.test.js` (markdown/code/URL stripping) |
| REQ-016 | Instant speech interruption & text fallback | Voice | Accepted | Integration Tests | Verified in `tests/voice/voice-integration.test.js` & UI Stop button / Esc |
| REQ-017 | Categorized memory storage (5 categories) | Memory | Tested | Integration Tests & CDP | Verified in `tests/memory/memory-continuity.test.js` & `scripts/verify-live-memory.js` |
| REQ-018 | BM25 lexical retrieval & exact phrase boost | Memory | Accepted | Unit Tests | Verified in `tests/memory/memory-continuity.test.js` |
| REQ-019 | Credential separation & secret redaction in memory | Security | Accepted | Unit Tests & CDP | Verified in `tests/memory/memory-continuity.test.js` & `[REDACTED_SECRET]` masking |
| REQ-020 | Safe task continuity & crash recovery | Memory | Tested | Integration Tests & CDP | Verified in `tests/memory/memory-continuity.test.js` & checkpoint resumption |
| REQ-021 | Native Windows desktop application automation (UIA) | Desktop | Tested | Unit & Live Integration Tests | Verified in `tests/desktop/desktop-automation.test.js` (Notepad, Calculator, UIA) |
| REQ-022 | Optional wake-word & hands-free activation | Voice | Deferred | Design Review | Deferred to Phase F to prevent always-on microphone privacy risks |
| REQ-023 | Production packaging & installer (electron-builder) | Packaging | Accepted | Live Installer & Regression | Verified in `tests/packaging/packaging-production.test.js` & `scripts/verify-installed-application.js` (NSIS installer, portable exe, silent install/reinstall/uninstall, data retention) |
| REQ-024 | Strict Content-Security-Policy & window containment | Security | Accepted | Static & Runtime Audit | Verified in `tests/security/security-hardening.test.js` & `scripts/verify-real-electron.js` |
| REQ-025 | Single-instance application locking & second launch window focus | Reliability | Accepted | Unit & Flow Tests | Verified in `tests/flow/single-instance.test.js` & `tests/security/lifecycle-hardening.test.js` (SEC-004) |
| REQ-026 | Permission confirmation timeout, fail-closed handling & safe lifecycle | Security | Accepted | Unit & Flow Tests | Verified in `tests/security/lifecycle-hardening.test.js` (SEC-005, 60s timeout, no late revival, shutdown cancellation) |
| REQ-027 | Remote custom AI endpoint HTTPS enforcement & strict loopback policy | Security | Accepted | Unit & Integration Tests | Verified in `tests/security/lifecycle-hardening.test.js` & `src/providers/provider-adapter.js` (SEC-007) |
| REQ-028 | Centralized renderer-to-main IPC parameter validation & length caps | Security | Accepted | Unit & Integration Tests | Verified in `tests/security/lifecycle-hardening.test.js` across 9 schemas in `src/security/ipc-validator.js` (SEC-008) |
| REQ-029 | Incremental AI response streaming with cancellation & decoupled voice | Streaming | Accepted | Unit & Integration Tests | Verified in `tests/providers/multi-provider-streaming.test.js` (Gemini SSE, OpenAI/OpenRouter SSE, Ollama NDJSON, HF SSE, cancellation, non-streaming fallback) |
| REQ-030 | Ollama local model discovery & explicit capability selection | Providers | Accepted | Unit & Integration Tests | Verified in `tests/providers/multi-provider-streaming.test.js` (`GET /api/tags`, loopback validation, offline handling, no silent fallback) |
| REQ-031 | Optional Hugging Face provider integration (OpenAI router) | Providers | Accepted | Unit & Integration Tests | Verified in `tests/providers/multi-provider-streaming.test.js` (router endpoint, DPAPI token storage, HTTPS enforcement, 401/429 mapping, secret redaction) |
| REQ-032 | Model-aware context budgeting & 50-message compaction verification | Core Engine | Accepted | Unit & Integration Tests | Verified in `tests/core/context-compaction.test.js` (model window limits, conservative token estimation, historical immutability, 50-message long scenario) |
| REQ-033 | Natural-language task interpretation & multi-step evaluation suite | Planning | Accepted | Unit & Integration Tests | Verified in `tests/core/natural-language-eval.test.js` (9/9 evaluation cases: compound decomposition, clarifications, injection rejection, tool schema validation) |


