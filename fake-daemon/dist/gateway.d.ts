export declare const GATEWAY_DAEMON_PATH = "/daemon";
export declare const GATEWAY_TOKEN_QUERY = "token";
export declare const GATEWAY_META_PATH = "/meta";
export interface GatewayMeta {
    app: 'Droi';
    version: string;
    remoteAccess: boolean;
    name: string;
    computerId: string;
}
export declare const GATEWAY_SCRATCH_PATH = "/scratch-workspaces";
export declare const GATEWAY_SCRATCH_TRASH_PATH = "/scratch-workspaces/trash";
export declare const GATEWAY_SCRATCH_RESTORE_PATH = "/scratch-workspaces/restore";
export declare const GATEWAY_SCRATCH_PATH_QUERY = "path";
export declare const GATEWAY_SESSION_FILE_PATH = "/session-file";
export declare const GATEWAY_SESSION_ID_QUERY = "sessionId";
