# L.U.C.Y. — Comprehensive Open-Source Reuse Matrix
**Learning, Understanding, and Creating Yourself**  
**Engineering Workstream 05: Provenance, Licensing & Adaptation Review**  

**Audit Date:** 2026-10-13  
**Auditor:** Antigravity Autonomous Engineering & Audit Agent  
**Taxonomy Classifications:**  
- **Keep and reuse:** Directly integrated, pinned, and actively operational in production.  
- **Adapt through an isolated adapter:** Core logic or algorithms adapted and wrapped behind clean L.U.C.Y. interfaces.  
- **Replace with a better-supported solution:** Evaluated and replaced with a lighter, safer, or more reliable implementation.  
- **Retain only as a reference:** Architecture or flow studied; code not integrated.  
- **Reject, with a clear reason:** Formally excluded due to architectural violations, security flaws, or license entanglements.  

---

## 1. Upstream Candidate Evaluation Matrix

| Candidate Project / Repository | Upstream License | Upstream Scope & Tech Stack | Actual Integration Status in L.U.C.Y. | Capabilities Integrated / Adapted | Flaws, Risks or Violations Rejected | Final Recommendation & Rationale |
|---|---|---|:---:|---|---|---|
| **`haowenGuo/AILIS`** | MIT (Code) / pixiv Inc. Proprietary (Motion Assets) | Electron, React/Vite, multi-agent coordinator, BM25 memory, Web Speech, SAPI5, coordinate OS control, anime VRoid | **Adapted through an isolated adapter** (present locally in `reference/AILIS`, 70.3 MB) | Adapted BM25 lexical retriever algorithm ($k_1=1.2, b=0.75$) with exact phrase boosting; adapted spoken text markdown cleaner; adapted SAPI5 speech synthesis candidate patterns; adapted checkpoint schema. | **REJECTED:** Insecure Base64 secret storage (`SECRET_PROTECTION = 'local-file-base64'`); dry-run tool bypass in `ailis-computer-tool.cjs`; blind coordinate mouse clicks; anime girl avatar (`model.vroid`); pixiv Inc. proprietary commercial motion licenses; competing dual-agent loops. | **Adapt & Retain as Reference.** Modular algorithms safely adapted with critical security fixes. Core assistant framework rejected to preserve single authority. |
| **`microsoft/playwright`** (`playwright@^1.64.0`) | Apache-2.0 | Node.js headless/headful browser automation engine with auto-waiting locators | **Keep and reuse** (installed in `node_modules/playwright-core`) | Wrapped inside `src/tools/browser-manager.js` and `browser-tools.js`. Detects local Chrome/Edge channels on Windows; auto-waits locators; extracts visible text and links; fills forms; captures screenshots. | **REJECTED:** Unrestricted autonomous execution without user consent. Wrapped behind `PermissionAuthority` confirmation gates, mechanical dry-run isolation, password secret redaction, and CAPTCHA fail-closed detection. | **Keep and reuse.** Mature, battle-tested, zero-download integration with Windows system browsers. |
| **`floatingbrij/desktop-pilot-mcp`** (WinApp MCP / Desktop Pilot) | MIT | .NET 8 / FlaUI Model Context Protocol server for Windows UI Automation | **Replace with a better-supported solution** (studied and empirically probed) | Reused Windows UI Automation patterns (`ValuePattern`, `InvokePattern`, `TogglePattern`) and accessibility hierarchy inspection concepts. | **REJECTED:** 152 MB self-contained binary; fails with `No windows found on desktop` when executed in isolated desktop stations (`exebox-*` vs `WinSta0\default`). Replaced with native 18 KB C# worker (`LucyUiaWorker.cs` / `.exe`) compiled via standard Windows `csc.exe` with early `WinSta0\default` thread desktop switching. | **Replace with lightweight native worker.** The 18 KB `LucyUiaWorker.exe` provides 100% offline, zero-download desktop automation with $<10\text{ms}$ STDIO latency. |
| **`ARPAHLS/avatar`** (AVATAR) | MIT | Electron + Three.js (`@pixiv/three-vrm`) transparent desktop overlay with audio lip-sync | **Adapted through an isolated adapter** (studied architecture) | Reused Electron transparent, borderless, always-on-top window configuration (`src/companion/floating-companion-window.js`) and Three.js WebGL canvas pipeline. | **REJECTED:** Heavy humanoid VRM avatar stack (`@pixiv/three-vrm`, 45 MB bundle); humanoid anime character models. Replaced with lightweight Three.js glTF loader and Quaternius fantasy dragon. | **Adapt window & WebGL patterns; Replace avatar model.** Achieves responsive 3D creature companion without avatar bloat. |
| **`Quaternius Fantasy Monsters`** (`dragon.glb`) | Creative Commons Zero v1.0 Universal (CC0 1.0 - Public Domain) | Low-poly 3D animated fantasy creature meshes and skeletal animation clips | **Keep and reuse** (bundled in `src/companion/assets/dragon.glb`, 324 KB) | Bundled 324 KB low-poly dragon with 5 skeletal animations (`Idle`, `Fly`, etc.), clean textures, and procedural lighting response. | None. 100% legally unencumbered public domain asset. Verified via `CREDITS.md` and `LICENSE.txt`. | **Keep and reuse.** Perfect alignment with cute fantasy creature identity; zero licensing friction. |
| **`mrdoob/three.js`** (`three@0.186.1`) | MIT | WebGL 3D scene graph, camera, lighting, and animation mixer engine | **Keep and reuse** (vendored in `src/companion/vendor/three/`) | Core scene renderer, perspective camera, ambient & mood-reactive point lights, `GLTFLoader`, `AnimationMixer`, starlight particles motes. Vendored to protect against `electron-builder` pruning of `examples/jsm`. | None. Gold standard WebGL engine. | **Keep and reuse.** Lightweight and resilient inside Electron sandbox. |
| **`sandraschi/windows-computer-use-mcp`** | Apache-2.0 / MIT | Python + `pywinauto` desktop automation MCP server | **Reject, with a clear reason** | None. | **REJECTED:** Requires a persistent Python runtime, multi-gigabyte virtual environments, and heavy `pywinauto` dependencies. Incompatible with L.U.C.Y.'s lightweight zero-download Windows architecture. | **Reject.** Fully superseded by native `LucyUiaWorker.exe`. |
| **`wangeguo/pet`** | Apache-2.0 | Rust + Bevy engine + Iced GUI desktop pet with autonomous AI agent loop | **Reject, with a clear reason** | None. | **REJECTED:** Built in Rust/Bevy; requires external compiled daemon. Most importantly, introduces an independent "intent-aware AI brain", directly violating L.U.C.Y.'s single-authority architectural rule. | **Reject.** Violates core single-brain invariant. |
| **`woooooooooolf/deskpet3d`** | MIT | C / Raylib lightweight desktop pet | **Reject, with a clear reason** | None. | **REJECTED:** Compiled C / Raylib binary; introduces fragile native compilation toolchains and cross-process IPC friction inside Electron. | **Reject.** Superseded by Three.js WebGL inside Electron. |
| **`SixOfFive/DesktopPet`** | Open Source | C# 2D sprite desktop pet | **Retain only as a reference** | None. | **REJECTED:** Low-fidelity 2D bitmap sprites; does not provide modern 3D skeletal mesh rendering. | **Retain only as a reference.** |
| **`shravan-kapare/ASTRA`** | MIT | Python voice-driven desktop assistant | **Retain only as a reference** | Studied pipeline flow. | **REJECTED:** Python audio stack; requires external Python interpreter. L.U.C.Y.'s native Web Speech / SAPI5 architecture provides zero-download voice out of the box. | **Retain only as a reference.** |
| **`electron-userland/electron-builder`** (`^26.15.3`) | MIT | Mature Windows installer and packaging toolchain | **Keep and reuse** (installed as devDependency) | Configured in `electron-builder.yml`. Produces NSIS per-user installer (`87.8 MB`) and portable executable (`87.5 MB`). Handles ASAR packing, unpacked extra resources, and data-protection defaults. | None. Standard packaging solution for Electron. | **Keep and reuse.** Verified across live installation, reinstallation, and uninstallation. |

---

## 2. Open-Source Component Provenance & Legal Compliance

L.U.C.Y. maintains complete legal attribution in [NOTICE](file:///C:/Users/admin/Desktop/LUCY/NOTICE) and [LICENSE](file:///C:/Users/admin/Desktop/LUCY/LICENSE):

1. **L.U.C.Y. Core Codebase:** Released under the MIT License.
2. **Microsoft Playwright:** Apache-2.0. Attribution preserved; notice included in distribution.
3. **Three.js:** MIT License. Attribution preserved in vendored source directory.
4. **Quaternius Animated Fantasy Dragon:** Creative Commons Zero v1.0 Universal (Public Domain). Complete attribution preserved in `src/companion/assets/LICENSE.txt`.
5. **AILIS Attribution:** MIT License. Attribution preserved for adapted BM25 and voice cleaner logic.
6. **Proprietary Licenses:** Zero proprietary, non-commercial, or commercial-use restricted assets (such as pixiv Inc. motion packs) are present in L.U.C.Y.'s production distribution.
