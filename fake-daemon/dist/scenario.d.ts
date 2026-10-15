import { type FakeDaemon } from './fake-daemon.js';
import type { JsonRpcRequest } from './protocol.js';
import { type AutomationFixture } from './automations.js';
import { type ToolsInput } from './tools.js';
export interface SessionFixture {
    sessionId: string;
    title: string;
    cwd: string;
    updatedAt: number;
    messages: MessageFixture[];
    archivedAt?: string;
    settings?: Record<string, unknown>;
    tags?: Array<{
        name: string;
        metadata?: Record<string, string>;
    }>;
    /** Exists on disk but is not loaded in the Daemon; per-Session RPCs fail until load_session. */
    inactive?: boolean;
    /** Opened by initialize_session and not written to yet; the Daemon lists only written Sessions. */
    unwritten?: boolean;
    /** Branch and uncommitted changes get_git_diff reports; absent means not a Git repository. */
    git?: {
        branch: string;
        files: Array<{
            path: string;
            status: string;
            additions: number;
            deletions: number;
        }>;
    };
    /** The Daemon-managed worktree the Session runs in; its cwd is the worktree's path. */
    worktree?: WorktreeFixture;
    /** A subagent: the calling Session and Task call, and the run its caller's load reports. */
    subagent?: {
        callingSessionId: string;
        callingToolUseId: string;
        subagentType: string;
        description: string;
        status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
        toolUseCount?: number;
        durationMs?: number;
    };
}
export interface WorktreeFixture {
    path: string;
    branch: string;
    lifecycle: 'ephemeral' | 'persistent';
    /** The main checkout the worktree was made from. */
    repoRoot: string;
    /** Set once the Daemon removed the checkout. */
    removedAt?: string;
}
/** A Git repository at a directory, as daemon.list_git_branches reports it. */
export interface GitRepoFixture {
    currentBranch: string;
    branches: string[];
    defaultBranch?: string;
}
/** What daemon.inspect_worktree_deletion finds in a worktree; clean when absent. */
export interface WorktreeInspectionFixture {
    changedFiles?: number;
    additions?: number;
    deletions?: number;
    untrackedFiles?: number;
    localOnlyCommits?: number;
    pullRequest?: {
        state: 'open' | 'merged' | 'closed';
        url?: string;
        title?: string;
    };
    hasRemoteBranch?: boolean;
}
export interface MessageFixture {
    id: string;
    role: 'user' | 'assistant' | 'tool';
    content: Array<Record<string, unknown>>;
    createdAt: number;
    updatedAt: number;
    /** `user_only` for what the model never sees, such as the calls a Script made. */
    visibility: 'both' | 'user_only';
}
export interface HandlerContext {
    daemon: FakeDaemon;
    connectionId: number;
}
export type MethodHandler = (params: Record<string, unknown>, context: HandlerContext, request: JsonRpcRequest) => unknown | Promise<unknown>;
export interface ScenarioInput {
    sessions?: SessionFixture[];
    handlers?: Record<string, MethodHandler>;
    /** Directories the Fake Daemon treats as existing; others fail validation. */
    validDirectories?: string[];
    /** Custom commands (`.factory/commands`) the Daemon lists for every Session. */
    commands?: Array<{
        name: string;
        description: string;
        argumentHint?: string;
    }>;
    /** Skills the Daemon lists; `userInvocable` defaults to true. */
    skills?: ToolsInput['skills'];
    /** Whether the Sessions' Workspaces take project-level skill switches. */
    projectAvailable?: boolean;
    /** MCP Servers the Daemon has, and Factory's registry of ones to add. */
    mcpServers?: ToolsInput['mcpServers'];
    mcpRegistry?: ToolsInput['mcpRegistry'];
    /** Context tokens the breakdown reports for every Session; defaults to 1k per message. */
    contextUsedTokens?: number;
    /** Overrides for the Session defaults the Daemon reports (`management`, say). */
    defaults?: Record<string, unknown>;
    /** The models the Daemon offers, in place of AVAILABLE_MODELS. */
    models?: Array<Record<string, unknown>>;
    /** Files on the computer, by absolute path, that get_workspace_file_content serves. */
    files?: Record<string, {
        mimeType: string;
        base64: string;
    }>;
    /** Sessions open in the Daemon (by any Client) with their working state, for list_opened_sessions. */
    opened?: Array<{
        sessionId: string;
        workingState: string;
    }>;
    /** How long load_session takes, as the real Daemon reading a long Session from disk. */
    loadDelayMs?: number;
    /** Git repositories by directory; initialize_session makes worktrees only of these. */
    gitRepos?: Record<string, GitRepoFixture>;
    /** Worktree setup profiles daemon.list_worktree_setup_profiles reports for every repository. */
    worktreeProfiles?: Array<{
        id: string;
        name: string;
        script?: string;
        source?: 'local' | 'repository';
    }>;
    /** Unsaved work in worktrees, by path, for inspect_worktree_deletion and cleanup_worktree. */
    worktreeInspections?: Record<string, WorktreeInspectionFixture>;
    /** The local Automations the Daemon lists and runs. */
    automations?: AutomationFixture[];
}
export declare const CONTEXT_BUDGET = 200000;
export interface Scenario {
    sessions: SessionFixture[];
    /** Files get_workspace_file_content serves; a test rewrites one to stand for a retaken screenshot. */
    files: Record<string, {
        mimeType: string;
        base64: string;
    }>;
    handlers: Record<string, MethodHandler>;
    handle(request: JsonRpcRequest, context: HandlerContext): Promise<unknown>;
    on(method: string, handler: MethodHandler): void;
}
export declare function createScenario(input: ScenarioInput): Scenario;
export declare const HOST_ID = "11111111-1111-4111-8111-111111111111";
/** Like the Daemon, a load brings the most recent `messageLimit` messages (all without one). */
export declare function loadSessionResult(fixture: SessionFixture, messageLimit?: unknown): Record<string, unknown>;
export declare const AVAILABLE_MODELS: ({
    id: string;
    displayName: string;
    shortDisplayName: string;
    modelProvider: string;
    supportedReasoningEfforts: string[];
    defaultReasoningEffort: string;
    isCustom: boolean;
    tokenMultiplier: number;
    kind: string;
} | {
    kind?: undefined;
    id: string;
    displayName: string;
    shortDisplayName: string;
    modelProvider: string;
    supportedReasoningEfforts: string[];
    defaultReasoningEffort: string;
    isCustom: boolean;
    tokenMultiplier: number;
})[];
export declare function sessionSettings(): Record<string, unknown>;
/** What `daemon.get_default_settings` reports before anything was changed. */
export declare function sessionDefaults(): Record<string, unknown>;
export declare function emptyTokenUsage(): Record<string, number>;
export declare function userMessage(text: string): MessageFixture;
export declare function thinkingBlock(thinking: string, durationMs?: number): Record<string, unknown>;
export declare function assistantMessage(text: string): MessageFixture;
export declare function toolCallMessage(id: string, name: string, input: Record<string, unknown>): MessageFixture;
export declare function toolResultMessage(toolUseId: string, content: string): MessageFixture;
export declare function session(title: string, cwd: string, messages?: MessageFixture[], extra?: Partial<SessionFixture>): SessionFixture;
