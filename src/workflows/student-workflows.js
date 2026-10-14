'use strict';

/**
 * Reusable Student Workflow Automations for L.U.C.Y. (REQ-036)
 * 
 * Built on top of:
 * - Persistent browser sessions (REQ-015 / DEF-004) for authenticated student portals.
 * - Strict workspace path containment (SEC-003) for course documents.
 * - Safe permission authority (SEC-005) for consequential workflow execution.
 * - Proactive scheduler (REQ-037) for study sessions and deadline reminders.
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

class StudentWorkflows extends EventEmitter {
    constructor({
        browserManager = null,
        workspaceRoot = process.cwd(),
        scheduler = null,
        permissionAuthority = null
    } = {}) {
        super();
        this.browserManager = browserManager;
        this.workspaceRoot = workspaceRoot;
        this.scheduler = scheduler;
        this.permissionAuthority = permissionAuthority;
        this.activeSessions = new Map();
    }

    /**
     * Inspect student/college LMS portal for upcoming assignments, courses, and announcements.
     * Uses persistent browser context to retain student login sessions.
     * 
     * @param {object} params
     * @param {string} params.portalUrl - Portal URL (e.g., Canvas, Moodle, Blackboard, Google Classroom).
     * @param {string} [params.courseFilter] - Optional course name or subject code filter.
     * @returns {Promise<object>} Structured student summary.
     */
    async inspectPortal({ portalUrl, courseFilter = null } = {}) {
        if (!portalUrl || typeof portalUrl !== 'string') {
            throw new Error('portalUrl must be a valid URL string');
        }

        // Dry-run / browser availability check
        if (!this.browserManager) {
            return {
                ok: true,
                portalUrl,
                status: 'simulated',
                message: 'BrowserManager not attached; returned mock portal summary',
                courses: [
                    { name: 'Computer Science 101', pendingAssignments: 1, nextDue: 'Tomorrow at 11:59 PM' },
                    { name: 'Linear Algebra', pendingAssignments: 0, nextDue: 'None' }
                ],
                announcements: ['Midterm exam schedule posted for Fall semester.']
            };
        }

        const page = await this.browserManager.getPage();
        await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Extract headings, announcements, and task links
        const extracted = await page.evaluate(() => {
            const items = [];
            const links = Array.from(document.querySelectorAll('a, h2, h3, .assignment, .announcement, .course-title'));
            for (const el of links.slice(0, 50)) {
                const text = el.innerText ? el.innerText.trim() : '';
                if (text && text.length > 3 && text.length < 200) {
                    items.push(text);
                }
            }
            const title = document.title || '';
            return { title, items };
        });

        let courses = [];
        let announcements = [];
        let upcomingAssignments = [];

        // Parse extracted DOM items into structured records
        for (const item of extracted.items) {
            const lower = item.toLowerCase();
            if (lower.includes('due') || lower.includes('assignment') || lower.includes('homework') || lower.includes('quiz')) {
                upcomingAssignments.push(item);
            } else if (lower.includes('announcement') || lower.includes('notice') || lower.includes('exam') || lower.includes('grade')) {
                announcements.push(item);
            } else if (lower.includes('course') || lower.includes('cs') || lower.includes('math') || lower.includes('class')) {
                courses.push(item);
            }
        }

        if (courseFilter) {
            const f = courseFilter.toLowerCase();
            courses = courses.filter(c => c.toLowerCase().includes(f));
            upcomingAssignments = upcomingAssignments.filter(a => a.toLowerCase().includes(f));
        }

        return {
            ok: true,
            status: 'completed',
            portalUrl,
            pageTitle: extracted.title,
            isPersistentSession: Boolean(this.browserManager.persistentContext),
            courses: courses.slice(0, 10),
            upcomingAssignments: upcomingAssignments.slice(0, 10),
            announcements: announcements.slice(0, 5)
        };
    }

    /**
     * Synthesize lecture notes or course text into a high-yield Markdown study guide.
     * Enforces path containment within the student's designated workspace.
     * 
     * @param {object} params
     * @param {string} params.subject - Course name or topic (e.g., 'Operating Systems').
     * @param {string} [params.notesContent] - Raw lecture text or notes.
     * @param {string} [params.sourceFile] - Workspace path to source file.
     * @param {string} [params.outputFileName] - Desired filename.
     * @returns {Promise<object>} Result containing generated study guide file path and stats.
     */
    async generateStudyGuide({
        subject,
        notesContent = null,
        sourceFile = null,
        outputFileName = null
    } = {}) {
        if (!subject || typeof subject !== 'string') {
            throw new Error('subject must be a non-empty string');
        }

        let content = notesContent || '';
        if (sourceFile) {
            const safeSourcePath = path.resolve(this.workspaceRoot, sourceFile);
            if (!safeSourcePath.startsWith(this.workspaceRoot)) {
                throw new Error('sourceFile escapes workspace boundary');
            }
            if (fs.existsSync(safeSourcePath)) {
                content += '\n' + fs.readFileSync(safeSourcePath, 'utf8');
            }
        }

        if (!content.trim()) {
            content = `Course notes for ${subject}.`;
        }

        // Synthesize structured study guide
        const dateStr = new Date().toISOString().split('T')[0];
        const lines = content.split('\n').filter(l => l.trim().length > 0);

        const keyPoints = lines.slice(0, 8).map(l => `- **Key Concept:** ${l.trim()}`).join('\n');
        const flashcards = lines.slice(0, 4).map((l, i) => `**Q${i + 1}: What is the core takeaway regarding ${l.slice(0, 30).trim()}...?**\n> *A:* ${l.trim()}`).join('\n\n');

        const studyGuideMarkdown = `# Study Guide: ${subject}
*Generated by L.U.C.Y. Student Companion on ${dateStr}*

---

## 1. Executive Summary & Core Concepts
${keyPoints}

---

## 2. Active Recall Flashcard Pairs
${flashcards}

---

## 3. Practice Exam Questions
1. How does the primary architecture of ${subject} manage resource contention and maintain consistency?
2. Explain the fundamental trade-offs involved in key algorithmic approaches discussed in this unit.

---
*Generated safely within L.U.C.Y. student workspace.*
`;

        const safeFilename = outputFileName || `Study_Guide_${subject.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`;
        const outputPath = path.resolve(this.workspaceRoot, safeFilename);

        if (!outputPath.startsWith(this.workspaceRoot)) {
            throw new Error('outputFileName escapes workspace boundary');
        }

        fs.writeFileSync(outputPath, studyGuideMarkdown, 'utf8');

        return {
            ok: true,
            status: 'completed',
            subject,
            outputPath,
            bytesWritten: Buffer.byteLength(studyGuideMarkdown, 'utf8'),
            keyConceptsCount: Math.min(lines.length, 8),
            flashcardCount: Math.min(lines.length, 4)
        };
    }

    /**
     * Launch an academic focus study session (Pomodoro / Study Block) with scheduler notifications.
     * 
     * @param {object} params
     * @param {string} params.subject
     * @param {number} [params.durationMinutes=25]
     * @param {number} [params.breakMinutes=5]
     * @param {Function} [params.onMilestone]
     * @returns {object} Focus session descriptor.
     */
    startStudySession({
        subject,
        durationMinutes = 25,
        breakMinutes = 5,
        onMilestone = null
    } = {}) {
        if (!subject || typeof subject !== 'string') {
            throw new Error('subject must be a non-empty string');
        }

        const sessionId = `study_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const session = {
            id: sessionId,
            subject: subject.trim(),
            durationMinutes,
            breakMinutes,
            startedAt: Date.now(),
            status: 'active',
            milestones: []
        };

        this.activeSessions.set(sessionId, session);

        // Arm proactive reminders if scheduler is present
        if (this.scheduler) {
            // Study completion reminder
            this.scheduler.scheduleOnce({
                id: `${sessionId}_break`,
                prompt: `Focus block complete for ${subject}! Time for a ${breakMinutes}-minute break.`,
                delayMs: durationMinutes * 60 * 1000,
                callback: async () => {
                    session.status = 'on_break';
                    session.milestones.push({ type: 'break_started', time: Date.now() });
                    if (typeof onMilestone === 'function') {
                        onMilestone({ type: 'break_started', session });
                    }
                    this.emit('break_started', session);
                }
            });

            // Resumption reminder
            this.scheduler.scheduleOnce({
                id: `${sessionId}_resume`,
                prompt: `Break is over! Ready to resume studying ${subject}?`,
                delayMs: (durationMinutes + breakMinutes) * 60 * 1000,
                callback: async () => {
                    session.status = 'completed';
                    session.milestones.push({ type: 'session_completed', time: Date.now() });
                    if (typeof onMilestone === 'function') {
                        onMilestone({ type: 'session_completed', session });
                    }
                    this.emit('session_completed', session);
                }
            });
        }

        this.emit('session_started', session);
        return session;
    }

    /**
     * Cancel an active focus study session and any pending reminders.
     * @param {string} sessionId
     * @returns {boolean}
     */
    cancelStudySession(sessionId) {
        const session = this.activeSessions.get(sessionId);
        if (!session) return false;

        session.status = 'cancelled';
        if (this.scheduler) {
            this.scheduler.cancelJob(`${sessionId}_break`);
            this.scheduler.cancelJob(`${sessionId}_resume`);
        }
        this.emit('session_cancelled', session);
        return true;
    }

    /**
     * Get active study sessions.
     */
    listActiveSessions() {
        return Array.from(this.activeSessions.values());
    }
}

module.exports = {
    StudentWorkflows
};
