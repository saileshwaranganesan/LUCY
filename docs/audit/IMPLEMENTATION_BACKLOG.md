# L.U.C.Y. — Prioritized Implementation Backlog & Workstream Roadmap

**Audit Date:** October 14, 2026  
**Auditor:** Antigravity AI Engineering / Lead Software Architect  
**Prioritization Strategy:** Dependency-aware sequencing prioritizing safety, execution correctness, visual grounding, and real-world student workflows.

---

## 1. Backlog Overview

| Item ID | Priority | Title | Linked Reqs | Effort | Prerequisite | Recommended Workstream |
| :--- | :---: | :--- | :--- | :---: | :---: | :---: |
| **BL-001** | **P0** | Version Control & Baseline Safety Snapshot | Safety (Rule E) | **XS** | None | **Workstream 1** |
| **BL-002** | **P1** | Task Planning Generative Intent vs. Regex Separation | REQ-001, REQ-002 | **M** | BL-001 | **Workstream 1** |
| **BL-003** | **P1** | Native Model Tool/Function Calling Schemas | REQ-003, REQ-005 | **M** | BL-002 | **Workstream 2** |
| **BL-004** | **P1** | Multimodal Vision Feedback & Screenshot Grounding | REQ-012, REQ-013 | **L** | BL-003 | **Workstream 3** |
| **BL-005** | **P1** | Persistent Playwright Browser Profile & Auth Sessions | REQ-014, REQ-015 | **S** | BL-001 | **Workstream 4** |
| **BL-006** | **P2** | Dynamic Mid-Flight Replanning & Recovery Loop | REQ-019, REQ-024 | **M** | BL-003 | **Workstream 5** |
| **BL-007** | **P2** | Multi-Monitor Companion Snapping & Bounds Clamping | REQ-031, REQ-033 | **S** | BL-001 | **Workstream 6** |
| **BL-008** | **P3** | Offline Local Speech-to-Text via whisper.cpp CLI | REQ-026, REQ-027 | **M** | BL-001 | **Workstream 7** |
| **BL-009** | **P3** | Student & College Portal Dedicated Workflow Modules | REQ-018, REQ-036 | **L** | BL-005 | **Workstream 8** |
| **BL-010** | **P4** | MediaPipe Webcam Gesture Control | REQ-034 | **L** | BL-007 | **Workstream 9** |

---

## 2. Detailed Workstream & Backlog Specifications

---

### Workstream 1: Baseline Safety & Planning Intent Separation (IMMEDIATE FIRST ACTION)

#### BL-001: Version Control & Baseline Safety Snapshot
- **Priority:** P0 (Safety Gate)
- **Problem:** `C:\Users\admin\Desktop\LUCY` is not a Git repository. Any subsequent refactor runs the risk of unrecoverable data loss.
- **Proposed Smallest Safe Change:** Run `git init`, create initial commit capturing the verified 235-test passing baseline.
- **Effort:** XS (< 5 minutes).
- **Prerequisites:** User authorization.
- **Verification:** `git status` reports clean working tree on `main` branch.

#### BL-002: Task Planning Generative Intent vs. Regex Separation
- **Priority:** P1 (Core Planning Correctness)
- **Problem (DEF-001):** Compound regexes match generative instructions like `"Open Notepad and type a thank-you letter to Bob"` and literally type `"a thank-you letter to Bob"` into Notepad.
- **Files Affected:** `src/core/task-planner.js`
- **Existing Implementation to Preserve:** Deterministic offline regexes for explicit commands (e.g. `system info`, `list files`, `read file <path>`).
- **Proposed Smallest Safe Change:**
  1. Add an intent classifier in `_detectCompoundIntent` checking if the text argument is a quoted literal string or an open-ended topic.
  2. If the user prompt is an open-ended generation request, invoke the LLM to draft the content before assembling the `desktop_type_text` step.
- **Effort:** M (1 day).
- **Acceptance Criteria:**
  - "Open Notepad and type 'hello world'" types "hello world".
  - "Open Notepad and type a thank-you letter to Bob" drafts a complete letter and types the letter content into Notepad.
- **Verification:** Automated unit test in `tests/core/natural-language-eval.test.js`.

---

### Workstream 2: Native Tool/Function Calling Schemas

#### BL-003: Native Model Tool/Function Calling Schemas
- **Priority:** P1 (Execution Reliability)
- **Problem (DEF-002):** The planner prompts the model for raw JSON strings in markdown and parses via regex. This causes hallucinations, JSON syntax errors, and breaks on complex parameter types.
- **Files Affected:** `src/providers/provider-adapter.js`, `src/core/task-planner.js`
- **Proposed Smallest Safe Change:**
  1. Wire `ToolRegistry` schemas into `providerAdapter.complete({ tools })`.
  2. In `_callGemini`, pass `tools.functionDeclarations`.
  3. In `_callOpenAiCompatible`, pass `tools: [{ type: 'function', function: { name, description, parameters } }]`.
  4. Parse structured `tool_calls` returned directly by the API.
- **Effort:** M (1–2 days).
- **Prerequisites:** BL-002.
- **Verification:** Unit tests verifying schema serialization and tool_call deserialization for Gemini and OpenAI providers.

---

### Workstream 3: Multimodal Vision Feedback & Screenshot Grounding

#### BL-004: Multimodal Vision Feedback & Screenshot Grounding
- **Priority:** P1 (Visual Verification)
- **Problem (DEF-003):** Screenshots captured by `desktop_take_screenshot` and `browser_screenshot` cannot be passed to or understood by LLMs.
- **Files Affected:** `src/providers/provider-adapter.js`, `src/core/task-coordinator.js`
- **Proposed Smallest Safe Change:**
  1. Extend `ProviderAdapter` to support image payload parts (`inlineData` for Gemini, `image_url` for OpenAI).
  2. Add visual verification tool `visual_verify_screen` taking a screenshot and prompt, querying the vision model to verify state or locate coordinates.
- **Effort:** L (2 days).
- **Prerequisites:** BL-003.
- **Verification:** Mock vision response test verifying base64 image encoding and coordinate extraction.

---

### Workstream 4: Persistent Browser Profile & Authentication Sessions

#### BL-005: Persistent Playwright Browser Profile & Auth Sessions
- **Priority:** P1 (User Web Workflows)
- **Problem (DEF-004):** `BrowserManager` uses ephemeral `newContext()`, discarding logins on exit.
- **Files Affected:** `src/tools/browser-manager.js`
- **Proposed Smallest Safe Change:**
  1. Add `userDataDir` in `path.join(appDataDir, 'browser-profile')`.
  2. Switch from `chromium.launch() + newContext()` to `chromium.launchPersistentContext(userDataDir, { ... })`.
  3. Preserve download isolation and multi-tab management.
- **Effort:** S (0.5 day).
- **Prerequisites:** BL-001.
- **Verification:** Integration test setting a cookie in one test, closing context, reopening, and confirming cookie persists.

---

### Workstream 5: Dynamic Mid-Flight Replanning & Recovery

#### BL-006: Dynamic Mid-Flight Replanning & Recovery Loop
- **Priority:** P2 (Resilience)
- **Problem:** If a multi-step task encounters an unexpected error at step 2, it halts without attempting alternative tools or recovery actions.
- **Files Affected:** `src/core/task-coordinator.js`
- **Proposed Smallest Safe Change:**
  When a step fails, feed the error and executed steps back to `TaskPlanner.plan()` to generate an alternative recovery step before giving up.
- **Effort:** M (1–2 days).
- **Prerequisites:** BL-003.
- **Verification:** Test simulating a missing element in Notepad causing fallback to launching a fresh window.

---

### Workstream 6: Multi-Monitor Companion Window Polish

#### BL-007: Multi-Monitor Companion Snapping & Bounds Clamping
- **Priority:** P2 (Usability)
- **Problem:** On multi-monitor setups, dragging the floating companion near screen edges can occasionally snap back to the primary display.
- **Reuse Candidate:** Adapt IsmetBuddy multi-monitor screen geometry logic.
- **Files Affected:** `src/companion/floating-companion-window.js`
- **Effort:** S (0.5 day).
- **Prerequisites:** BL-001.
- **Verification:** Test passing coordinates on secondary display and verifying window bounds clamp within active monitor workArea.

---

### Workstream 7: Offline Speech Recognition via whisper.cpp

#### BL-008: Offline Local Speech-to-Text via whisper.cpp CLI
- **Priority:** P3 (Privacy & Offline Capability)
- **Problem:** Web Speech API relies on Windows online speech services on some installations.
- **Reuse Candidate:** `whisper.cpp` (MIT License) with `ggml-tiny.en.bin` model.
- **Files Affected:** `src/voice/speech-recognition.js`, `electron-builder.yml`
- **Effort:** M (1–2 days).
- **Prerequisites:** BL-001.
- **Verification:** Test transcribing a 3-second test WAV file locally without internet connection.

---

### Workstream 8: Student & Productivity Tailored Workflows

#### BL-009: Student & College Portal Dedicated Workflow Modules
- **Priority:** P3 (Product Vision)
- **Problem (REQ-036):** General browser tools require detailed step-by-step instructions. Student workflows (e.g. checking assignment deadlines, downloading syllabus, opening lecture playlists) need high-level commands.
- **Files Affected:** `src/tools/workflow-tools.js` (new module)
- **Prerequisites:** BL-005 (Persistent browser authentication).
- **Effort:** L (2–3 days).
- **Verification:** End-to-end scripted workflow accessing test portal mock.

---

### Workstream 9: Optional MediaPipe Webcam Gesture Control

#### BL-010: MediaPipe Webcam Gesture Control
- **Priority:** P4 (Advanced Polish)
- **Problem:** Users cannot interact with the fairy companion via camera gestures (e.g. waving hello).
- **Reuse Candidate:** `@mediapipe/tasks-vision` (Apache 2.0).
- **Files Affected:** `src/companion/companion.html`, `src/companion/companion-app.js`
- **Effort:** L (2–3 days).
- **Prerequisites:** BL-007.
- **Verification:** Gesture event emitter test verifying wave triggers `happy` fairy emotion.

---

## 3. Workstream Execution Rules & Boundaries

1. **Strictly Sequential Execution:**
   - **Workstream 1 MUST be executed first.** It resolves the primary safety blocker (Git) and the primary user-facing defect (literal typing vs generative content).
   - Workstream 2 and Workstream 3 touch the `TaskPlanner` and `ProviderAdapter` pipeline; they must run sequentially after Workstream 1.
2. **Parallel Prohibitions:**
   - Do NOT run Workstream 2 (native function calling) in parallel with Workstream 3 (vision) because both modify `ProviderAdapter.complete()`.
   - Do NOT run Workstream 4 (persistent browser) in parallel with Workstream 8 (student workflows).
