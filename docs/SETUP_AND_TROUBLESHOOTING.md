# L.U.C.Y. - Setup and Troubleshooting Guide

## Prerequisites
- Windows 10/11 x64
- Node.js >= 20 LTS (Node 24.12.0 verified)
- npm >= 10 (npm 11.6.2 verified)
- Git (verified 2.36.1)
- Python (verified 3.13.12)

## Setup Steps
1. Clone / open the workspace in `C:\Users\admin\Desktop\LUCY`.
2. Install pinned dependencies:
   ```bash
   npm install
   ```
3. Configure environment template:
   ```bash
   cp .env.example .env
   ```
   *(Optional)* Enter your Google Gemini API key or OpenRouter API key in `.env` or configure securely via Windows DPAPI. If using local Ollama (`http://127.0.0.1:11434`), no API key is required.
4. Run the automated test suite:
   ```bash
   npm test
   ```
   or:
   ```bash
   node --test tests/**/*.test.js
   ```
5. Launch the desktop assistant:
   ```bash
   npm start
   ```

## Troubleshooting
- **PowerShell Execution Policies**: When encrypting credentials with DPAPI, `credential-store.js` executes PowerShell with `-NoProfile -NonInteractive`. If restricted, ensure execution policy permits script evaluation or use the cryptographic AES-256-GCM fallback.
- **Missing API Keys**: If `LUCY_AI_PROVIDER` is set to `gemini` or `openrouter` but no key is configured, the assistant will fail closed with a descriptive error message instructing you to set the key. It will never silently fallback to paid APIs.
- **Port Conflicts**: If running local Ollama, ensure Ollama is listening on port 11434 (`curl http://127.0.0.1:11434/api/tags`).
