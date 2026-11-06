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
/** How a turn ended, as the Daemon writes it into the Session's transcript. */
export interface TurnOutcome {
    reason: string;
    /** The text of the turn's last reply; empty when it replied none. */
    finalOutput: string;
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
    /**
     * How a Session's turn ended and its last reply, as droid 1.4.1's
     * daemon.get_session_turn_outcome reads them from the transcript: none for a
     * turn still running, or one whose prompt the transcript does not have.
     */
    turnOutcome(sessionId: string, turnId: string): TurnOutcome | undefined;
    /**
     * The requests of a method the Daemon sent about a Session that no Client
     * answered yet, as daemon.load_session reports them.
     */
    pendingRequests(method: string, sessionId: string): Array<{
        id: string;
        params: Record<string, unknown>;
    }>;
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
