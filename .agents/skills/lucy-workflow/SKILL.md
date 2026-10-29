---
name: lucy-workflow
description: Directs L.U.C.Y. engineering tasks to the right tools, skills, and verification loops. Use whenever working on L.U.C.Y. features, bug fixes, architecture analysis, or release packaging.
---

# L.U.C.Y. Engineering Task Routing Runbook

This skill directs Antigravity to the correct tools, MCPs, and verification commands for every L.U.C.Y. task category.

## Task Category Routing Matrix

| Task Category | Primary Tool / MCP | Guiding Skill | Key Verification Command |
| :--- | :--- | :--- | :--- |
| **API & Library Syntax** | `context7` MCP (`resolve-library-id`, `query-docs`) | `context7-docs` | `node -c <file>` |
| **Elusive / Multi-Component Bugs** | `sequential-thinking` MCP (`sequentialthinking`) | `sequential-reasoning` / `systematic-debugging` | `npm run test:unit` |
| **Packaged Artifacts / ASAR / Binaries** | `rea` MCP (`inspect_pe_resources`, `analyze_javascript_application`) | `rea-investigate` | `npm run smoke:packaged` |
| **UI Design & Companion Styling** | `skillui` (CLI) + `ui-ux-pro-max` | `frontend-design` / `taste-design` | Loopback HTTP + Playwright / Visual check |
| **Feature Implementation** | Inline bounded execution | `executing-plans` + `test-driven-development` | `npm run test:unit` |
| **Security Boundaries** | IPC Validator / DPAPI CredentialStore | `code-review` | `npm run test:security` |
| **Release & Packaging** | Electron Builder / NSIS patch | `gsd-execution` | `npm run test:packaging` & `npm run release:verify` |

## Standard 5-Step Execution Loop

1. **Investigate**: Consult `AGENTS.md` and `.agents/rules/authoritative-docs.md`. Search existing code before adding new dependencies or abstractions.
2. **Select Tools**: Use specialist MCPs (`context7`, `rea`, `sequential-thinking`) over blind web search or trial-and-error.
3. **Execute Inline**: Antigravity runs tasks inline with TDD. Write failing tests first, make minimal targeted edits, verify pass.
4. **Multi-Track Verification**:
   - Core Unit: `npm run test:unit`
   - Security: `npm run test:security`
   - Flow / Integration: `npm run test:flow`
   - Packaging / Release: `npm run test:packaging`
5. **Independent Review**: Verify git diff against requirements, check for secrets, confirm error handling, and report exact evidence.
