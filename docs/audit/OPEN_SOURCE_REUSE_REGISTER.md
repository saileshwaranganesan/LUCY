# L.U.C.Y. — Open-Source Reuse & License Assessment Register

**Audit Date:** October 14, 2026  
**Auditor:** Antigravity AI Engineering / Lead Architect & Open-Source Researcher  
**Scope:** Rigorous evaluation of 7 candidate open-source projects for architectural reuse, licensing compliance, asset restrictions, and integration feasibility.

---

## 1. Candidate Evaluation Summary

| Candidate Repository | Canonical License | Asset / Model License Caveats | Primary Language / Runtime | Windows & Electron Compatibility | Verdict & Action |
| :--- | :---: | :--- | :--- | :--- | :--- |
| **1. Microsoft UFO** | **MIT** | Microsoft Trademark Notice; CLA required | Python 3.10+ (pywinauto / UIA / Vision) | Windows Native; requires Python subprocess in Electron | **Design Inspiration Only (Do Not Bundle Python)** |
| **2. Browser Use** | **MIT** | Requires Playwright + LangChain/CDP | Python 3.11+ | Windows Compatible; high Python runtime overhead | **Design Inspiration Only (Preserve Native JS Playwright)** |
| **3. Lumi Deskpet** | N/A (Missing) | Missing / private repository; port of Outcore Lumi | C / Embedded or Godot | Incompatible / Non-existent | **Reject (Repository Inaccessible)** |
| **4. IsmetBuddy** | **MIT** | CC0 / Permissive character assets | JavaScript / Electron | 100% Electron & Windows Compatible | **Adapt Small Patterns (Multi-monitor Drag & Snap)** |
| **5. whisper.cpp** | **MIT** | OpenAI Whisper models: MIT; ggml quantization | C / C++ (WASM or CLI binary) | Excellent Windows & Electron WASM / CLI support | **Adapt Focused Component (Offline STT Option)** |
| **6. openWakeWord** | **Apache 2.0** (Code) | **CRITICAL: Pre-trained Models are CC BY-NC-SA 4.0 (NonCommercial)** | Python / ONNX Runtime | ONNX runtime compatible; licensing barrier for commercial distribution | **Reject / Defer (NonCommercial Model Restriction)** |
| **7. MediaPipe** | **Apache 2.0** | Model cards vary; WebAssembly models permissive | C++ / WebAssembly / JavaScript | Compatible via `@mediapipe/tasks-vision` in WebAssembly | **Defer (Camera Gesture Control is P4 Polish)** |

---

## 2. Detailed Technical & Legal Assessments

---

### Candidate 1: Microsoft UFO (UI-Focused Agent)
- **Repository:** `https://github.com/microsoft/UFO`
- **Canonical License:** MIT License (Copyright © Microsoft Corporation). Inspected.
- **Asset / Trademark Caveats:** Microsoft trademarks and logos are strictly reserved. Code contributions require agreeing to the Microsoft Contributor License Agreement (CLA).
- **Core Feature Worth Reusing:** Dual-agent architecture: `AppAgent` (selects target application and reads UI tree) and `HostAgent` (inter-application coordination), plus visual bounding-box overlay and UIA control filtering.
- **Language & Runtime:** Python 3.10+. Heavy dependencies: `pywinauto`, `torch`, `opencv-python`, `transformers`.
- **Windows / Electron Compatibility:** Works natively on Windows, but requires a full Python environment and ~3 GB of dependencies to execute.
- **Integration Feasibility & Conflicts:** Embedding UFO into L.U.C.Y. would introduce a massive Python runtime, breaking the self-contained Electron architecture and installer (`electron-builder` NSIS package is currently only 88 MB).
- **Recommendation:** **Design Inspiration Only.** Do NOT bundle UFO or Python. Adapt its dual-agent planning concepts and UIA control-filtering heuristics directly into L.U.C.Y.'s existing C# worker (`LucyUiaWorker.cs`) and JavaScript `TaskCoordinator`.

---

### Candidate 2: Browser Use (Web Agent for LLMs)
- **Repository:** `https://github.com/browser-use/browser-use`
- **Canonical License:** MIT License. Inspected.
- **Asset / Model Caveats:** No proprietary assets. Uses standard Playwright browser binaries.
- **Core Feature Worth Reusing:** DOM tree simplification, interactive element highlighting, and multi-tab state tracking.
- **Language & Runtime:** Python 3.11+. Dependencies include LangChain, Pydantic, Playwright Python.
- **Windows / Electron Compatibility:** Runs on Windows, but requires a separate Python daemon to interface with Electron.
- **Integration Feasibility & Conflicts:** L.U.C.Y. already has a robust, verified JavaScript Playwright implementation (`src/tools/browser-manager.js`) with 43 passing tests. Re-implementing in Python would be a severe regression in speed, package size, and maintainability.
- **Recommendation:** **Design Inspiration Only.** Preserve L.U.C.Y.'s native JavaScript Playwright architecture. Extract only the DOM indexing technique (numbering interactive buttons/links on the page for LLM selection) and implement it directly in `src/tools/browser-manager.js`.

---

### Candidate 3: Lumi Deskpet
- **Repository:** `https://github.com/sairin1202/lumi-deskpet`
- **Canonical License:** Inaccessible / Dead URL (HTTP 404). General community ports exist under independent repositories.
- **Source Code vs. Asset Licensing Separation:**
  - *Source Code:* Independent Godot / GDScript community implementations of desktop pets are commonly published under permissive open-source licenses (MIT or Unlicense).
  - *Bundled Character Assets:* The character **"Lumi"** is the protagonist of the copyrighted commercial video game ***Outcore: Desktop Adventure*** (developed by DoctorShinobi). The character name, design, sprite sheets, animations, and voice audio are **proprietary, copyrighted video game assets**. Regardless of a wrapper repository's MIT source code license, redistributing the Outcore character art in an assistant application constitutes copyright infringement without a commercial commercial license from DoctorShinobi.
  - *Architectural Conflict:* Godot-based desktop pets require bundling a standalone Godot engine binary or sub-process, conflicting with L.U.C.Y.'s lightweight, native HTML5 canvas and WebGL Electron architecture.
- **Recommendation:** **Reject.** Repository is unavailable, character IP is non-permissive, and embedding a secondary game engine runtime is unnecessary. L.U.C.Y.'s custom `CelestialFamiliarRenderer` fairy is already implemented, verified (12/12 companion tests pass), and 100% free of third-party IP restrictions.

---

### Candidate 4: IsmetBuddy (Electron Desktop Buddy)
- **Repository:** `https://github.com/berkecuhadar/IsmetBuddy`
- **Canonical License:** MIT License. Inspected.
- **Asset / Character Caveats:** Uses lightweight pixel animations. Ensure no unlicensed third-party sprites are imported.
- **Core Feature Worth Reusing:** Multi-monitor edge detection, transparent window click-through handling, and smooth tray minimization in Electron.
- **Language & Runtime:** Pure JavaScript / Electron. Matches L.U.C.Y.'s technology stack exactly.
- **Windows / Electron Compatibility:** 100% native compatibility. Zero additional runtime dependencies.
- **Integration Feasibility:** Minimal effort. Small snippets for window positioning across secondary displays can be adapted into `src/companion/floating-companion-window.js`.
- **Recommendation:** **Adapt Small Component.** Adapt its multi-monitor coordinate clamping and taskbar behavior into `FloatingCompanionWindow`. Do not import sprite assets.

---

### Candidate 5: whisper.cpp (High-Performance Speech Recognition)
- **Repository:** `https://github.com/ggml-org/whisper.cpp`
- **Canonical License:** MIT License. Inspected.
- **Asset / Model Caveats:** OpenAI Whisper models (`tiny.en`, `base.en`) are licensed under MIT. ggml quantization is permissible for commercial and open-source redistribution.
- **Core Feature Worth Reusing:** Fast, offline, private, zero-cloud speech-to-text running locally on CPU via WebAssembly or standalone Windows CLI binary (`whisper-cli.exe`).
- **Language & Runtime:** C/C++. Available as a pre-compiled Windows x64 binary or WASM binding.
- **Windows / Electron Compatibility:** High compatibility. Can be invoked as a lightweight child process or via WebAssembly inside Electron.
- **Integration Feasibility:** Low overhead (~40 MB for `tiny.en` quantized model). Does not require Python.
- **Recommendation:** **Adapt Focused Component (Offline STT).** Ideal for users requiring 100% offline speech recognition without relying on cloud Web Speech API. Bundle `whisper-cli.exe` and `ggml-tiny.en.bin` into `extraResources` as an optional local STT engine.

---

### Candidate 6: openWakeWord (Wake-Word Detection)
- **Repository:** `https://github.com/dscripka/openWakeWord`
- **Canonical License:**
  - **Source Code:** Apache 2.0. Inspected.
  - **Pre-trained Models:** **CC BY-NC-SA 4.0 (Creative Commons NonCommercial ShareAlike 4.0)**.
- **CRITICAL LEGAL FINDING:**
  The official pre-trained wake-word models (e.g. "Hey Jarvis", "Alexa") are restricted to **NonCommercial** use because they were trained on proprietary datasets. Shipping these model weights in a general-purpose desktop assistant would impose non-commercial licensing restrictions on the entire distribution or violate licensing if distributed commercially.
- **Language & Runtime:** Python / ONNX Runtime.
- **Recommendation:** **Reject / Defer.** Do not bundle openWakeWord pre-trained weights. If wake-word detection is needed in the future, train a custom model from scratch on permissible audio data or use a permissive keyword spotter. Push-to-talk (`REQ-026`) is already verified and privacy-safe.

---

### Candidate 7: MediaPipe (Vision & Gesture Control)
- **Repository:** `https://github.com/google-ai-edge/mediapipe`
- **Canonical License:** Apache 2.0 License. Inspected.
- **Asset / Model Caveats:** Official hand gesture and face landmark models are hosted permissively by Google under Apache 2.0.
- **Core Feature Worth Reusing:** Webcam hand gesture detection (e.g., waving to summon the fairy, holding palm to pause).
- **Language & Runtime:** Available natively in JavaScript via `@mediapipe/tasks-vision` using WebAssembly and WebGL.
- **Windows / Electron Compatibility:** Runs directly in the Electron renderer process using standard HTML5 `<video>` and WebGL canvas.
- **Integration Feasibility:** Medium. Adds ~15 MB of WASM and model files. Requires webcam permissions.
- **Recommendation:** **Defer to P4 (Advanced Polish).** Camera gesture control is a secondary capability. Core desktop automation, vision grounding, and planning correctness must take precedence.
