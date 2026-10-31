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
/**
 * What daemon.load_session reports of a Session's scripted turn, as the real
 * Daemon does: whether the agent loop runs, the messages it holds for after
 * the turn (queuedMessages), and the requests it admitted
 * (pendingMessageRequestIds: the running turn's and the held ones).
 */
export declare function turnLoadState(sessionId: string): Record<string, unknown>;
/** Wraps a `daemon.load_session` handler so that its result reports {@link turnLoadState}. */
export declare function withTurnState(load: MethodHandler): MethodHandler;
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
export interface QueuedAskUserTurnOptions {
    question: string;
    options: string[];
    /** The set's explanation the Client shows above its question. */
    context: string;
    /** What the agent streams while the question waits. */
    reply: string;
}
/**
 * Handler for `daemon.add_user_message` where the agent queues a question
 * (droid 1.1's AskUser with `blocking: false`) and keeps working: the tool
 * returns at once and the turn ends with `reply`. When a Client answers, the
 * Daemon saves a user-only receipt, reports the set resolved to every Client
 * (`ask_user_resolved`), and gives the agent the record as a user message
 * that starts a turn, as droid 1.1 does.
 */
export declare function queuedAskUserTurn(options: QueuedAskUserTurnOptions): MethodHandler;
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
export interface SpecTurnOptions {
    plan: string;
    title?: string;
    /** Reply streamed once the plan is approved, and in a Session not in Spec mode. */
    reply: string;
}
/**
 * Handler for `daemon.add_user_message` in a Session in Spec mode: the agent
 * presents the plan with ExitSpecMode and asks for approval, then acts on the
 * answer as droid 0.244 does: stays in Spec mode on `cancel`, leaves it and
 * implements (streams the reply) on `proceed_once` and `proceed_auto_run_*`,
 * and on `proceed_new_session*` creates the implementing Session, which the
 * Client starts when it answered with `clientStartsHandoffSession`. In a
 * Session not in Spec mode, such as that new one, it only streams the reply.
 */
export declare function specTurn(options: SpecTurnOptions): MethodHandler;
