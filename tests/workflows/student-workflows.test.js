'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { StudentWorkflows } = require('../../src/workflows/student-workflows');
const { Scheduler } = require('../../src/core/scheduler');

function createTempDir() {
    const tmp = path.join(os.tmpdir(), `lucy_student_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(tmp, { recursive: true });
    return tmp;
}

test('REQ-036: Reusable Student Workflow Automations', async (t) => {
    let tempDir = null;
    let scheduler = null;

    t.beforeEach(() => {
        tempDir = createTempDir();
        scheduler = new Scheduler({ storageDir: tempDir });
    });

    t.afterEach(() => {
        if (scheduler) {
            scheduler.dispose();
        }
        if (tempDir && fs.existsSync(tempDir)) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (_) {}
        }
    });

    await t.test('generateStudyGuide synthesizes markdown document within workspace boundary', async () => {
        const workflows = new StudentWorkflows({
            workspaceRoot: tempDir,
            scheduler
        });

        const notes = `
Database Normalization First Normal Form eliminates duplicate columns
Second Normal Form requires no partial dependencies
Third Normal Form requires no transitive dependencies
Boyce Codd Normal Form handles anomalous candidate keys
`;

        const res = await workflows.generateStudyGuide({
            subject: 'Database Systems',
            notesContent: notes,
            outputFileName: 'DB_Study_Guide.md'
        });

        assert.equal(res.ok, true);
        assert.equal(res.status, 'completed');
        assert.equal(res.subject, 'Database Systems');
        assert.ok(fs.existsSync(res.outputPath));

        const savedContent = fs.readFileSync(res.outputPath, 'utf8');
        assert.ok(savedContent.includes('# Study Guide: Database Systems'));
        assert.ok(savedContent.includes('First Normal Form'));
        assert.ok(savedContent.includes('Active Recall Flashcard Pairs'));
    });

    await t.test('generateStudyGuide rejects file paths that escape workspace boundary', async () => {
        const workflows = new StudentWorkflows({
            workspaceRoot: tempDir,
            scheduler
        });

        await assert.rejects(async () => {
            await workflows.generateStudyGuide({
                subject: 'Exploit Attempt',
                outputFileName: '../../outside_secret.md'
            });
        }, /escapes workspace boundary/);
    });

    await t.test('inspectPortal returns structured summary with or without live browser', async () => {
        const workflows = new StudentWorkflows({
            workspaceRoot: tempDir,
            scheduler
        });

        const res = await workflows.inspectPortal({
            portalUrl: 'https://canvas.instructure.com/courses/101',
            courseFilter: 'Computer Science'
        });

        assert.equal(res.ok, true);
        assert.ok(Array.isArray(res.courses));
        assert.ok(Array.isArray(res.announcements));
        assert.equal(res.portalUrl, 'https://canvas.instructure.com/courses/101');
    });

    await t.test('startStudySession orchestrates focus block with scheduler reminders', async () => {
        const workflows = new StudentWorkflows({
            workspaceRoot: tempDir,
            scheduler
        });

        let milestoneReceived = null;
        const session = workflows.startStudySession({
            subject: 'Quantum Mechanics',
            durationMinutes: 25,
            breakMinutes: 5,
            onMilestone: (m) => {
                milestoneReceived = m;
            }
        });

        assert.equal(session.subject, 'Quantum Mechanics');
        assert.equal(session.status, 'active');
        assert.equal(workflows.listActiveSessions().length, 1);

        // Verify scheduler received break and resume jobs
        const jobs = scheduler.listJobs();
        assert.ok(jobs.some((j) => j.id === `${session.id}_break`));
        assert.ok(jobs.some((j) => j.id === `${session.id}_resume`));

        // Test cancellation
        const cancelled = workflows.cancelStudySession(session.id);
        assert.equal(cancelled, true);

        const breakJob = scheduler.getJob(`${session.id}_break`);
        assert.equal(breakJob.status, 'cancelled');
    });
});
