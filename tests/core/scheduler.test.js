'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { Scheduler, JOB_STATUS } = require('../../src/core/scheduler');

function createTempDir() {
    const tmp = path.join(os.tmpdir(), `lucy_sched_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(tmp, { recursive: true });
    return tmp;
}

test('REQ-037: Proactive Reminder and Scheduling Engine', async (t) => {
    let tempDir = null;

    t.beforeEach(() => {
        tempDir = createTempDir();
    });

    t.afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (_) {}
        }
    });

    await t.test('schedules and executes a one-shot reminder after delay', async () => {
        const scheduler = new Scheduler({ storageDir: tempDir });
        let executed = false;
        let receivedJob = null;

        const job = scheduler.scheduleOnce({
            id: 'test_rem_1',
            prompt: 'Drink a glass of water',
            delayMs: 20,
            callback: async (j) => {
                executed = true;
                receivedJob = j;
            }
        });

        assert.equal(job.id, 'test_rem_1');
        assert.equal(job.status, JOB_STATUS.SCHEDULED);
        assert.equal(scheduler.listJobs().length, 1);

        // Wait for execution
        await new Promise((r) => setTimeout(r, 60));

        assert.equal(executed, true);
        assert.equal(receivedJob.id, 'test_rem_1');
        assert.equal(scheduler.getJob('test_rem_1').status, JOB_STATUS.COMPLETED);

        scheduler.dispose();
    });

    await t.test('cancels scheduled job by ID cleanly before execution', async () => {
        const scheduler = new Scheduler({ storageDir: tempDir });
        let executed = false;

        scheduler.scheduleOnce({
            id: 'cancel_me',
            prompt: 'Remind about laundry',
            delayMs: 40,
            callback: async () => {
                executed = true;
            }
        });

        const cancelled = scheduler.cancelJob('cancel_me');
        assert.equal(cancelled, true);

        // Wait past original trigger time
        await new Promise((r) => setTimeout(r, 60));

        assert.equal(executed, false);
        const job = scheduler.getJob('cancel_me');
        assert.equal(job.status, JOB_STATUS.CANCELLED);

        scheduler.dispose();
    });

    await t.test('schedules recurring intervals and tracks iteration counts', async () => {
        const scheduler = new Scheduler({ storageDir: tempDir });
        let count = 0;

        scheduler.scheduleRecurring({
            id: 'rec_test',
            prompt: 'Stand up and stretch',
            intervalMs: 1000,
            callback: async () => {
                count++;
            }
        });

        // Trigger execution directly to test cycle
        await scheduler._executeJob('rec_test');
        await scheduler._executeJob('rec_test');

        const job = scheduler.getJob('rec_test');
        assert.equal(job.recurring, true);
        assert.equal(job.iterationCount, 2);
        assert.equal(job.status, JOB_STATUS.SCHEDULED);

        scheduler.cancelJob('rec_test');
        assert.equal(scheduler.getJob('rec_test').status, JOB_STATUS.CANCELLED);
        scheduler.dispose();
    });

    await t.test('persists jobs to disk and reloads them across restart', async () => {
        const storeFile = path.join(tempDir, 'scheduled-tasks.json');
        const scheduler1 = new Scheduler({ storagePath: storeFile });

        scheduler1.scheduleOnce({
            id: 'restart_job_future',
            prompt: 'Study for math quiz',
            delayMs: 10000
        });

        scheduler1.scheduleOnce({
            id: 'restart_job_past',
            prompt: 'Past reminder not fired',
            targetTime: Date.now() - 5000,
            triggerIfMissed: false
        });

        scheduler1.scheduleOnce({
            id: 'restart_job_catchup',
            prompt: 'Crucial missed reminder',
            targetTime: Date.now() - 5000,
            triggerIfMissed: true
        });

        scheduler1.dispose();

        // Second instance simulates application restart
        const scheduler2 = new Scheduler({ storagePath: storeFile });
        let catchupFired = false;
        scheduler2.on('missed', (j) => {
            if (j.id === 'restart_job_catchup') catchupFired = true;
        });

        scheduler2.start();

        const futureJob = scheduler2.getJob('restart_job_future');
        assert.equal(futureJob.status, JOB_STATUS.SCHEDULED);

        const pastJob = scheduler2.getJob('restart_job_past');
        assert.equal(pastJob.status, JOB_STATUS.MISSED);

        assert.equal(catchupFired, true);

        scheduler2.dispose();
    });

    await t.test('fails closed when job throws, without crashing scheduler', async () => {
        const scheduler = new Scheduler({ storageDir: tempDir });
        let failedEmitted = false;

        scheduler.on('failed', ({ job, error }) => {
            failedEmitted = true;
            assert.equal(job.id, 'fail_job');
            assert.ok(error.message.includes('Simulated network error'));
        });

        scheduler.scheduleOnce({
            id: 'fail_job',
            prompt: 'Sync remote portal',
            delayMs: 10,
            callback: async () => {
                throw new Error('Simulated network error');
            }
        });

        await new Promise((r) => setTimeout(r, 40));

        assert.equal(failedEmitted, true);
        assert.equal(scheduler.getJob('fail_job').status, JOB_STATUS.FAILED);

        scheduler.dispose();
    });

    await t.test('disallow scheduling when scheduler is disposed', () => {
        const scheduler = new Scheduler({ storageDir: tempDir });
        scheduler.dispose();

        assert.throws(() => {
            scheduler.scheduleOnce({ prompt: 'test', delayMs: 100 });
        }, /disposed/);
    });
});
