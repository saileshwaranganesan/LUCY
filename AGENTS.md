# L.U.C.Y. Project Development Guidelines & Tooling Bridge

This document guides AI coding agents working on the L.U.C.Y. (Learning, Understanding, and Creating Yourself) desktop assistant repository.

## 1. Project Architecture & Non-Negotiable Invariants

1. **Single Authority Model**:
   - `TaskCoordinator` (`src/core/task-coordinator.js`) is the sole authoritative brain.
   - Every action flows through: `Request -> TaskCoordinator -> TaskPlanner -> ToolRegistry -> PermissionAuthority -> ResultVerifier -> RecoveryEngine`.
   - The companion renderer (`src/ui/companion-renderer.js`) is strictly a presentation and reactive layer; it never runs an unmediated tool loop.
2. **IPC Security Boundary**:
   - `src/main/preload.js` exposes only explicit `lucyIpc` methods via `contextBridge`.
   - Never expose raw `child_process`, `fs`, or Node built-ins directly to the renderer.
   - All IPC channels are validated by `src/security/ipc-validator.js`.
3. **Defense in Depth**:
   - Credentials stored in Windows Credential Manager / DPAPI, never in plaintext.
   - Desktop automation (`src/tools/desktop-automation-manager.js`) strictly uses Windows UIA (`LucyUiaWorker.exe`) and obeys `SAFE_APP_ALLOWLIST`.

## 2. Verified Tooling Ecosystem & When to Use

Agents have access to a verified toolchain and must select tools intelligently based on task requirements:

- **Documentation Lookup (`context7`)**:
  - Use `context7` MCP (`resolve-library-id`, `query-docs`) when checking API signatures for external dependencies: `playwright`, `electron`, `sql.js`, or `@threejs/three`.
  - Avoid guessing deprecated or hallucinated APIs.
- **Hypothesis Testing & Complex Debugging (`sequential-thinking`)**:
  - For elusive bugs, async race conditions, IPC message loss, or multi-component timing errors, invoke `sequentialthinking` to decompose the problem and test hypotheses before editing code.
- **Software Investigation (`rea`)**:
  - When analyzing packaged Electron distributions (`dist-repair11/`, ASAR bundles), use `rea analyze-javascript-application <path>` to verify module trees, dependencies, and bundle integrity.
  - Note: SQLite schema inspection via REA requires Node >= 24.15; for current Node 24.12, inspect SQLite databases using offline Python (`sqlite3.connect`) or sqlite3 CLI.
- **Browser & UI Verification (`playwright-cli`)**:
  - For headless DOM verification of UI components, serve `src/ui/` over a local loopback HTTP server (`http://localhost:<port>`) and use `playwright-cli open`, `snapshot`, and `close`.
  - Playwright CLI blocks `file://` URLs for security.
- **Design Token Extraction (`skillui`)**:
  - Use `skillui` on `src/ui/` to extract color variables, typography, and spacing grids into `DESIGN.md`.
- **UI/UX Intelligence & Anti-Slop Art Direction (`ui-ux-pro-max`, `taste-design`)**:
  - Consult `ui-ux-pro-max` and `taste-design` for responsive layouts, WCAG AA contrast (minimum 4.5:1), and micro-animations.
  - **Preserve Established Identity**: Always respect L.U.C.Y.'s existing dark fairy palette (`#0f172a`, `#1e293b`, `#a855f7`) and wrap all animations in `@media (prefers-reduced-motion: no-preference)`.
- **Engineering Quality & Task Routing (`superpowers`, `antigravity-dev-suite`, `.agents/`)**:
  - Refer to [lucy-workflow](file:///.agents/skills/lucy-workflow/SKILL.md) and [authoritative-docs](file:///.agents/rules/authoritative-docs.md) for task routing and ground truth.
  - Antigravity executes coding tasks inline with bounded TDD: use `executing-plans`, `gsd-execution`, `test-driven-development`, `systematic-debugging`, and `code-review`. Subagents are not dispatched for general coding; `browser_subagent` is reserved for browser automation.

## 3. Standard Development Workflow (10 Steps)

Every development task must follow these steps:

1. **Understand First**: Consult ground-truth documentation (`PHASE0_BASELINE_REPORT.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`) before proposing edits.
2. **Choose Tools Intelligently**: Select only tools required for the task (`context7`, `sequential-thinking`, `rea`). Do not make pointless tool calls.
3. **Plan Proportionately**: For simple fixes, proceed directly with minimal diffs. For multi-component tasks, define explicit milestones, acceptance criteria, and a turn cap.
4. **Implement Minimally**: Make the smallest correct change that satisfies the requirement using TDD. Avoid unprompted refactoring of unrelated files.
5. **Preserve Context & Integrity**: Retain existing docstrings, comments, and architectural invariants. Never delete or overwrite unrelated user work.
6. **Verify the Result**:
   - Run unit tests: `npm run test:unit`
   - Run security tests: `npm run test:security`
   - Run integration tests: `npm run test:flow`
   - Run packaging tests: `npm run test:packaging`
   - Run full suite: `npm test` (`node --test --test-concurrency=1 tests/**/*.test.js`)
7. **Review Independently**: Examine `git diff` for requirement coverage, regression risks, input validation, and absence of hardcoded secrets.
8. **Report Honestly**: State exactly what was modified, which tests were run with their actual exit codes, and what remains unverified. Never claim an unexecuted check passed.
9. **Bounded Execution**: Stop immediately once acceptance criteria are fulfilled. Do not continue making cosmetic changes.
10. **Zero Secrets**: Never commit API keys, personal paths, or credentials.
