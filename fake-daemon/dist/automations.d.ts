import type { MethodHandler, SessionFixture } from './scenario.js';
export interface AutomationRunFixture {
    sessionId: string;
    status: 'success' | 'in_progress' | 'failed';
    startedAt: string;
    completedAt?: string;
    type?: 'run' | 'create';
}
export interface AutomationFixture {
    id: string;
    name: string;
    prompt: string;
    /** A cron expression in UTC. */
    schedule: string;
    /** Defaults to active. */
    status?: 'active' | 'paused' | 'invalid';
    model?: string;
    nextRunAt?: string;
    lastRunAt?: string;
    lastRunStatus?: string;
    /** The folder; defaults to /Users/dev/.factory/automations/<id>. */
    path?: string;
    runs?: AutomationRunFixture[];
}
export declare function automationHandlers(input: {
    automations?: AutomationFixture[];
}, sessions: SessionFixture[]): Record<string, MethodHandler>;
