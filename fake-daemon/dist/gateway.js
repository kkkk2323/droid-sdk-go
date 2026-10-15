// What the Fake Daemon answers as droi's Gateway: its paths, query parameters
// and /meta. A copy of the contract in droi (packages/daemon-layer/src/gateway.ts);
// droi's Phone App suite fails when the two drift apart.
export const GATEWAY_DAEMON_PATH = '/daemon';
export const GATEWAY_TOKEN_QUERY = 'token';
export const GATEWAY_META_PATH = '/meta';
export const GATEWAY_SCRATCH_PATH = '/scratch-workspaces';
export const GATEWAY_SCRATCH_TRASH_PATH = '/scratch-workspaces/trash';
export const GATEWAY_SCRATCH_RESTORE_PATH = '/scratch-workspaces/restore';
export const GATEWAY_SCRATCH_PATH_QUERY = 'path';
export const GATEWAY_SESSION_FILE_PATH = '/session-file';
export const GATEWAY_SESSION_ID_QUERY = 'sessionId';
