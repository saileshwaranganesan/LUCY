'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    ContextBudgetManager,
    estimateTokenCount,
    MODEL_CONTEXT_LIMITS
} = require('../../src/core/context-budget.js');
const { CredentialStore } = require('../../src/security/credential-store.js');

test('REQ-032: Context Budgeting and Compaction Verification', async (t) => {
    await t.test('conservative token estimation is non-trivial and respects structure', () => {
        // Plain word
        const t1 = estimateTokenCount('hello');
        assert.ok(t1 >= 1);

        // JSON payload with symbols and keys
        const t2 = estimateTokenCount('{"toolId": "file_write", "params": {"path": "src/index.js", "content": "console.log(123);"}}');
        assert.ok(t2 > 20);

        // Word count + symbol heuristic exceeds naive length/4
        const text = 'SELECT * FROM users WHERE id = 123 AND token = "xyz"!';
        const est = estimateTokenCount(text);
        assert.ok(est >= Math.ceil(text.length / 3.3));
    });

    await t.test('respects model-specific context window limits', () => {
        const mgrOllama = new ContextBudgetManager({ model: 'qwen2.5:1.5b' });
        assert.equal(mgrOllama.maxTokens, 4096);

        const mgrHuggingFace = new ContextBudgetManager({ model: 'meta-llama/Llama-3.2-3B-Instruct' });
        assert.equal(mgrHuggingFace.maxTokens, 8192);

        const mgrGemini = new ContextBudgetManager({ model: 'gemini-2.0-flash', maxTokens: 16000 });
        assert.equal(mgrGemini.maxTokens, 16000);
    });

    await t.test('accounts for full context components: system, history, memories, tools, request', () => {
        const mgr = new ContextBudgetManager({ maxTokens: 500 });

        const messages = [
            { role: 'system', content: 'You are L.U.C.Y., desktop assistant.' },
            { role: 'user', content: 'First request' },
            { role: 'assistant', content: 'First response' }
        ];

        const memories = [{ category: 'user_approved', content: 'User prefers dark mode and port 8080' }];
        const tools = [{ id: 'file_read', description: 'Read file' }];
        const currentRequest = 'What is the current port configuration?';

        const check = mgr.measureContext(messages, { memories, tools, currentRequest });

        assert.equal(check.maxTokens, 500);
        assert.ok(check.breakdown.system > 0);
        assert.ok(check.breakdown.history > 0);
        assert.ok(check.breakdown.memories > 0);
        assert.ok(check.breakdown.tools > 0);
        assert.ok(check.breakdown.currentRequest > 0);
        assert.equal(check.totalTokens,
            check.breakdown.system + check.breakdown.history + check.breakdown.memories + check.breakdown.tools + check.breakdown.currentRequest
        );
    });

    await t.test('preserves original history while generating bounded context view', () => {
        const mgr = new ContextBudgetManager({ maxTokens: 180 });

        const originalHistory = [
            { role: 'user', content: 'Step 1: Inspect host system configuration and check CPU memory status in detail.' },
            { role: 'assistant', content: 'Step 1 complete: Host system inspected via system_info. Platform: Windows x64. Memory free: 78 GB. Uptime: 48 hours.' },
            { role: 'user', content: 'Step 2: List all files in the current workspace directory and check package.json structure.' },
            { role: 'assistant', content: 'Step 2 complete: File list retrieved. Found package.json, src/, tests/, and electron-builder.yml.' },
            { role: 'user', content: 'Step 3: Read package.json and extract dependencies list including electron and playwright.' },
            { role: 'assistant', content: 'Step 3 complete: Dependencies extracted: electron 34.3.0, playwright 1.64.0, three 0.186.1.' },
            { role: 'user', content: 'Step 4: Create a temporary test scratchpad at scratch/test.txt with verification content.' },
            { role: 'assistant', content: 'Step 4 complete: File scratch/test.txt created and verified inside workspace boundary.' },
            { role: 'user', content: 'Step 5: Verify the created file content and take a screenshot of the window.' },
            { role: 'assistant', content: 'Step 5 complete: Content verified. Screenshot captured.' }
        ];

        const originalHistoryCopy = JSON.parse(JSON.stringify(originalHistory));

        const result = mgr.buildBoundedContext(originalHistory, {
            metadata: { objective: 'File test operation' }
        });

        // Verify original conversation history remains 100% UNTOUCHED
        assert.deepEqual(originalHistory, originalHistoryCopy);
        assert.equal(originalHistory.length, 10);

        // Verify bounded context was produced with semantic continuation memory
        assert.equal(result.compacted, true);
        assert.ok(result.boundedMessages.some((m) => m.isCompactedMemory));
        assert.ok(result.diagnostics.tokensSaved > 0);
    });

    await t.test('redacts credentials and secrets from compacted continuation memory', () => {
        const mgr = new ContextBudgetManager({ maxTokens: 120 });

        const historyWithSecret = [
            { role: 'user', content: 'My api_key is hf_abcdef1234567890abcdef1234567890' },
            { role: 'assistant', content: 'Received token bearer hf_abcdef1234567890abcdef1234567890' },
            { role: 'user', content: 'Also password: SuperSecretPassword123' },
            { role: 'assistant', content: 'Stored securely.' },
            { role: 'user', content: 'Recent query 1' },
            { role: 'assistant', content: 'Recent reply 1' },
            { role: 'user', content: 'Recent query 2' },
            { role: 'assistant', content: 'Recent reply 2' }
        ];

        const compacted = mgr.compactHistory(historyWithSecret, {
            objective: 'Manage api_key: hf_abcdef1234567890abcdef1234567890'
        });

        const memoryMessage = compacted.find((m) => m.isCompactedMemory);
        assert.ok(memoryMessage);
        assert.ok(!memoryMessage.content.includes('hf_abcdef1234567890abcdef1234567890'));
        assert.ok(!memoryMessage.content.includes('SuperSecretPassword123'));
        assert.ok(memoryMessage.content.includes('[REDACTED_SECRET]'));
    });

    await t.test('50-Message Long Scenario: Compaction bounds context safely without memory leak or loop', () => {
        // Construct a realistic 50-message conversational interaction
        const conversation50 = [];
        for (let i = 1; i <= 25; i++) {
            conversation50.push({
                role: 'user',
                content: `Step ${i}: Inspect system metric item ${i} and record measurement ${i * 42} into database.`
            });
            conversation50.push({
                role: 'assistant',
                content: `Step ${i} acknowledged: Tool system_info verified metric ${i}. Status: healthy. Value: ${i * 42}.`
            });
        }
        assert.equal(conversation50.length, 50);

        const mgr = new ContextBudgetManager({
            model: 'qwen2.5:1.5b', // 4096 tokens max
            maxTokens: 500, // Constrained working budget to mandate compaction
            recentTurnsToKeep: 4
        });

        const metadata = {
            objective: 'Perform comprehensive 25-step health metric audit',
            completedSteps: [
                'Step 1-20: Metrics 1-20 verified and validated',
                'Step 21-23: Metrics 21-23 analyzed cleanly'
            ],
            verifiedFacts: [
                'System: Windows x64 WinSta0\\default',
                'Uptime: 48 hours verified'
            ],
            preferences: [
                'Fail closed on permission gate',
                'Workspace containment enforced'
            ],
            pendingDecisions: [
                'Confirmation required before deleting temporary logs'
            ],
            nextAction: 'Execute Step 24: Final metric collection and synthesis'
        };

        const result = mgr.buildBoundedContext(conversation50, { metadata });

        // Verification 1: Compaction was triggered
        assert.equal(result.compacted, true);

        // Verification 2: Recent relevant turns (last 4) survive intact
        const bounded = result.boundedMessages;
        assert.ok(bounded.length < 50);
        assert.equal(bounded[bounded.length - 1].content, conversation50[49].content);
        assert.equal(bounded[bounded.length - 2].content, conversation50[48].content);
        assert.equal(bounded[bounded.length - 3].content, conversation50[47].content);
        assert.equal(bounded[bounded.length - 4].content, conversation50[46].content);

        // Verification 3: Important task state survives inside continuation memory
        const memoryEntry = bounded.find((m) => m.isCompactedMemory);
        assert.ok(memoryEntry);
        assert.ok(memoryEntry.content.includes('Perform comprehensive 25-step health metric audit'));
        assert.ok(memoryEntry.content.includes('Step 1-20: Metrics 1-20 verified'));
        assert.ok(memoryEntry.content.includes('Windows x64 WinSta0\\default'));
        assert.ok(memoryEntry.content.includes('Confirmation required before deleting temporary logs'));
        assert.ok(memoryEntry.content.includes('Execute Step 24'));

        // Verification 4: Pending permission is explicitly labeled as PENDING, never resolved
        assert.match(memoryEntry.content, /PENDING.*Confirmation required/i);

        // Verification 5: Token savings are observable and positive
        assert.ok(result.diagnostics.tokensSaved > 0);
        assert.ok(result.diagnostics.compactedTokens < result.diagnostics.originalTokens);

        // Verification 6: Bounded messages can be compacted again without infinite growth or looping
        const secondPass = mgr.buildBoundedContext(bounded, { metadata });
        assert.ok(secondPass.boundedMessages.length <= bounded.length);
    });
});
