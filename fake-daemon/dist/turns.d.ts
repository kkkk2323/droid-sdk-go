import type { HandlerContext, MethodHandler } from './scenario.js';
export interface StreamedReplyOptions {
    /** Text chunks streamed as assistant_text_delta, in order. */
    deltas: string[];
    /** Gap between deltas. */
    delayMs?: number;
    /** Called after the user message is acknowledged; return false to stop before replying. */
    onTurnStart?: (turn: TurnHandle) => void;
}
export interface TurnHandle {
    sessionId: string;
    turnId: string;
    cancel(): void;
}
/**
 * Handler for `daemon.add_user_message` that echoes the user message and then
 * streams a reply. The returned handler resolves the RPC immediately and runs
 * the turn in the background, like the real Daemon.
 */
export declare function streamedReply(options: StreamedReplyOptions): MethodHandler;
/** 10k of prompt (input + cache read) on every scripted call. */
export declare const LAST_CALL_TOKEN_USAGE: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    thinkingTokens: number;
};
/**
 * Wraps an `add_user_message` handler so that, like the real Daemon, a message
 * arriving mid-turn is held and run after the turn: `end_of_turn` ones first,
 * then `end_of_loop` ones.
 */
export declare function withQueue(handler: MethodHandler): MethodHandler;
/** Handler for `daemon.resolve_queued_user_message`: only `delete` is scripted. */
export declare const resolveQueuedHandler: MethodHandler;
/**
 * Handler for `daemon.interrupt_session`: ends the running turn as cancelled
 * and, like the real Daemon, drops the messages it was holding for it.
 */
export declare const interruptHandler: MethodHandler;
export type { HandlerContext };
export interface PermissionTurnOptions {
    command: string;
    /** Reply streamed after the tool ran. */
    reply: string;
    /** Text of the tool result when allowed. */
    toolOutput?: string;
}
/**
 * Handler for `daemon.add_user_message` where the agent wants to run a shell
 * command and asks every attached Client for permission first (ADR 0003).
 */
export declare function permissionTurn(options: PermissionTurnOptions): MethodHandler;
export interface AskUserTurnOptions {
    question: string;
    options: string[];
    multiSelect?: boolean;
}
/** Handler for `daemon.add_user_message` where the agent asks the user a question first. */
export declare function askUserTurn(options: AskUserTurnOptions): MethodHandler;
export interface TodoTurnOptions {
    todos: Array<{
        id: string;
        content: string;
        status: 'pending' | 'in_progress' | 'completed';
    }>;
    reply: string;
}
/** Handler for `daemon.add_user_message` where the agent writes a task list, then replies. */
export declare function todoTurn(options: TodoTurnOptions): MethodHandler;
/**
 * Handler for `daemon.add_user_message` in a Session started with
 * `structuredOutputFormat`, such as a Memory Session (ADR 0011): the turn ends
 * with a `structured_output` notification carrying `reply(text)`.
 */
export declare function structuredTurn(reply: (text: string) => Record<string, unknown>): MethodHandler;
export interface ScriptTurnOptions {
    /** Reply streamed after the run finished. */
    reply: string;
}
/**
 * Handler for `daemon.add_user_message` where the agent writes one Script
 * that runs two commands. The Daemon reads the calls out of the source and
 * asks for all of them at once; once allowed, each call arrives as a
 * user-only message tagged with the run, as droid 0.231 sends them.
 */
export declare function scriptTurn(options: ScriptTurnOptions): MethodHandler;
