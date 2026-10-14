# L.U.C.Y. - Dependency and Risk Register

## 1. System Dependencies & Runtimes
| Dependency | Required Version | Detected / Installed | Status | Verification Evidence |
|---|---|---|---|---|
| Windows OS | Windows 10/11 x64 | Windows x64 | Verified | Native environment |
| Git | >= 2.30 | 2.36.1.windows.1 | Verified | Working |
| Node.js | >= 20.x | v24.12.0 | Verified | Node v24.12.0 |
| npm | >= 10.x | 11.6.2 | Verified | Package manager |
| Python | >= 3.10 | 3.13.12 | Verified | Python 3.13.12 |
| .NET Framework (csc.exe) | >= 4.0 | v4.0.30319 (Framework64) | Verified | Pre-installed Windows compiler used to build `LucyUiaWorker.exe` |
| Disk Space | >= 10 GB | ~77.8 GB Free | Verified | C: drive has 77.8 GB free |

## 2. Risk Register & Audited Findings
| ID | Risk Description | Severity | Likelihood | Audit Finding in Upstream | Mitigation Strategy in L.U.C.Y. | Status |
|---|---|---|---|---|---|---|
| R-001 | Plaintext/Base64 API key storage | Critical | High | Confirmed in `ailis-memory-store.cjs:19` (`SECRET_PROTECTION = 'local-file-base64'`) and `store.cjs:1596` | Replace with Windows DPAPI (`CryptProtectData`) wrapper; keys encrypted with user logon key | Fix Implemented |
| R-002 | Dry-run mode executing destructive tools | Critical | High | Confirmed in `ailis-computer-tool.cjs:3550` - `execute` does not check `dryRun` for `exec`, `write`, `delete` | Intercept at Central Tool Dispatcher; return simulated outcome without executing handler | Fix Implemented |
| R-003 | Hosted-runtime auth fail-closed gap | High | Medium | Confirmed missing auth checks in hosted runtime manager endpoints | Enforce strict auth checks; missing/invalid credentials immediately reject request with 401/403 | Fix Implemented |
| R-004 | Cost/token tracking falsely showing 0 | Medium | High | `usage` parsed as null/undefined, UI components displaying 0 | Explicitly tag as `{ status: 'unknown' }` whenever usage metadata is missing | Fix Implemented |
| R-005 | Unmitigated paid provider fallback | High | Medium | Silent provider fallback routes can incur unexpected charges | Enforce fail-closed provider policy: if user provider fails, report error; never auto-switch to paid API | Fix Implemented |
| R-006 | Asset license contamination | Medium | High | `VRMA_MotionPack` has pixiv Inc. proprietary license with specific attribution requirements; model is human anime girl | Decouple asset licensing; use custom procedural/GLB fantasy-creature companion | In Progress |
| R-007 | Secondary agent loops in companion | High | Low | Multiple UI components triggering agent calls independently | Single Authoritative Task Coordinator: Companion has zero autonomous brain | Enforced by Architecture |
| R-008 | Desktop Station Isolation Boundary (`exebox-*` vs `WinSta0\default`) | High | High | WinApp MCP fails to discover standard desktop windows when executed in isolated desktop stations | Call `OpenDesktop("default")` & `SetThreadDesktop` before COM/UIA initialization in native `LucyUiaWorker.cs` | Fix Implemented |
| R-009 | Unrestricted desktop input & consequential action risks | High | Medium | Blind clicking/typing can accidentally trigger irreversible actions (delete, submit, pay) | Route all native desktop tools through `PermissionAuthority` with `CONSEQUENTIAL` risk tier and keyword detection | Fix Implemented |
| R-010 | Multiple instance launch / memory state corruption (SEC-004) | High | Medium | Launching application twice causes concurrent writes to persistent memory store | Enforce `app.requestSingleInstanceLock()`; secondary instances exit safely; primary focuses window | Fix Implemented |
| R-011 | Indefinite permission prompt blocking (SEC-005) | Medium | High | Abandoned confirmation prompt blocks task coordinator state and hangs indefinitely | Enforce 60-second configurable timeout; fails closed, clears callbacks, cleans up on shutdown | Fix Implemented |
| R-012 | Insecure remote custom endpoint credential leak (SEC-007) | Medium | Medium | Configuring custom HTTP OpenAI endpoint leaks API key over plaintext network | Validate URL protocol before network dispatch; strictly enforce HTTPS for all remote endpoints | Fix Implemented |
| R-013 | Malformed / oversized IPC payload DoS or crash (SEC-008) | Low | Medium | Unchecked renderer IPC payloads could cause memory bloat or unexpected exceptions | Centralized parameter validation schemas with strict type guards, bounds, and enum checks | Fix Implemented |
| R-014 | Dangling background HTTP streams on cancellation | Medium | Medium | User interrupt could leave fetch connections consuming bandwidth or updating feed | AbortController cancellation halts active transport immediately; fail-closed lifecycle | Fix Implemented |
| R-015 | Local Ollama offline prompting unintended remote fallback | High | Medium | Silent failover from local models to remote endpoints risks data leakage and costs | Strict loopback validation; honest error reporting; zero silent provider fallback | Fix Implemented |
| R-016 | Hugging Face serverless rate limits & cold-start latency | Medium | High | Free-tier inference can encounter 429 rate limits or 503 model-loading delays | Honest status code translation, free-tier cost disclosure, clear UI configuration guidance | Fix Implemented |
| R-017 | Context window overrun on extended 50+ message sessions | High | High | Uncontrolled history growth causes sudden context length errors or token truncation | Model context limits, conservative token estimator, and bounded history compaction | Fix Implemented |

## 3. Human Intervention Prerequisites
The following is the ONLY prerequisite requiring human action:
- **AI Provider API Key**: To make live requests to hosted LLMs (e.g., Google Gemini API, OpenRouter, Hugging Face, etc.), the user must provide an API key, or start a local Ollama instance (`http://127.0.0.1:11434`). L.U.C.Y. provides a secure UI and Windows DPAPI encrypted storage to persist keys. All other setup, build, tests, permission enforcement, tools, and UI run 100% autonomously without human intervention.

