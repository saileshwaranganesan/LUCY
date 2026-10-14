'use strict';

/**
 * Tool Registry bindings for Reusable Student Workflows (REQ-036) and Scheduling (REQ-037)
 */

const { RISK_TIERS } = require('../security/permission-authority.js');

function registerStudentWorkflowTools(registry, studentWorkflows, scheduler = null) {
    if (!registry || !studentWorkflows) {
        throw new Error('ToolRegistry and StudentWorkflows are required');
    }

    // 1. Student Portal Inspection Tool
    registry.registerTool({
        id: 'student_portal_check',
        name: 'Student Portal Inspector',
        description: 'Check college/student LMS portal for upcoming assignments, courses, and announcements using persistent sessions',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {
                portalUrl: {
                    type: 'string',
                    description: 'The URL of the student or LMS portal'
                },
                courseFilter: {
                    type: 'string',
                    description: 'Optional course title or code to filter for'
                }
            },
            required: ['portalUrl']
        },
        handler: async (params) => {
            return await studentWorkflows.inspectPortal(params);
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'inspect_student_portal',
                target: params.portalUrl,
                courseFilter: params.courseFilter || 'none'
            };
        }
    });

    // 2. Student Study Guide Synthesizer Tool
    registry.registerTool({
        id: 'student_synthesize_study_guide',
        name: 'Study Guide Synthesizer',
        description: 'Synthesize course notes or lecture materials into an active-recall Markdown study guide in the workspace',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {
                subject: {
                    type: 'string',
                    description: 'Course or subject name (e.g. Operating Systems, Calculus)'
                },
                notesContent: {
                    type: 'string',
                    description: 'Raw lecture text, outline, or notes'
                },
                sourceFile: {
                    type: 'string',
                    description: 'Relative path to source notes file in workspace'
                },
                outputFileName: {
                    type: 'string',
                    description: 'Optional output filename in workspace'
                }
            },
            required: ['subject']
        },
        handler: async (params) => {
            return await studentWorkflows.generateStudyGuide(params);
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'generate_study_guide',
                subject: params.subject,
                targetOutput: params.outputFileName || `Study_Guide_${params.subject}.md`
            };
        }
    });

    // 3. Focus Study Session Tool
    registry.registerTool({
        id: 'student_start_study_session',
        name: 'Focus Study Session Manager',
        description: 'Initiate a structured Pomodoro or academic focus block with proactive break and resumption reminders',
        riskTier: RISK_TIERS.SAFE_READ,
        schema: {
            type: 'object',
            properties: {
                subject: {
                    type: 'string',
                    description: 'Subject being studied'
                },
                durationMinutes: {
                    type: 'number',
                    description: 'Duration of focus block in minutes (default 25)'
                },
                breakMinutes: {
                    type: 'number',
                    description: 'Duration of break in minutes (default 5)'
                }
            },
            required: ['subject']
        },
        handler: async (params) => {
            const session = studentWorkflows.startStudySession(params);
            return {
                ok: true,
                status: 'session_active',
                session
            };
        },
        dryRunSimulate: async (params) => {
            return {
                simulatedAction: 'start_study_session',
                subject: params.subject,
                duration: `${params.durationMinutes || 25}m`
            };
        }
    });

    // 4. Proactive Scheduling Tools (if scheduler provided)
    if (scheduler) {
        registry.registerTool({
            id: 'schedule_reminder',
            name: 'Proactive Reminder Scheduler',
            description: 'Schedule a proactive one-shot reminder or interval check at an exact time or after a delay',
            riskTier: RISK_TIERS.SAFE_READ,
            schema: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: 'Reminder message or task prompt'
                    },
                    delayMs: {
                        type: 'number',
                        description: 'Relative delay in milliseconds from now'
                    },
                    targetTime: {
                        type: 'string',
                        description: 'Exact ISO timestamp or date string'
                    }
                },
                required: ['prompt']
            },
            handler: async (params) => {
                const job = scheduler.scheduleOnce(params);
                return {
                    ok: true,
                    status: 'scheduled',
                    job
                };
            },
            dryRunSimulate: async (params) => {
                return {
                    simulatedAction: 'schedule_reminder',
                    prompt: params.prompt,
                    delayMs: params.delayMs
                };
            }
        });

        registry.registerTool({
            id: 'list_reminders',
            name: 'List Active Reminders',
            description: 'List all currently scheduled proactive reminders and recurring jobs',
            riskTier: RISK_TIERS.SAFE_READ,
            schema: {
                type: 'object',
                properties: {}
            },
            handler: async () => {
                const jobs = scheduler.listJobs();
                return {
                    ok: true,
                    jobs
                };
            },
            dryRunSimulate: async () => {
                return {
                    simulatedAction: 'list_active_reminders'
                };
            }
        });

        registry.registerTool({
            id: 'cancel_reminder',
            name: 'Cancel Reminder',
            description: 'Cancel a pending proactive reminder or recurring schedule by ID',
            riskTier: RISK_TIERS.SAFE_READ,
            schema: {
                type: 'object',
                properties: {
                    id: {
                        type: 'string',
                        description: 'Unique task or reminder ID to cancel'
                    }
                },
                required: ['id']
            },
            handler: async (params) => {
                const cancelled = scheduler.cancelJob(params.id);
                return {
                    ok: true,
                    cancelled,
                    id: params.id
                };
            },
            dryRunSimulate: async (params) => {
                return {
                    simulatedAction: 'cancel_reminder',
                    targetId: params.id
                };
            }
        });
    }
}

module.exports = {
    registerStudentWorkflowTools
};
