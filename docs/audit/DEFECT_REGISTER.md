# L.U.C.Y. — Defect Register & Forensic Vulnerability Analysis

**Audit Date:** October 14, 2026  
**Auditor:** Antigravity AI Engineering / QA Lead & Application Security Reviewer  
**Total Tracked Defects:** 6 (Confirmed & Evidence-Backed)

---

## 1. Confirmed Defect Summary

| Defect ID | Title | Severity | Impact Area | Confidence | Status |
| :--- | :--- | :---: | :--- | :---: | :---: |
| **DEF-001** | Task Planner Regex Precedence & Literal Content Extraction | **High (P1)** | Natural Language Planning & Execution | High (100%) | Confirmed via code inspection & test simulation |
| **DEF-002** | Absence of Native Tool/Function Calling Schemas | **High (P1)** | Model-to-Tool Dispatch & Reliability | High (100%) | Confirmed via `ProviderAdapter` & `TaskPlanner` inspection |
| **DEF-003** | Missing Screenshot-to-Vision Multimodal Feedback Loop | **Medium (P2)** | Desktop & Web Visual Verification | High (100%) | Confirmed: Models accept text only, no image inputs |
| **DEF-004** | Ephemeral Playwright Browser Contexts (No Persistent Auth) | **Medium (P2)** | Web Workflows & User Portal Logins | High (100%) | Confirmed: `newContext()` used without `userDataDir` |
| **DEF-005** | Workspace Missing Version Control (No Git Repository) | **Medium (P2)** | Configuration & Change Safety | High (100%) | Confirmed via `git status` exit code 1 |
| **DEF-006** | Orphaned Background Packaged App Process (`LUCY.exe`) | **Low (P3)** | Process Contention & Port Safety | High (100%) | Confirmed via PowerShell `Get-Process` |

---

## 2. Detailed Forensic Analysis

---

### DEF-001: Task Planner Regex Precedence & Literal Content Extraction

- **Severity:** High (P1)
- **Component:** `src/core/task-planner.js` (lines 105–115, 370–394)
- **Requirement Linked:** REQ-001, REQ-002
- **Description:**
  In `TaskPlanner.prototype.plan()`, hardcoded regular expressions in `_detectCompoundIntent` and `_detectDirectIntent` execute **before** invoking the AI model. When a user issues a generative multi-step instruction such as:
  > *"Open Notepad and type a thank-you letter to Bob."*
  The regex on line 371:
  `/(?:open|launch|start)\s+notepad\s+(?:and|then)\s+(?:type|enter|write)\s+['"]?([^'"]+?)['"]?/i`
  matches the request and captures `"a thank-you letter to Bob"` as the literal text parameter `textToType`.
- **Reproduction Steps:**
  1. Call `planner.plan('Open Notepad and type a thank-you letter to Bob')`.
  2. Inspect the resulting plan step for `desktop_type_text`.
  3. Observe `params.text` is `"a thank-you letter to Bob"`.
- **Expected Behavior:**
  The assistant should recognize that `"a thank-you letter to Bob"` requires generative composition. It should use the LLM to draft the letter, and then pass the drafted text to Notepad.
- **Actual Behavior:**
  L.U.C.Y. launches Notepad and literally types the phrase `"a thank-you letter to Bob"`.
- **Smallest Safe Correction:**
  1. Introduce an intent discriminator that detects whether the requested text is a literal string (in quotes) or a generative topic prompt.
  2. If the text prompt is generative, route to the LLM to synthesize the content before constructing the typing step, or allow the LLM to construct the full plan when an API key is available.

---

### DEF-002: Absence of Native Tool/Function Calling Schemas

- **Severity:** High (P1)
- **Component:** `src/core/task-planner.js` (lines 156–205), `src/providers/provider-adapter.js` (lines 204–257)
- **Requirement Linked:** REQ-003
- **Description:**
  When `TaskPlanner` uses an LLM for structured planning, it concatenates tool descriptions into a system prompt string (line 157) and asks the model to output a JSON object in text. It then parses the string using regex-based extraction (`_extractJson()`).
  Modern frontier models (Gemini 2.0 Flash, GPT-4o, Claude 3.5, Mistral) support native function/tool calling schemas directly in their API protocols (`tools: [{ functionDeclarations }]`). While `_callGemini` formats declarations in line 238, the planner does not use this mechanism; instead, it passes empty `tools: []` and relies on markdown JSON prompting.
- **Reproduction Steps:**
  1. Inspect `TaskPlanner.prototype.plan()` lines 176–182:
     ```javascript
     const res = await this.providerAdapter.complete({
         messages: [
             { role: 'system', content: systemPrompt },
             { role: 'user', content: trimmedRequest }
         ]
     });
     ```
  2. Observe that `tools` parameter is omitted.
  3. Observe line 195: `const parsed = this._extractJson(res.content);`.
- **Expected Behavior:**
  The model should receive registered tool schemas natively and return structured `tool_calls` with type-validated arguments, preventing JSON syntax breakage, markdown fencing hallucinations, and parsing errors.
- **Actual Behavior:**
  Planning relies on fragile text JSON extraction from free-form model completions.
- **Smallest Safe Correction:**
  Pass `tools: availableTools` directly to `providerAdapter.complete()`, handle `response.toolCalls` in the adapter response, and validate tool arguments against `ToolRegistry` schemas.

---

### DEF-003: Missing Screenshot-to-Vision Multimodal Feedback Loop

- **Severity:** Medium (P2)
- **Component:** `src/providers/provider-adapter.js` (lines 126–260), `src/tools/desktop-app-tools.js`
- **Requirement Linked:** REQ-012, REQ-013
- **Description:**
  Both `desktop_take_screenshot` and `browser_screenshot` successfully capture visual PNG buffers and write them to disk. However, `ProviderAdapter.complete()` only accepts an array of `{ role: string, content: string }`. There is zero support for passing base64 images (`inlineData` in Gemini or `image_url` in OpenAI format).
  As a result, L.U.C.Y. cannot "see" the screen. She can capture an image, but cannot ask the model: *"Where is the Submit button in this screenshot?"* or *"Did the application display an error dialog?"*.
- **Reproduction Steps:**
  1. Inspect `_callGemini` lines 218–220:
     ```javascript
     parts: [{ text: msg.content }]
     ```
  2. Inspect `_callOpenAiCompatible` lines 280–285:
     ```javascript
     content: msg.content
     ```
  3. No property exists for image parts or binary buffers.
- **Expected Behavior:**
  The provider layer should support multimodal messages with base64 image parts to enable visual grounding and post-action verification.
- **Actual Behavior:**
  Screenshots are saved as local artifacts without any visual intelligence loop.
- **Smallest Safe Correction:**
  Extend `ProviderAdapter` message normalization to support `{ role, content, images: [{ mimeType, data }] }`, formatting `inlineData` for Gemini and `image_url` for OpenAI-compatible endpoints.

---

### DEF-004: Ephemeral Playwright Browser Contexts (No Persistent Auth)

- **Severity:** Medium (P2)
- **Component:** `src/tools/browser-manager.js` (lines 68–78)
- **Requirement Linked:** REQ-014, REQ-015, REQ-036
- **Description:**
  `BrowserManager.ensureContext()` creates an in-memory browser context:
  ```javascript
  this.context = await this.browser.newContext({ ... });
  ```
  Every time L.U.C.Y. starts or closes the browser, all session cookies, local storage, and authentication states are discarded. This makes it impossible for L.U.C.Y. to perform real-world student workflows (e.g., accessing college portals, Google Docs, WhatsApp Web, or YouTube Music) without requiring the user to re-authenticate and complete 2FA on every single run.
- **Reproduction Steps:**
  1. Launch browser via `browser_navigate` to a test site and store a cookie.
  2. Call `browserManager.close()`.
  3. Call `browser_navigate` again.
  4. Observe that the cookie is completely gone.
- **Expected Behavior:**
  The browser should use a dedicated persistent user data directory (e.g., `data/browser-profile`) via `chromium.launchPersistentContext()` so user sessions survive across assistant runs.
- **Actual Behavior:**
  All sessions are ephemeral; authentication vanishes on exit.
- **Smallest Safe Correction:**
  Add a `persistentContextDir` option to `BrowserManager` defaulting to `path.join(userDataDir, 'browser-profile')`, and launch with `chromium.launchPersistentContext()` when persistent mode is enabled.

---

### DEF-005: Workspace Missing Version Control (No Git Repository)

- **Severity:** Medium (P2)
- **Component:** Workspace root (`C:\Users\admin\Desktop\LUCY`)
- **Requirement Linked:** Safety & Change Management (Rule E)
- **Description:**
  The workspace `C:\Users\admin\Desktop\LUCY` contains no `.git` directory. Running `git status` fails with `fatal: not a git repository`.
- **Impact:**
  Without Git, there is no automatic rollback, diff tracking, or branch isolation. Any accidental modification or file corruption during future implementation work could cause unrecoverable loss.
- **Smallest Safe Correction:**
  User or agent should initialize Git (`git init`), create a `.gitignore` (which already exists in the repo), and commit the verified 235-test passing baseline as the initial commit (`git commit -m "chore: verified baseline v0.1.0"`).

---

### DEF-006: Orphaned Background Packaged App Process (`LUCY.exe`)

- **Severity:** Low (P3)
- **Component:** Operating System Process Table
- **Requirement Linked:** Process Isolation & Single Instance Lock
- **Description:**
  Process inspection revealed an installed instance of `C:\Users\admin\AppData\Local\Programs\LUCY\LUCY.exe` running in the background. While the single-instance lock (`SEC-004`) successfully prevents secondary processes from opening conflicting windows, background processes can lock files in `%APPDATA%\LUCY\memory` if pointing to the same data directory.
- **Smallest Safe Correction:**
  Document procedure to terminate background `LUCY.exe` before conducting live GUI testing.
