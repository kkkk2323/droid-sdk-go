import { type GatewayMeta } from './gateway.js';
import { type Scenario, type ScenarioInput } from './scenario.js';
/** A Scratch Workspace request the Client sent the Gateway (droi's ADR 0008). */
export interface ScratchRequest {
    action: 'create' | 'trash' | 'restore';
    path: string;
}
/** Where the Fake Daemon's Gateway makes Scratch Workspaces. */
export declare const SCRATCH_FOLDER = "/Users/test/.droi/chats";
/** Where the Fake Daemon's computer keeps Session transcripts. */
export declare const SESSIONS_FOLDER = "/Users/test/.factory/sessions";
export interface RecordedRequest {
    connectionId: number;
    method: string;
    params: unknown;
    id: string | number | null;
}
export declare class FakeDaemon {
    #private;
    /** The Droi version /meta answers from now on; a Client compares it with its own. */
    static appVersion: string;
    /** The current Pairing Token; resetToken() replaces it. */
    token: string;
    /** What /meta answers, as the Gateway would; tests may change it. */
    meta: GatewayMeta;
    readonly url: string;
    readonly requests: RecordedRequest[];
    readonly scratchRequests: ScratchRequest[];
    /** Scratch Workspaces that exist, so validate_working_directory accepts them. */
    readonly scratchFolders: Set<string>;
    readonly scenario: Scenario;
    private constructor();
    static start(input?: ScenarioInput): Promise<FakeDaemon>;
    acceptsToken(url: URL): boolean;
    /** Simulate the Daemon process dying: sockets drop and upgrades fail. */
    goDown(): void;
    /** Simulate the Desktop Shell restarting the Daemon. */
    comeBack(): void;
    /** Simulate the Pairing Token being reset in the Desktop Shell. */
    revokeToken(): void;
    /** Simulate "Reset pairing" in the Desktop Shell: a new token, the old one refused. */
    resetToken(): string;
    /** Where the Daemon would keep the Session's transcript, laid out as the real one does. */
    sessionFile(sessionId: string): string | null;
    get connectionCount(): number;
    /** Wait until the Client has sent a request with this method (the nth one, 1-based). */
    waitForRequest(method: string, nth?: number, timeoutMs?: number): Promise<RecordedRequest>;
    /** Push a Session notification to every connection. */
    notify(sessionId: string, notification: Record<string, unknown>): void;
    /** A Daemon-level notification, such as daemon.worktree.removed. */
    notifyDaemon(method: string, params: Record<string, unknown>): void;
    /** Daemon-level (not Session-level) notification about archive state. */
    notifyArchiveState(sessionId: string, archivedAt: string | undefined): void;
    /**
     * Send a Daemon-originated request (permission or ask-user) to every
     * connection and resolve with the first answer, mirroring ADR 0003.
     */
    request(method: string, params: Record<string, unknown>): {
        id: string;
        answer: Promise<Record<string, unknown>>;
    };
    stop(): Promise<void>;
}
export declare class RpcError extends Error {
    readonly code: number;
    constructor(code: number, message: string);
}
