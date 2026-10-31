// Schema validation for the Fake Daemon. Outbound messages are checked with the
// zod schemas the SDK exports; the SDK does not export the Daemon request
// envelopes, so inbound frames get an envelope check here and rely on the SDK
// (which built them) for the params.
import { AddUserMessageResultSchema, CloseSessionResultSchema, DaemonRequestPermissionSchema, InitializeSessionResultSchema, InterruptSessionResultSchema, LoadSessionResultSchema, RenameSessionResultSchema, SessionNotificationParamsSchema, UpdateSessionSettingsResultSchema, } from '@factory/droid-sdk';
import { z } from 'zod';
import { JsonRpcRequestSchema } from './protocol.js';
const AuthenticateResult = z.object({ userId: z.string(), orgId: z.string() });
const ConnectionStatusParams = z.object({
    isDroidCLIInPath: z.boolean(),
    droidCLIVersion: z.string().optional(),
    homedir: z.string(),
    platform: z.enum(['darwin', 'linux', 'win32']),
    hostId: z.string().optional(),
});
const AvailableSession = z.object({
    sessionId: z.string(),
    hostId: z.string().optional(),
    updatedAt: z.number(),
    title: z.string().optional(),
    cwd: z.string().optional(),
    repoRoot: z.string().optional(),
    messagesCount: z.number().optional(),
    archivedAt: z.string().optional(),
    callingSessionId: z.string().optional(),
    callingToolUseId: z.string().optional(),
    worktree: z
        .object({
        branch: z.string().optional(),
        lifecycle: z.enum(['ephemeral', 'persistent']).optional(),
        path: z.string().optional(),
        repoRoot: z.string(),
    })
        .optional(),
});
const ListAvailableSessionsResult = z.object({
    sessions: z.array(AvailableSession),
    hasMore: z.boolean(),
    nextCursor: z.number().optional(),
});
// The SDK keeps its cron schemas to itself; this is SessionCronRecordSchema.
const SessionCronRecord = z.object({
    version: z.literal(1),
    id: z.string(),
    status: z.enum(['active', 'held', 'paused', 'running', 'error', 'expired', 'cancelled']),
    source: z.enum(['loop_command', 'cron_tool', 'automation', 'migration']),
    schedule: z.object({
        expression: z.string().trim().min(1),
        recurring: z.boolean(),
        nextRunAt: z.string().optional(),
        firstFireGuardUntil: z.string().optional(),
        timezone: z.literal('UTC'),
    }),
    stats: z.object({
        fireCount: z.number().int().nonnegative(),
        lastRunAt: z.string().optional(),
        lastCompletedAt: z.string().optional(),
        lastError: z.string().optional(),
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
    heldAt: z.string().optional(),
    holdReason: z.string().optional(),
    kind: z.literal('session_prompt'),
    scope: z.object({
        type: z.literal('session'),
        sessionId: z.string(),
        sessionCwd: z.string(),
        storageDir: z.string(),
    }),
    runPolicy: z.object({ whenSessionInactive: z.literal('hold') }),
    payload: z.object({
        type: z.literal('prompt'),
        prompt: z.string().trim().min(1),
        target: z.object({ type: z.literal('same_session') }),
    }),
});
/** Result schema per Daemon method; a method missing here is sent unchecked. */
const RESULT_SCHEMAS = {
    'daemon.authenticate': AuthenticateResult,
    'daemon.list_available_sessions': ListAvailableSessionsResult,
    'daemon.load_session': LoadSessionResultSchema,
    'daemon.initialize_session': InitializeSessionResultSchema,
    'daemon.add_user_message': AddUserMessageResultSchema,
    'daemon.interrupt_session': InterruptSessionResultSchema,
    'daemon.rename_session': RenameSessionResultSchema,
    'daemon.update_session_settings': UpdateSessionSettingsResultSchema,
    'daemon.close_session': CloseSessionResultSchema,
    'daemon.archive_session': z.object({ success: z.boolean(), archivedAt: z.string() }),
    'daemon.validate_working_directory': z.object({
        isValid: z.boolean(),
        error: z.string().optional(),
        resolvedPath: z.string().optional(),
    }),
    'daemon.unarchive_session': z.object({ success: z.boolean() }),
    'daemon.list_crons': z.object({ crons: z.array(SessionCronRecord) }),
    'daemon.create_cron': z.object({ cron: SessionCronRecord }),
    'daemon.update_cron': z.object({ cron: SessionCronRecord.nullable() }),
    'daemon.delete_cron': z.object({ deleted: z.boolean() }),
    'daemon.hold_session_crons': z.object({ heldCount: z.number().int().nonnegative() }),
    'daemon.resume_session_crons': z.object({ resumedCount: z.number().int().nonnegative() }),
};
// The Daemon sends a Session's lifecycle on the same method; the SDK does not
// export the wider schema that covers it.
const SessionInactivityParams = z.object({
    sessionId: z.string(),
    notification: z.object({
        type: z.literal('session_inactivity'),
        message: z.string(),
        timestamp: z.number(),
        timeoutSeconds: z.number(),
    }),
});
// Newer than the SDK's schemas: droid 0.244 sends it when the Client starts a
// spec handoff's Session.
const SpecHandoffSessionCreatedParams = z.object({
    sessionId: z.string(),
    notification: z.object({
        type: z.literal('spec_handoff_session_created'),
        newSessionId: z.string(),
        initialPrompt: z.string(),
        specHandoffId: z.string().optional(),
        timestamp: z.number(),
    }),
});
// Newer than the SDK's schemas (droid 1.1): queued AskUser sets the session
// resolved, and a Task child settled on its parent's word.
const AskUserResolvedParams = z.object({
    sessionId: z.string(),
    notification: z.object({
        type: z.literal('ask_user_resolved'),
        requestIds: z.array(z.string()),
    }),
});
const ChildSessionSettledParams = z.object({
    sessionId: z.string(),
    notification: z.object({
        type: z.literal('child_session_settled'),
        childSessionId: z.string(),
        toolUseId: z.string().optional(),
        status: z.string(),
        timestamp: z.number(),
    }),
});
function either(first, ...rest) {
    return {
        safeParse(value) {
            const result = first.safeParse(value);
            const [next, ...others] = rest;
            return result.success || !next ? result : either(next, ...others).safeParse(value);
        },
    };
}
const NOTIFICATION_SCHEMAS = {
    'daemon.session_notification': either(SessionNotificationParamsSchema, SessionInactivityParams, SpecHandoffSessionCreatedParams, AskUserResolvedParams, ChildSessionSettledParams),
    'daemon.connection_status': ConnectionStatusParams,
    'daemon.session.archive_state_changed': z.object({
        sessionId: z.string(),
        archivedAt: z.string().optional(),
    }),
    'daemon.worktree.removed': z.object({ checkoutPath: z.string() }),
    'daemon.cron.state_changed': z.object({
        reason: z.enum(['created', 'updated', 'deleted']),
        cronIds: z.array(z.string()),
        crons: z.array(SessionCronRecord).optional(),
    }),
    'daemon.worktree.branch_changed': z.object({
        checkoutPath: z.string(),
        branch: z.string().optional(),
    }),
};
const REQUEST_SCHEMAS = {
    'daemon.request_permission': DaemonRequestPermissionSchema,
};
/** Remembers which method each outbound response answers. */
const methodById = new Map();
export function rememberMethod(id, method) {
    methodById.set(id, method);
}
export function validateInboundEnvelope(message) {
    const parsed = JsonRpcRequestSchema.safeParse(message);
    if (!parsed.success) {
        throw new Error(`Fake Daemon received an invalid request envelope: ${parsed.error.message}\n${JSON.stringify(message).slice(0, 500)}`);
    }
    rememberMethod(parsed.data.id, parsed.data.method);
    return parsed.data;
}
export function validateOutbound(message) {
    const type = message['type'];
    if (type === 'response') {
        if ('error' in message)
            return;
        const method = methodById.get(message['id']);
        const schema = method ? RESULT_SCHEMAS[method] : undefined;
        if (schema)
            check(schema, message['result'], `${method} result`);
        return;
    }
    if (type === 'notification') {
        const method = String(message['method']);
        const schema = NOTIFICATION_SCHEMAS[method];
        if (!schema)
            throw new Error(`Fake Daemon has no schema for notification ${method}`);
        check(schema, message['params'], `${method} params`);
        return;
    }
    if (type === 'request') {
        const method = String(message['method']);
        const schema = REQUEST_SCHEMAS[method];
        if (schema)
            check(schema, message, method);
        return;
    }
    throw new Error(`Fake Daemon tried to send a message without a type: ${JSON.stringify(message)}`);
}
function check(schema, value, label) {
    const result = schema.safeParse(value);
    if (!result.success) {
        throw new Error(`Fake Daemon Scenario produced an invalid ${label}: ${result.error?.message}\n${JSON.stringify(value).slice(0, 800)}`);
    }
}
