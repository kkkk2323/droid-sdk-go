// Scripted agent turns for Scenarios. Each helper emits the same notification
// sequence a real Daemon produces (captured in docs/adr/0003-spike/raw.txt).
import { randomUUID } from 'node:crypto';
import { emptyTokenUsage, session, sessionSettings } from './scenario.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Handler for `daemon.add_user_message` that echoes the user message and then
 * streams a reply. The returned handler resolves the RPC immediately and runs
 * the turn in the background, like the real Daemon.
 */
export function streamedReply(options) {
    return (params, context, request) => {
        const sessionId = String(params['sessionId']);
        const text = String(params['text']);
        const userMessageId = typeof params['messageId'] === 'string' ? params['messageId'] : randomUUID();
        void runTurn({
            daemon: context.daemon,
            sessionId,
            requestId: String(request.id),
            userMessageId,
            text,
            content: Array.isArray(params['images'])
                ? [
                    { type: 'text', text },
                    ...params['images'].map((image) => ({
                        type: 'image',
                        source: image,
                    })),
                ]
                : undefined,
            ...options,
        });
        return {};
    };
}
const activeTurns = new Map();
/** 10k of prompt (input + cache read) on every scripted call. */
export const LAST_CALL_TOKEN_USAGE = {
    inputTokens: 8_000,
    outputTokens: 300,
    cacheCreationTokens: 2_000,
    cacheReadTokens: 2_000,
    thinkingTokens: 0,
};
/** Messages a Session received while a turn ran, in arrival order. */
const heldMessages = new Map();
const queueHandlers = new Map();
/**
 * Wraps an `add_user_message` handler so that, like the real Daemon, a message
 * arriving mid-turn is held and run after the turn: `end_of_turn` ones first,
 * then `end_of_loop` ones.
 */
export function withQueue(handler) {
    return (params, context, request) => {
        const sessionId = String(params['sessionId']);
        queueHandlers.set(sessionId, handler);
        if (!activeTurns.has(sessionId))
            return handler(params, context, request);
        const placement = params['queuePlacement'] === 'end_of_turn' ? 'end_of_turn' : 'end_of_loop';
        const held = heldMessages.get(sessionId) ?? [];
        held.push({ request, params, context, placement });
        heldMessages.set(sessionId, held);
        return {};
    };
}
/** Handler for `daemon.resolve_queued_user_message`: only `delete` is scripted. */
export const resolveQueuedHandler = (params) => {
    const sessionId = String(params['sessionId']);
    const held = heldMessages.get(sessionId) ?? [];
    heldMessages.set(sessionId, held.filter((m) => String(m.request.id) !== String(params['requestId'])));
    return {};
};
function drainHeld(sessionId) {
    const held = heldMessages.get(sessionId) ?? [];
    const next = held.find((m) => m.placement === 'end_of_turn') ?? held[0];
    const handler = queueHandlers.get(sessionId);
    if (!next || !handler)
        return;
    heldMessages.set(sessionId, held.filter((m) => m !== next));
    void handler(next.params, next.context, next.request);
}
/**
 * Handler for `daemon.interrupt_session`: ends the running turn as cancelled
 * and, like the real Daemon, drops the messages it was holding for it.
 */
export const interruptHandler = (params, context) => {
    const sessionId = String(params['sessionId']);
    const turn = activeTurns.get(sessionId);
    if (turn) {
        turn.cancel();
        finishTurn(context.daemon, sessionId, turn.turnId, 'cancelled');
    }
    const held = heldMessages.get(sessionId) ?? [];
    if (held.length > 0) {
        heldMessages.set(sessionId, []);
        context.daemon.notify(sessionId, {
            type: 'queued_messages_discarded',
            text: `Discarded ${held.length} queued message(s)`,
        });
    }
    return {};
};
async function runTurn(input) {
    const { daemon, sessionId, requestId, userMessageId, text } = input;
    const now = Date.now();
    const turn = {
        sessionId,
        turnId: userMessageId,
        cancelled: false,
        cancel() {
            this.cancelled = true;
        },
    };
    activeTurns.set(sessionId, turn);
    daemon.notify(sessionId, {
        type: 'droid_working_state_changed',
        newState: 'streaming_assistant_message',
    });
    daemon.notify(sessionId, {
        type: 'create_message',
        message: {
            id: userMessageId,
            role: 'user',
            content: input.content ?? [{ type: 'text', text }],
            createdAt: now,
            updatedAt: now,
        },
        requestId,
    });
    daemon.notify(sessionId, { type: 'droid_working_state_changed', newState: 'thinking' });
    input.onTurnStart?.(turn);
    const assistantMessageId = randomUUID();
    let full = '';
    for (const delta of input.deltas) {
        await sleep(input.delayMs ?? 150);
        if (turn.cancelled)
            return;
        if (full === '') {
            daemon.notify(sessionId, {
                type: 'droid_working_state_changed',
                newState: 'streaming_assistant_message',
            });
        }
        full += delta;
        daemon.notify(sessionId, {
            type: 'assistant_text_delta',
            messageId: assistantMessageId,
            blockIndex: 0,
            textDelta: delta,
        });
    }
    if (turn.cancelled)
        return;
    daemon.notify(sessionId, {
        type: 'assistant_text_complete',
        messageId: assistantMessageId,
        blockIndex: 0,
    });
    const done = Date.now();
    daemon.notify(sessionId, {
        type: 'create_message',
        message: {
            id: assistantMessageId,
            role: 'assistant',
            content: [{ type: 'text', text: full }],
            createdAt: done,
            updatedAt: done,
        },
        parentId: userMessageId,
    });
    finishTurn(daemon, sessionId, userMessageId, 'completed');
}
function finishTurn(daemon, sessionId, turnId, reason) {
    activeTurns.delete(sessionId);
    daemon.notify(sessionId, {
        type: 'agent_turn_completed',
        reason,
        turnId,
        tokenUsage: emptyTokenUsage(),
    });
    // What the last model call cost; the Client's context meter reads its size.
    daemon.notify(sessionId, {
        type: 'session_token_usage_changed',
        sessionId,
        tokenUsage: emptyTokenUsage(),
        lastCallTokenUsage: LAST_CALL_TOKEN_USAGE,
    });
    daemon.notify(sessionId, { type: 'droid_working_state_changed', newState: 'idle' });
    if (reason === 'completed' || reason === 'spec_handoff')
        drainHeld(sessionId);
    else
        heldMessages.delete(sessionId);
}
/**
 * Handler for `daemon.add_user_message` where the agent wants to run a shell
 * command and asks every attached Client for permission first (ADR 0003).
 */
export function permissionTurn(options) {
    return (params, context, request) => {
        const sessionId = String(params['sessionId']);
        const daemon = context.daemon;
        const userMessageId = typeof params['messageId'] === 'string' ? params['messageId'] : randomUUID();
        void (async () => {
            startTurn(daemon, sessionId, userMessageId, String(params['text']), String(request.id));
            const toolUseId = `call_${randomUUID().slice(0, 8)}`;
            const toolUse = {
                type: 'tool_use',
                id: toolUseId,
                name: 'Execute',
                input: { command: options.command, summary: 'Run a command', riskLevel: 'low' },
            };
            daemon.notify(sessionId, { type: 'tool_call', toolUse });
            daemon.notify(sessionId, {
                type: 'droid_working_state_changed',
                newState: 'waiting_for_tool_confirmation',
            });
            const { id, answer } = daemon.request('daemon.request_permission', {
                sessionId,
                toolUses: [
                    {
                        toolUse,
                        confirmationType: 'exec',
                        details: {
                            type: 'exec',
                            fullCommand: options.command,
                            command: options.command.split(' ')[0],
                            impactLevel: 'low',
                        },
                    },
                ],
                options: [
                    { label: 'Yes, allow', value: 'proceed_once' },
                    { label: 'Yes, and always allow low impact commands', value: 'proceed_always' },
                    { label: 'No, cancel', value: 'cancel' },
                ],
            });
            const response = await answer;
            const selectedOption = String(response['result']?.['selectedOption'] ?? 'cancel');
            daemon.notify(sessionId, {
                type: 'permission_resolved',
                requestId: id,
                toolUseIds: [toolUseId],
                selectedOption,
            });
            if (selectedOption === 'cancel') {
                const now = Date.now();
                daemon.notify(sessionId, {
                    type: 'tool_result',
                    toolUseId,
                    content: 'Command cancelled by user.',
                    isError: true,
                    messageId: randomUUID(),
                });
                daemon.notify(sessionId, {
                    type: 'create_message',
                    message: {
                        id: randomUUID(),
                        role: 'assistant',
                        content: [{ type: 'text', text: 'Understood, I will not run that.' }],
                        createdAt: now,
                        updatedAt: now,
                    },
                });
                finishTurn(daemon, sessionId, userMessageId, 'permission_rejected');
                return;
            }
            daemon.notify(sessionId, { type: 'droid_working_state_changed', newState: 'executing_tool' });
            await sleep(100);
            daemon.notify(sessionId, {
                type: 'tool_result',
                toolUseId,
                content: options.toolOutput ?? 'ok\n\n[Process exited with code 0]',
                isError: false,
                messageId: randomUUID(),
            });
            await streamText(daemon, sessionId, options.reply);
            finishTurn(daemon, sessionId, userMessageId, 'completed');
        })();
        return {};
    };
}
/** Handler for `daemon.add_user_message` where the agent asks the user a question first. */
export function askUserTurn(options) {
    return (params, context, request) => {
        const sessionId = String(params['sessionId']);
        const daemon = context.daemon;
        const userMessageId = typeof params['messageId'] === 'string' ? params['messageId'] : randomUUID();
        void (async () => {
            startTurn(daemon, sessionId, userMessageId, String(params['text']), String(request.id));
            const toolUseId = `call_${randomUUID().slice(0, 8)}`;
            daemon.notify(sessionId, {
                type: 'tool_call',
                toolUse: { type: 'tool_use', id: toolUseId, name: 'AskUser', input: {} },
            });
            daemon.notify(sessionId, {
                type: 'droid_working_state_changed',
                newState: 'waiting_for_tool_confirmation',
            });
            const { answer } = daemon.request('daemon.ask_user', {
                sessionId,
                toolCallId: toolUseId,
                questions: [
                    {
                        index: 1,
                        topic: 'Choice',
                        question: options.question,
                        options: options.options,
                        ...(options.multiSelect ? { multiSelect: true } : {}),
                    },
                ],
            });
            const response = await answer;
            const result = response['result'];
            if (result?.['cancelled'] === true) {
                daemon.notify(sessionId, {
                    type: 'tool_result',
                    toolUseId,
                    content: 'The user cancelled the questionnaire.',
                    isError: true,
                    messageId: randomUUID(),
                });
                await streamText(daemon, sessionId, 'Understood, I will not ask.');
                finishTurn(daemon, sessionId, userMessageId, 'completed');
                return;
            }
            const answers = (result?.['answers'] ?? []);
            const chosen = answers.map((a) => a.answer).join(', ');
            daemon.notify(sessionId, {
                type: 'tool_result',
                toolUseId,
                content: `[answer] ${chosen}`,
                isError: false,
                messageId: randomUUID(),
            });
            await streamText(daemon, sessionId, `You chose ${chosen}.`);
            finishTurn(daemon, sessionId, userMessageId, 'completed');
        })();
        return {};
    };
}
function startTurn(daemon, sessionId, userMessageId, text, requestId) {
    const now = Date.now();
    daemon.notify(sessionId, {
        type: 'droid_working_state_changed',
        newState: 'streaming_assistant_message',
    });
    daemon.notify(sessionId, {
        type: 'create_message',
        message: {
            id: userMessageId,
            role: 'user',
            content: [{ type: 'text', text }],
            createdAt: now,
            updatedAt: now,
        },
        requestId,
    });
    daemon.notify(sessionId, { type: 'droid_working_state_changed', newState: 'thinking' });
}
async function streamText(daemon, sessionId, text) {
    const messageId = randomUUID();
    daemon.notify(sessionId, {
        type: 'droid_working_state_changed',
        newState: 'streaming_assistant_message',
    });
    const words = text.split(' ');
    for (let i = 0; i < words.length; i++) {
        await sleep(40);
        daemon.notify(sessionId, {
            type: 'assistant_text_delta',
            messageId,
            blockIndex: 0,
            textDelta: (i === 0 ? '' : ' ') + words[i],
        });
    }
    daemon.notify(sessionId, { type: 'assistant_text_complete', messageId, blockIndex: 0 });
    const now = Date.now();
    daemon.notify(sessionId, {
        type: 'create_message',
        message: {
            id: messageId,
            role: 'assistant',
            content: [{ type: 'text', text }],
            createdAt: now,
            updatedAt: now,
        },
    });
}
/** Handler for `daemon.add_user_message` where the agent writes a task list, then replies. */
export function todoTurn(options) {
    return (params, context, request) => {
        const sessionId = String(params['sessionId']);
        const daemon = context.daemon;
        const userMessageId = typeof params['messageId'] === 'string' ? params['messageId'] : randomUUID();
        void (async () => {
            startTurn(daemon, sessionId, userMessageId, String(params['text']), String(request.id));
            activeTurns.set(sessionId, {
                sessionId,
                turnId: userMessageId,
                cancelled: false,
                cancel() { },
            });
            const toolUseId = `call_${randomUUID().slice(0, 8)}`;
            daemon.notify(sessionId, {
                type: 'tool_call',
                toolUse: {
                    type: 'tool_use',
                    id: toolUseId,
                    name: 'TodoWrite',
                    input: { todos: options.todos.map((t) => ({ ...t, priority: 'medium' })) },
                },
            });
            daemon.notify(sessionId, { type: 'droid_working_state_changed', newState: 'executing_tool' });
            await sleep(50);
            daemon.notify(sessionId, {
                type: 'tool_result',
                toolUseId,
                content: 'TODO List Updated',
                isError: false,
                messageId: randomUUID(),
            });
            await streamText(daemon, sessionId, options.reply);
            finishTurn(daemon, sessionId, userMessageId, 'completed');
        })();
        return {};
    };
}
/**
 * Handler for `daemon.add_user_message` in a Session started with
 * `structuredOutputFormat`, such as a Memory Session (ADR 0011): the turn ends
 * with a `structured_output` notification carrying `reply(text)`.
 */
export function structuredTurn(reply) {
    return (params, context, request) => {
        const sessionId = String(params['sessionId']);
        const daemon = context.daemon;
        const text = String(params['text']);
        const userMessageId = typeof params['messageId'] === 'string' ? params['messageId'] : randomUUID();
        void (async () => {
            startTurn(daemon, sessionId, userMessageId, text, String(request.id));
            await sleep(50);
            const structuredOutput = reply(text);
            const messageId = randomUUID();
            const now = Date.now();
            daemon.notify(sessionId, {
                type: 'create_message',
                message: {
                    id: messageId,
                    role: 'assistant',
                    content: [{ type: 'text', text: JSON.stringify(structuredOutput) }],
                    createdAt: now,
                    updatedAt: now,
                },
                parentId: userMessageId,
            });
            daemon.notify(sessionId, { type: 'structured_output', messageId, structuredOutput });
            finishTurn(daemon, sessionId, userMessageId, 'completed');
        })();
        return {};
    };
}
/**
 * Handler for `daemon.add_user_message` where the agent writes one Script
 * that runs two commands. The Daemon reads the calls out of the source and
 * asks for all of them at once; once allowed, each call arrives as a
 * user-only message tagged with the run, as droid 0.231 sends them.
 */
export function scriptTurn(options) {
    return (params, context, request) => {
        const sessionId = String(params['sessionId']);
        const daemon = context.daemon;
        const userMessageId = typeof params['messageId'] === 'string' ? params['messageId'] : randomUUID();
        void (async () => {
            startTurn(daemon, sessionId, userMessageId, String(params['text']), String(request.id));
            const runId = `call_${randomUUID().slice(0, 8)}`;
            const script = [
                "const tests = await tools.Execute({ summary: 'Run the tests', command: 'pnpm test', riskLevel: 'low' })",
                'text(tests)',
                "const lint = await tools.Execute({ summary: 'Lint', command: 'pnpm lint', riskLevel: 'medium' })",
                'text(lint)',
            ].join('\n');
            const toolUse = { type: 'tool_use', id: runId, name: 'Script', input: { script } };
            daemon.notify(sessionId, { type: 'tool_call', toolUse });
            // The real Daemon commits the Script's message before it asks, so the
            // calls the run makes have their Script to hang under.
            const committed = Date.now();
            daemon.notify(sessionId, {
                type: 'create_message',
                message: {
                    id: randomUUID(),
                    role: 'assistant',
                    content: [toolUse],
                    createdAt: committed,
                    updatedAt: committed,
                },
                parentId: userMessageId,
            });
            daemon.notify(sessionId, {
                type: 'droid_working_state_changed',
                newState: 'waiting_for_tool_confirmation',
            });
            const exec = (command, impactLevel) => ({
                type: 'exec',
                fullCommand: command,
                command: command.split(' ')[0],
                extractedCommands: [command.split(' ')[0]],
                impactLevel,
            });
            const { id, answer } = daemon.request('daemon.request_permission', {
                sessionId,
                toolUses: [
                    {
                        toolUse,
                        confirmationType: 'script',
                        details: {
                            type: 'script',
                            impactLevel: 'medium',
                            calls: [
                                {
                                    toolName: 'Execute',
                                    line: 1,
                                    column: 21,
                                    toolInput: { summary: 'Run the tests', command: 'pnpm test', riskLevel: 'low' },
                                    confirmation: exec('pnpm test', 'low'),
                                },
                                {
                                    toolName: 'Execute',
                                    line: 3,
                                    column: 20,
                                    toolInput: { summary: 'Lint', command: 'pnpm lint', riskLevel: 'medium' },
                                    confirmation: exec('pnpm lint', 'medium'),
                                },
                            ],
                        },
                    },
                ],
                options: [
                    { label: 'Yes, allow all', value: 'proceed_once' },
                    { label: 'Yes, and always allow medium impact commands', value: 'proceed_always' },
                    { label: 'No, cancel all', value: 'cancel' },
                ],
            });
            const response = await answer;
            const selectedOption = String(response['result']?.['selectedOption'] ?? 'cancel');
            daemon.notify(sessionId, {
                type: 'permission_resolved',
                requestId: id,
                toolUseIds: [runId],
                selectedOption,
            });
            if (selectedOption === 'cancel') {
                daemon.notify(sessionId, {
                    type: 'tool_result',
                    toolUseId: runId,
                    content: 'Script cancelled by user.',
                    isError: true,
                    messageId: randomUUID(),
                });
                finishTurn(daemon, sessionId, userMessageId, 'permission_rejected');
                return;
            }
            daemon.notify(sessionId, { type: 'droid_working_state_changed', newState: 'executing_tool' });
            const outputs = [];
            for (const [n, summary, command] of [
                [1, 'Run the tests', 'pnpm test'],
                [3, 'Lint', 'pnpm lint'],
            ]) {
                const callId = `${runId}-${n}`;
                const now = Date.now();
                daemon.notify(sessionId, {
                    type: 'create_message',
                    message: {
                        id: `repl-tool-call:${callId}`,
                        role: 'assistant',
                        content: [
                            {
                                type: 'tool_use',
                                id: callId,
                                name: 'Execute',
                                input: { summary, command, riskLevel: 'low' },
                                scriptExecution: { runId, outerToolUseId: runId },
                            },
                        ],
                        createdAt: now,
                        updatedAt: now,
                        visibility: 'user_only',
                    },
                });
                await sleep(150);
                const output = `${command} ok`;
                outputs.push(output);
                daemon.notify(sessionId, {
                    type: 'tool_result',
                    toolUseId: callId,
                    content: `${output}\n\n[Process exited with code 0]`,
                    isError: false,
                    messageId: `repl-tool-result:${callId}`,
                });
            }
            daemon.notify(sessionId, {
                type: 'tool_result',
                toolUseId: runId,
                content: [
                    { type: 'text', text: outputs.join('\n') },
                    {
                        type: 'text',
                        text: `[Script completed · 2 calls · 40 B in sandbox · 26 B emitted (65%) · log: /tmp/${runId}.log]`,
                    },
                    {
                        type: 'text',
                        text: JSON.stringify({ toolCallId: runId, status: 'completed', result: null }),
                    },
                ],
                isError: false,
                messageId: randomUUID(),
            });
            await streamText(daemon, sessionId, options.reply);
            finishTurn(daemon, sessionId, userMessageId, 'completed');
        })();
        return {};
    };
}
const SPEC_OPTIONS = [
    { label: 'Proceed with implementation', value: 'proceed_once' },
    {
        label: 'Proceed, and allow file edits and read-only commands (Low)',
        value: 'proceed_auto_run_low',
    },
    { label: 'Proceed, and allow reversible commands (Medium)', value: 'proceed_auto_run_medium' },
    { label: 'Proceed, and allow all commands (High)', value: 'proceed_auto_run_high' },
    { label: 'Proceed in a new session (no autonomy)', value: 'proceed_new_session' },
    { label: 'Proceed in a new session (Low autonomy)', value: 'proceed_new_session_low' },
    { label: 'Proceed in a new session (Medium autonomy)', value: 'proceed_new_session_medium' },
    { label: 'Proceed in a new session (High autonomy)', value: 'proceed_new_session_high' },
    { label: 'No, keep iterating on spec', value: 'cancel' },
];
const AUTONOMY_MODES = {
    off: 'normal',
    low: 'auto-low',
    medium: 'auto-medium',
    high: 'auto-high',
};
/** The autonomy level a proceed option leaves, as droid 0.244 sets it. */
function autonomyOf(option) {
    return /_(low|medium|high)$/.exec(option)?.[1] ?? 'off';
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
export function specTurn(options) {
    return (params, context, request) => {
        const sessionId = String(params['sessionId']);
        const daemon = context.daemon;
        const userMessageId = typeof params['messageId'] === 'string' ? params['messageId'] : randomUUID();
        const found = daemon.scenario.sessions.find((s) => s.sessionId === sessionId);
        const settings = () => ({ ...sessionSettings(), ...found?.settings });
        void (async () => {
            startTurn(daemon, sessionId, userMessageId, String(params['text']), String(request.id));
            if (settings()['interactionMode'] !== 'spec') {
                await streamText(daemon, sessionId, options.reply);
                finishTurn(daemon, sessionId, userMessageId, 'completed');
                return;
            }
            const toolUseId = `call_${randomUUID().slice(0, 8)}`;
            const title = options.title ?? 'Plan';
            const toolUse = {
                type: 'tool_use',
                id: toolUseId,
                name: 'ExitSpecMode',
                input: { plan: options.plan, title },
            };
            daemon.notify(sessionId, { type: 'tool_call', toolUse });
            const committed = Date.now();
            daemon.notify(sessionId, {
                type: 'create_message',
                message: {
                    id: randomUUID(),
                    role: 'assistant',
                    content: [toolUse],
                    createdAt: committed,
                    updatedAt: committed,
                },
                parentId: userMessageId,
            });
            daemon.notify(sessionId, {
                type: 'droid_working_state_changed',
                newState: 'waiting_for_tool_confirmation',
            });
            const { id, answer } = daemon.request('daemon.request_permission', {
                sessionId,
                toolUses: [
                    {
                        toolUse,
                        confirmationType: 'exit_spec_mode',
                        details: {
                            type: 'exit_spec_mode',
                            plan: options.plan,
                            title,
                            contextSavingsPercent: 1,
                            supportsClientStartedHandoff: true,
                        },
                    },
                ],
                options: SPEC_OPTIONS,
            });
            const result = ((await answer)['result'] ?? {});
            const offered = SPEC_OPTIONS.some((o) => o.value === result['selectedOption']);
            const selectedOption = offered ? String(result['selectedOption']) : 'cancel';
            const toolResult = (content, isError) => daemon.notify(sessionId, {
                type: 'tool_result',
                toolUseId,
                content,
                isError,
                messageId: randomUUID(),
            });
            if (selectedOption === 'cancel') {
                daemon.notify(sessionId, {
                    type: 'permission_resolved',
                    requestId: id,
                    toolUseIds: [],
                    selectedOption,
                });
                toolResult('Error: Plan not approved - remaining in Spec Mode. Provide feedback to refine the spec.', true);
                finishTurn(daemon, sessionId, userMessageId, 'completed');
                return;
            }
            daemon.notify(sessionId, {
                type: 'droid_working_state_changed',
                newState: 'executing_tool',
            });
            daemon.notify(sessionId, {
                type: 'permission_resolved',
                requestId: id,
                toolUseIds: [toolUseId],
                selectedOption,
            });
            const level = autonomyOf(selectedOption);
            const newSession = selectedOption.startsWith('proceed_new_session');
            const leaveSpec = (autonomyLevel) => {
                if (found) {
                    found.settings = {
                        ...settings(),
                        interactionMode: 'auto',
                        autonomyLevel,
                        autonomyMode: AUTONOMY_MODES[autonomyLevel],
                    };
                }
                daemon.notify(sessionId, { type: 'settings_updated', settings: settings() });
            };
            leaveSpec(newSession ? 'off' : level);
            const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            const filePath = `/Users/test/.factory/specs/${slug}.md`;
            if (!newSession) {
                const comment = typeof result['comment'] === 'string' ? result['comment'] : '';
                toolResult(JSON.stringify({
                    approved: true,
                    message: comment
                        ? `Specification was approved but the user has left a required comment to address in the plan. Continue with the implementation.\n\nUser comment: ${comment}`
                        : 'Spec mode exited. The user approved the plan. Continue with the implementation.',
                    filePath,
                    ...(comment ? { userComment: comment } : {}),
                    isEdited: false,
                }), false);
                await streamText(daemon, sessionId, options.reply);
                finishTurn(daemon, sessionId, userMessageId, 'completed');
                return;
            }
            toolResult(JSON.stringify({
                approved: true,
                message: 'Specification has been approved and saved. Start implementation in a new session.',
                filePath,
                handoff: { plan: options.plan, isNewSession: true },
                isEdited: false,
            }), false);
            const initialPrompt = `Implement the following plan:\n\n${options.plan}\n\n\n` +
                'If you need specific details from the planning session (like exact code snippets, ' +
                'error messages, or content generated), read the full transcript at: ' +
                String(daemon.sessionFile(sessionId));
            if (result['clientStartsHandoffSession'] === true) {
                const created = session('New Session', found?.cwd ?? '/', [], {
                    settings: {
                        interactionMode: 'auto',
                        autonomyLevel: level,
                        autonomyMode: AUTONOMY_MODES[level],
                    },
                    inactive: true,
                    unwritten: true,
                });
                daemon.scenario.sessions.unshift(created);
                daemon.notify(sessionId, {
                    type: 'spec_handoff_session_created',
                    newSessionId: created.sessionId,
                    initialPrompt,
                    ...(typeof result['specHandoffId'] === 'string'
                        ? { specHandoffId: result['specHandoffId'] }
                        : {}),
                    timestamp: Date.now(),
                });
                finishTurn(daemon, sessionId, userMessageId, 'spec_handoff');
                return;
            }
            // Without a Client to start it, the Daemon implements in this Session,
            // as a turn of its own inside this one.
            leaveSpec(level);
            const implementId = randomUUID();
            const now = Date.now();
            daemon.notify(sessionId, {
                type: 'create_message',
                message: {
                    id: implementId,
                    role: 'user',
                    content: [{ type: 'text', text: initialPrompt }],
                    createdAt: now,
                    updatedAt: now,
                },
            });
            await streamText(daemon, sessionId, options.reply);
            daemon.notify(sessionId, {
                type: 'agent_turn_completed',
                reason: 'completed',
                turnId: implementId,
                tokenUsage: emptyTokenUsage(),
            });
            finishTurn(daemon, sessionId, userMessageId, 'spec_handoff');
        })();
        return {};
    };
}
