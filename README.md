# L.U.C.Y. — Autonomous Personal Desktop Assistant & Companion

**Learning, Understanding, and Creating Yourself**

L.U.C.Y. is a privacy-first, autonomous desktop assistant and companion for Windows. Built on Electron, Node.js, and native Windows UI Automation, L.U.C.Y. provides multi-provider AI intelligence, local offline task execution, safe browser automation, persistent memory, and an expressive, customizable companion interface.

---

## Key Features & Invariants

1. **Single Authoritative Brain**: All user interactions route through a single `TaskCoordinator`. The companion is strictly a presentation renderer with zero independent agent loops or competing tool executions.
2. **Central Permission Authority**: Fail-closed interactive confirmation gates for consequential actions (keystrokes, writes, deletes, payments) with a 60-second auto-cancel timeout (`SEC-005`). Mechanical dry-run isolation prevents unintended side effects.
3. **Multi-Provider AI Intelligence**: Native structured tool calling across Google Gemini, OpenRouter, local Ollama (100% offline, zero-cost), and Hugging Face serverless inference.
4. **Zero Paid-Provider Fallback**: Provider errors fail closed immediately. L.U.C.Y. never silently switches to a secondary paid cloud API.
5. **Multimodal Visual Feedback Loop (DEF-003)**: Integrates desktop and browser screenshot capture directly with vision models (`visual_inspect`) for verified action planning and receipt emission.
6. **Native Windows Desktop Automation**: High-performance 18 KB C# automation worker (`LucyUiaWorker.exe`) compiled via Windows `csc.exe` with early desktop station routing (`WinSta0\default`), deep UIA tree inspection, ValuePattern text entry, InvokePattern clicks, and safe Notepad modal save dialog handling (`save`, `dont_save`, `cancel`, `ask`).
7. **Safe Browser Automation**: Microsoft Playwright integration supporting multi-tab workflows, persistent authentication profiles (`userDataDir`), secure downloads with collision avoidance, and fail-closed CAPTCHA detection.
8. **Scalable 5-Category Persistent Memory**: SQLite WASM (`sql.js`) indexing with BM25 lexical ranking and exact-phrase boosting, secret redaction (`[REDACTED_SECRET]`), and safe crash recovery checkpoints.
9. **Private Voice Interaction**: Push-to-talk speech recognition, offline local transcription via `whisper.cpp` (`whisper-cli.exe` + `ggml-tiny.en.bin`), configurable speech synthesis (pitch/rate/volume controls with live preview), and opt-in wake-word detection.
10. **Floating Fairy UX 2.0**: Canonical feminine fairy companion (`CelestialFamiliarRenderer`) with resizable window clamping (`[180x220]` to `[520x600]`), clean 3-button dock (Talk, Pin, Return), adjacent side conversation panel (zero facial text overlap), 3-tier adaptive idle loop (24 FPS idle, 159 MB stable memory), and persistent background operation via system tray.

---

## Quick Start

### Prerequisites
- **Operating System:** Windows 10 (version 1809+) or Windows 11 (64-bit).
- **Node.js:** Node.js >= 20 LTS (Node 24.12.0 verified).
- **Package Manager:** npm >= 10.

### Installation & Execution
```powershell
# 1. Install dependencies
npm install

# 2. Run the complete automated regression test suite (427 tests)
npm test

# 3. Launch L.U.C.Y. in development mode
npm start
```

### Building & Verifying Releases
```powershell
# Compile native worker, provision assets, package binaries, and verify hashes
npm run release

# Verify release artifacts cryptographically
npm run release:verify

# Run packaged application runtime smoke tests
npm run smoke:packaged

# Run live packaged acceptance suite (Notepad save policies, background runtime, tray)
node scripts/verify-packaged-release-live.js
```

---

## Documentation Index

- [Architecture Specification](file:///c:/Users/admin/Desktop/LUCY/docs/ARCHITECTURE.md) — Single Authority model, UIA worker, and IPC boundaries.
- [Developer Setup & Operations Guide](file:///c:/Users/admin/Desktop/LUCY/docs/DEVELOPMENT.md) — Environment setup, scripts, packaging, and configurations.
- [Testing & Quality Assurance Guide](file:///c:/Users/admin/Desktop/LUCY/docs/TESTING.md) — Test suites, commands, evidentiary standards, and live benchmarks.
- [Architecture Decision Records (ADRs)](file:///c:/Users/admin/Desktop/LUCY/docs/DECISIONS.md) — ADR-001 through ADR-026.
- [Known Issues & Open Backlog](file:///c:/Users/admin/Desktop/LUCY/docs/KNOWN_ISSUES.md) — Confirmed limitations and physical acceptance status.
- [Historical Audit Archive](file:///c:/Users/admin/Desktop/LUCY/docs/audit/) — Historical phase reports and defect registries.

---

## Security & Privacy Invariants

- **DPAPI Encryption**: API keys and secrets encrypted at rest via Windows DPAPI (`CryptProtectData`).
- **Workspace Containment**: Strict boundary enforcement prevents path traversal (`../`) and sibling collisions (`LUCY2`).
- **Single-Instance Lock**: Prevents multiple processes from locking shared memory or database files.
- **Fail-Closed Execution**: Missing credentials, denied permissions, unverified tools, and unexpected states halt execution without forging receipts.
