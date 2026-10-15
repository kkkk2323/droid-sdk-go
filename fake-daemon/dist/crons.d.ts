import type { MethodHandler } from './scenario.js';
export interface CronFixture {
    /** Defaults to a fresh id. */
    id?: string;
    sessionId: string;
    /** Defaults to /Users/dev/project. */
    sessionCwd?: string;
    prompt: string;
    /** A 5-field cron expression in UTC. */
    expression: string;
    /** Defaults to active. */
    status?: 'active' | 'held' | 'paused' | 'running' | 'error' | 'expired' | 'cancelled';
    holdReason?: string;
    nextRunAt?: string;
    fireCount?: number;
    lastRunAt?: string;
    lastError?: string;
    /** Defaults to loop_command. */
    source?: 'loop_command' | 'cron_tool';
}
export declare function cronHandlers(input: {
    crons?: CronFixture[];
}): Record<string, MethodHandler>;
