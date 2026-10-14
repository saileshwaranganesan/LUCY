# L.U.C.Y. — Prioritized Remediation and Engineering Plan
**Audit Date:** 2026-10-13  
**Auditor:** Antigravity Autonomous Engineering & Audit Agent  
**Taxonomy:** `Autonomous` (Antigravity executes 100% autonomously) | `Manual` (Requires user action)  

---

## 1. Overview of Actionable Remediation Items

This remediation plan orders corrective actions based on verified evidence from the Master Progress Audit. Actions are categorized by priority and execution mode.

---

## 2. Corrective Engineering Workstream Matrix

| Plan ID | Priority | Description | Execution Mode | Dependencies | Status | Acceptance Criteria |
|---|---|---|---|---|---|---|
| **ACT-001** | P1 (High) | Implement Strict Content-Security-Policy (CSP) in `src/ui/index.html` | **Autonomous** | None | **COMPLETED & VERIFIED** | CSP meta tag present; DevTools console displays 0 CSP warnings; all local styles/scripts verified. |
| **ACT-002** | P1 (High) | Migrate Gemini API Key Authentication from Query String to `x-goog-api-key` Header | **Autonomous** | None | **COMPLETED & VERIFIED** | `src/providers/provider-adapter.js` sends key in `x-goog-api-key` header; URL query string has 0 secrets. |
| **ACT-003** | P1 (High) | Harden Workspace Boundary Path Traversal using `path.relative` | **Autonomous** | None | **COMPLETED & VERIFIED** | `assertInsideWorkspace` checks `!relative.startsWith('..') && !path.isAbsolute(relative)`; sibling directories sharing name prefix (e.g. `../LUCY2`) are rejected. |
| **ACT-004** | P2 (Medium) | Enforce IPC Parameter Type Guards & Length Limits in Main Process | **Autonomous** | None | 1 hour | All IPC channels validate argument types, reject non-strings, and enforce max length limits (16KB) with clean error codes. |
| **ACT-005** | P2 (Medium) | Add Confirmation Gate Inactivity Timeout Policy | **Autonomous** | None | 1 hour | Permission modal prompts auto-cancel with fail-closed denial after 60 seconds of user inactivity. |
| **ACT-006** | P1 (High) | Integrate Native Windows UI Desktop Automation (`desktop-pilot-mcp` Adapter) | **Autonomous** | None | 1.5 days | New `src/tools/desktop-app-tools.js` wrapping Windows UIA; registered in `ToolRegistry` under `CONSEQUENTIAL` permission gates; tested offline against Windows Notepad / Calculator. |
| **ACT-007** | P2 (Medium) | Upgrade Companion from 2D Canvas to 3D Transparent Floating Overlay (AVATAR / Three.js) | **Autonomous** | ACT-001 | 2 days | Decoupled 3D celestial familiar model rendered via WebGL/Three.js in transparent always-on-top window; audio-driven lip sync and aura; zero independent agent brain. |
| **ACT-008** | P2 (Medium) | Configure Production Installer Packaging (`electron-builder`) | **Autonomous** | None | 1 day | `package.json` contains `build` script; generates verified `.exe` / NSIS installer without packaging unneeded test fixtures. |
| **ACT-009** | P1 (High) | Configure AI Provider Credentials for Hosted LLM Reasoning | **Manual (User)** | None | 2 minutes | User enters Gemini API key or OpenRouter key in Settings UI (or starts local Ollama). Encrypted into Windows DPAPI. |

---

## 3. Detailed Workstream Specifications

### Workstream 1: Immediate Security Hardening (ACT-001, ACT-002, ACT-003)
- **Objective:** Eliminate all Medium-severity security findings discovered during the audit.
- **Tasks:**
  1. Add `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:*;">` into `src/ui/index.html`.
  2. Update `_callGemini` in `src/providers/provider-adapter.js` to pass API key in `x-goog-api-key` header rather than `?key=${apiKey}` query string.
  3. Update `assertInsideWorkspace` in `src/tools/file-tools.js` to use `path.relative` to eliminate sibling prefix traversal.
  4. Rerun `npm test` and `scripts/verify-real-electron.js` to ensure 100% pass rate.

### Workstream 2: Desktop Application Automation Milestone (ACT-006)
- **Objective:** Fulfill REQ-021 (Desktop Application Automation) using open-source reuse policy.
- **Approach:**
  - Wrap UI Automation concepts from `floatingbrij/desktop-pilot-mcp` (WinApp MCP).
  - Create `src/tools/desktop-app-tools.js` exposing:
    * `app_launch`: Start Windows desktop applications by name/path.
    * `app_find_window`: Discover and focus active application windows.
    * `app_inspect_elements`: Query accessibility tree for buttons, textboxes, and menus.
    * `app_click_element`: Invoke accessibility click on targeted UI element.
    * `app_type_text`: Send verified keystrokes to focused element.
  - Route all side-effecting operations through `PermissionAuthority` with interactive confirmation gates.

### Workstream 3: Companion 3D Visual Upgrade (ACT-007)
- **Objective:** Bridge the gap between current 2D canvas familiar and the original 3D fantasy companion vision.
- **Approach:**
  - Adopt architectural pattern from `ARPAHLS/avatar`: transparent always-on-top Electron window overlay.
  - Use Three.js / WebGL with a cute, non-human celestial fairy familiar 3D mesh.
  - Maintain absolute architectural decoupling: companion is strictly a visual presentation layer reacting to events from the central `TaskCoordinator`.

---

## 4. Autonomous Execution Authorization

All items marked **`Autonomous`** (ACT-001 through ACT-008) can be systematically executed by Antigravity in subsequent sessions without human intervention.
The only item requiring human action is **ACT-009** (providing an API key or local Ollama).
