# L.U.C.Y. — Known Issues, Limitations & Open Backlog

> **Authoritative Document:** `docs/KNOWN_ISSUES.md`  
> **Last Updated:** October 29, 2026

---

## 1. Confirmed Issues & Subsystem Limitations

### 1.1 Physical Microphone Acoustic Room Acceptance Gate
* **Subsystem:** Hands-Free Wake-Word Detection (`src/voice/acoustic-wake-model.js`, `audio-recorder.js`)
* **Status:** Verified in code & live Electron runtime; awaiting operator physical confirmation.
* **Details:**
  * Automated regression tests (`tests/voice/voice-recovery-execution.test.js`) and the live Electron A/B test suite (`scratch/verify-live-ab-acceptance.js`) pass with calibrated sibilant/vowel gates, muted `GainNode` speaker isolation, and 6400 candidate windows.
  * Real-world room acoustics, distance variations (beyond 60 cm), and hardware microphone driver settings (e.g. Windows microphone boost) can only be confirmed by the human operator speaking into the physical microphone.
* **Operator Action:** Launch `npm start`, speak "Hey Lucy" at normal conversational volume (40–60 cm distance), and verify the fairy companion wakes up.

---

### 1.2 TTS Engine Persistence First-Launch Configuration Migration
* **Subsystem:** Voice Configuration Persistence (`src/ui/app.js`, `voice-config.json`)
* **Status:** Resolved in code; requires single UI selection to migrate legacy disk state.
* **Details:**
  * Prior to the fix in `src/ui/app.js`, `persistVoiceSettings()` overwrote `voice-config.json` with the HTML default (`"kokoro"`).
  * If the user previously ran L.U.C.Y., `%APPDATA%\lucy-desktop-assistant\voice-config.json` on disk may still contain `"ttsEngine": "kokoro"`.
  * The code fix now properly synchronizes the DOM select element and active engine on startup. Once the user selects **Windows Speech (SAPI5)** in Settings, the disk file is updated to `"windows-speech"`, and all subsequent launches will preserve it permanently.

---

### 1.3 Kokoro-82M Neural TTS CPU Inference Latency
* **Subsystem:** Local Neural TTS Service (`src/voice/kokoro-tts-service.js`, `kokoro-worker.py`)
* **Status:** Confirmed Hardware Limitation; SAPI5 selected as default high-speed alternative.
* **Details:**
  * Kokoro-82M runs full FP32 ONNX neural weights on the host CPU. On a 15W Intel Core i5-1335U, synthesis takes 17–25 seconds per response.
  * For instant conversational responses, **Windows Speech (SAPI5)** provides 564 ms sub-second audio output and requires zero GPU or token overhead.
  * **Future Work:** INT8 dynamic quantization (`onnxruntime.quantization`) will be evaluated in Phase 5 to reduce neural CPU latency under 3 seconds.

---

### 1.4 Unsigned Packaged Executables & SmartScreen Advisory (DEF-005B)
* **Subsystem:** Packaging & Distribution Trust (`dist-release/`)
* **Status:** Confirmed Ecosystem Limitation.
* **Details:**
  * Production installer binaries (`L.U.C.Y-Setup-0.1.0-win-x64.exe` and `L.U.C.Y-Portable-0.1.0-win-x64.exe`) are unsigned (`Status: NotSigned`).
  * Microsoft Defender SmartScreen displays an "Unknown Publisher" advisory when downloading or launching from a browser.
  * **Mitigation:** Cryptographic SHA-256 checksums are documented in `release-manifest.json` and `SHA256SUMS.txt`, verified automatically via `npm run release:verify`.

---

### 1.5 External Roadmap Integrations (Phone, WhatsApp, Shopping)
* **Subsystem:** External Integrations (`src/core/task-planner.js`)
* **Status:** Planned / Unimplemented Specification.
* **Details:**
  * Phone calling, WhatsApp messaging, and dedicated shopping workflows are conceptual roadmap features. There are no backend APIs or external communication clients for these services in the codebase.
  * Natural language requests for these actions are routed through standard desktop application launch tools (`SAFE_APP_ALLOWLIST`) or browser automation.
