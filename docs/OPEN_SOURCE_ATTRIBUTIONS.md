# Open-Source Software Notices and Attributions

This document records all third-party open-source repositories and model assets investigated, reused, or rejected during the implementation of the L.U.C.Y. Windows desktop assistant (JARVIS HUD interface, Kokoro-82M Local Fairy Voice, and Desktop Companion).

---

## 1. Candidate Repositories Investigation Audit

| Repository / Asset | Declared License | Status | Investigation Result & Reuse Decision |
|---|---|---|---|
| **Axshatt/VirtualAssistant**<br>`https://github.com/Axshatt/VirtualAssistant` | **MIT License** | **REUSED** | **Selected & Adapted**: Reused Stark Industries JARVIS HUD layout principles, glowing cyan L-shaped corner brackets (`.jarvis-corner-bracket`), alternating scanline overlays (`.jarvis-scanlines`), sweep line radar scanning (`.jarvis-sweep-line`), and monospace typography styling. Extracted as lightweight CSS/HTML components without external framework dependencies. |
| **dengyie/OpenPet**<br>`https://github.com/dengyie/OpenPet` | **MIT License** | **REUSED** | **Selected & Adapted**: Reused transparent desktop pet layer architecture, tactile cursor grabbing feedback states (`cursor: grab`, `body.is-dragging { cursor: grabbing }`), and high-contrast frosted glassmorphic speech bubble styling. Adapted seamlessly into Lucy's desktop familiar window while preserving the canonical celestial fairy companion. |
| **Hexgrad / ONNX Kokoro-82M**<br>`https://github.com/hexgrad/kokoro` | **Apache-2.0 License** | **REUSED** | **Selected & Integrated**: Quantized INT8 ONNX model (`kokoro-v1.0.int8.onnx`, 108.8 MB) and dual female voice pack (`af_bella`, `af_sky`, 1,020 KB) integrated for 100% offline, free, local TTS with an on-demand child process worker. |
| **Microsoft Playwright**<br>`https://github.com/microsoft/playwright` | **Apache-2.0 License** | **REUSED** | **Selected & Integrated**: Core browser automation engine providing robust auto-waiting locators, DOM content extraction, form fills, `<select>` dropdown handling, directional scrolling, search, downloads, and multi-tab orchestration without coordinate clicking. |
| **Microsoft UI Automation (`LucyUiaWorker.cs`)**<br>`https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/` | **MIT / Public Domain** | **REUSED** | **Selected & Compiled**: Out-of-process JSON-over-stdio C# worker (`LucyUiaWorker.exe`) compiled via .NET `csc.exe` interacting with Windows accessibility and Win32 APIs for window focusing, app launching, element discovery, text entry, and clicking. |
| **Suketu-ADT/jarvis-ai**<br>`https://github.com/Suketu-ADT/jarvis-ai` | N/A | **REJECTED** | **Non-existent / Inaccessible**: Repository returned HTTP 404. Repository has either been deleted, renamed, or made private. Zero code reused. |
| **sairin1202/lumi-deskpet**<br>`https://github.com/sairin1202/lumi-deskpet` | N/A | **REJECTED** | **Non-existent / Inaccessible**: Repository returned HTTP 404. Repository has either been deleted, renamed, or made private. Zero code reused. |
| **SixOfFive/DesktopPet**<br>`https://github.com/SixOfFive/DesktopPet` | N/A | **REJECTED** | **Non-existent / Inaccessible**: Repository returned HTTP 404. Repository has either been deleted, renamed, or made private. Zero code reused. |
| **wangeguo/pet**<br>`https://github.com/wangeguo/pet` | **Apache-2.0 License** | **REJECTED** | **Incompatible Stack**: Implemented in Rust with Bevy 3D game engine and 3D glTF models. Lucy is built on Electron/Node.js/HTML5 Canvas and has a strict architectural mandate to preserve the 2D procedural celestial fairy companion (`CelestialFamiliarRenderer`). Zero code reused. |
| **sindresorhus/electron-store**<br>`https://github.com/sindresorhus/electron-store` | **MIT License** | **EVALUATED** | **Evaluated & Native Replacement**: Evaluated for persistent geometry; replaced with direct native JSON persistence (`companion-window-bounds.json` & `app-config.json`) with debounced filesystem flushing to prevent unneeded dependencies. |
| **Electron Project Patterns**<br>`https://github.com/electron/electron` | **MIT License** | **REUSED** | **Selected & Implemented**: Standard patterns for single-instance app lock (`requestSingleInstanceLock`), second-instance window restoring, system tray lifecycle, and Windows foreground lock penetration. |

---

## 2. Reused Components License Texts

### Axshatt/VirtualAssistant (MIT License)

```
MIT License

Copyright (c) Axshatt

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### dengyie/OpenPet (MIT License)

```
MIT License

Copyright (c) 2023 dengyie

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Kokoro-82M (Apache-2.0 License)

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   Copyright 2024 Hexgrad

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
