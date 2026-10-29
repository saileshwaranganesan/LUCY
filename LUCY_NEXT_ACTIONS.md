# L.U.C.Y. — Prioritized Dependency-Aware Next Actions Plan

> **Planning Timestamp:** October 29, 2026  
> **Repository Context:** `c:\Users\admin\Desktop\LUCY`

---

## 1. Immediate Blockers (Phase 1)

### Task ACT-001: Physical Microphone & Audible Speech Manual Acceptance Gate
* **Task ID:** `ACT-001`
* **Priority:** `P0 — CRITICAL BLOCKER`
* **Problem Statement:** The three core voice defects (TTS persistence reversion, 22s speech latency, and wake-word physical mic failure) have verified code fixes in the working tree and pass synthetic/Electron tests, but have not yet been evaluated by the human operator using real physical speakers and room acoustics.
* **Evidence:** `tests/voice/voice-recovery-execution.test.js` passes 8/8; `scratch/verify-live-ab-acceptance.js` passes all 10 stages in Electron. On disk, `%APPDATA%\lucy-desktop-assistant\voice-config.json` currently has `"ttsEngine": "kokoro"` from an earlier run.
* **Required Actions:**
  1. Operator launches application: `npm start`.
  2. Open Settings (gear icon in navigation header).
  3. Confirm **TTS Engine** dropdown is set to **Windows Speech (SAPI5)**. This triggers `persistVoiceSettings()` and writes `"ttsEngine": "windows-speech"` to disk.
  4. Fully close L.U.C.Y. via the **Exit L.U.C.Y.** tray or HUD button.
  5. Relaunch `npm start`. Open Settings and verify SAPI5 is still selected (confirming disk persistence).
  6. Speak **"Hey Lucy"** into the physical laptop microphone from 40–60 cm distance.
  7. Verify:
     - Companion fairy glows and activates.
     - L.U.C.Y. responds audibly through Windows Speech in under 1 second.
* **Dependencies:** None.
* **Risks:** Extremely noisy ambient environments or muted Windows microphone permissions could block audio capture.
* **Acceptance Criteria:**
  - [ ] App exits and relaunches with SAPI5 retained.
  - [ ] "Hey Lucy" wakes the assistant on first or second spoken utterance.
  - [ ] Speech response begins audibly within 1.0 second.
* **Relevant Existing Tests:** `tests/voice/voice-recovery-execution.test.js`, `scratch/verify-live-ab-acceptance.js`.
* **Physical Device Verification Required:** **YES (Mandatory)**.
* **Suggested Antigravity Tools / Skills:** Pair programming with Antigravity chat; use `systematic-debugging` if acoustic thresholds need fine-tuning.

---

## 2. Core Reliability Work (Phase 2)

### Task ACT-002: Git Working Tree Commit & Push
* **Task ID:** `ACT-002`
* **Priority:** `P1 — HIGH`
* **Problem Statement:** The working tree contains verified voice fixes, test environment isolation, documentation consolidation, and clutter cleanup. These should be committed and synchronized to `master`.
* **Evidence:** `git status` shows clean tracking, 23/23 flow tests pass, 66/66 security tests pass, 163/163 desktop tests pass, 32/32 packaging tests pass.
* **Required Actions:**
  1. Inspect `git diff` for final sanity check.
  2. Stage the verified files and commit with a structured commit message.
  3. Push to `origin/master`.
* **Dependencies:** Verification pass.
* **Risks:** Remote push failure if credentials are not configured.
* **Acceptance Criteria:**
  - [ ] `git push origin master` completes with exit code 0.
  - [ ] Working tree is clean.
* **Relevant Existing Tests:** `npm run test:security`, `npm run test:flow`, `npm run test:packaging`.
* **Physical Device Verification Required:** No.
* **Suggested Antigravity Tools / Skills:** `code-review` skill, `verification-before-completion`.

---

### Task ACT-003: Flow Test Environment Isolation Guard (`ELECTRON_RUN_AS_NODE`)
* **Task ID:** `ACT-003`
* **Priority:** `P2 — RESOLVED`
* **Status:** **COMPLETED IN CLEANUP**
* **Summary:** Sanitized child process environments in `tests/flow/single-instance.test.js` and `tests/flow/smoke-electron.test.js`. `npm run test:flow` now passes 23 / 23 tests (100%) in all terminal sessions.

---

## 3. Security and Quality Improvements (Phase 3)

### Task ACT-004: Ralph Windows Batch Wrapper Line-Ending Normalization
* **Task ID:** `ACT-004`
* **Priority:** `P3 — LOW`
* **Problem Statement:** `C:\Users\admin\.gemini\bin\ralph.cmd` was saved with LF line endings, causing Windows `cmd.exe` to fail with `The system cannot find the batch label specified - status`.
* **Evidence:** `ralph.ps1 status` passes in PowerShell; `ralph.cmd status` fails in `cmd.exe`.
* **Required Changes:**
  1. Open `C:\Users\admin\.gemini\bin\ralph.cmd`.
  2. Re-save with Windows CRLF (`\r\n`) line endings.
* **Dependencies:** None.
* **Risks:** None.
* **Acceptance Criteria:**
  - [ ] `cmd.exe /c "C:\Users\admin\.gemini\bin\ralph.cmd status"` prints `[Ralph Status: Inactive]` and exits 0.
* **Relevant Existing Tests:** None (CLI wrapper).
* **Physical Device Verification Required:** No.
* **Suggested Antigravity Tools / Skills:** Direct file edit.

---

### Task ACT-005: Packaged Release Smoke Verification
* **Task ID:** `ACT-005`
* **Priority:** `P2 — MEDIUM`
* **Problem Statement:** Ensure the release build in `dist-release/win-unpacked` includes the latest voice recovery code and does not regress on packaging invariants.
* **Evidence:** Previous build in `dist-release` dates to Oct 19, 2026.
* **Required Changes:**
  1. Execute `npm run package:dir`.
  2. Run `npm run smoke:packaged`.
  3. Verify all 12 smoke tests pass on the rebuilt distribution.
* **Dependencies:** `ACT-001`, `ACT-002`.
* **Risks:** Rebuilding packages takes 2–3 minutes of CPU time.
* **Acceptance Criteria:**
  - [ ] `npm run smoke:packaged` reports 12 / 12 PASS.
  - [ ] `sql.js` ASAR bundling and UIA worker extraction verified.
* **Relevant Existing Tests:** `scripts/smoke-test-packaged-app.js`, `tests/packaging/packaging-production.test.js`.
* **Physical Device Verification Required:** No.
* **Suggested Antigravity Tools / Skills:** `rea-investigate`.

---

## 4. UI and Usability Backlog (Phase 4)

### Task ACT-006: Settings Center Voice Engine Status Indicator
* **Task ID:** `ACT-006`
* **Priority:** `P3 — LOW`
* **Problem Statement:** The Settings Center currently shows a dropdown for TTS engine, but lacks real-time latency feedback or an explicit badge indicating whether native Windows SAPI5 or Kokoro-82M is currently loaded.
* **Evidence:** User confusion arose regarding whether SAPI5 was active or if Kokoro was running in the background.
* **Required Changes:**
  1. In `src/ui/index.html` (Voice & Audio Settings Tab), add an active engine status chip: `<span id="activeEngineStatusChip" class="badge">SAPI5 Active (Sub-second)</span>`.
  2. In `src/ui/app.js` (`updateEngineUiVisibility`), update the chip text and color when switching between engines.
* **Dependencies:** `ACT-001`.
* **Risks:** Minor DOM cosmetic update.
* **Acceptance Criteria:**
  - [ ] Selecting SAPI5 displays green "Windows SAPI5 (Fast, <1s)" chip.
  - [ ] Selecting Kokoro displays purple "Kokoro-82M Neural (CPU, High Latency)" chip.
* **Relevant Existing Tests:** `tests/ui/settings-consolidation.test.js`.
* **Physical Device Verification Required:** No.
* **Suggested Antigravity Tools / Skills:** `frontend-design`, `playwright-cli`.

---

## 5. Optional Future Capabilities (Phase 5 — Long Term)

### Task ACT-007: Kokoro-82M INT8 ONNX Quantization & Thread Optimization
* **Task ID:** `ACT-007`
* **Priority:** `P4 — DEFERRED`
* **Problem Statement:** While Windows SAPI5 provides instant speech (564 ms), some users may prefer Kokoro's neural voice quality if its latency could be brought under 2.5 seconds on CPU.
* **Evidence:** Kokoro currently runs unquantized FP32 ONNX weights on CPU, taking 17s.
* **Required Changes:**
  1. Apply INT8 dynamic quantization to `af_bella.onnx` using `onnxruntime.quantization`.
  2. Benchmark inference latency on Intel Core i5-1335U.
* **Dependencies:** `ACT-001`, `ACT-002`.
* **Risks:** Neural audio quality degradation if quantization is too aggressive.
* **Acceptance Criteria:**
  - [ ] Cold Kokoro synthesis under 3.5 seconds on 15W CPU.
* **Relevant Existing Tests:** `tests/voice/kokoro-tts.test.js`.
* **Physical Device Verification Required:** No.
* **Suggested Antigravity Tools / Skills:** Python ONNX tooling.
