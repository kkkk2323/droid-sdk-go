// Fake Daemon: a scripted stand-in for the Gateway plus Daemon used by the E2E
// tests. It speaks the Daemon JSON-RPC protocol over WebSocket, checks the
// Pairing Token at upgrade exactly like the Gateway does, replays a Scenario
// instead of running an agent, and validates every message it sends with the
// zod schemas exported by @factory/droid-sdk so the Client is exercised with
// realistic data. (See droi's ADR 0002.)
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { GATEWAY_DAEMON_PATH, GATEWAY_META_PATH, GATEWAY_SCRATCH_PATH, GATEWAY_SCRATCH_PATH_QUERY, GATEWAY_SCRATCH_RESTORE_PATH, GATEWAY_SCRATCH_TRASH_PATH, GATEWAY_SESSION_FILE_PATH, GATEWAY_SESSION_ID_QUERY, GATEWAY_TOKEN_QUERY, } from './gateway.js';
import { validateOutbound, validateInboundEnvelope } from './schemas.js';
import { createScenario, HOST_ID } from './scenario.js';
/** Where the Fake Daemon's Gateway makes Scratch Workspaces. */
export const SCRATCH_FOLDER = '/Users/test/.droi/chats';
/** Where the Fake Daemon's computer keeps Session transcripts. */
export const SESSIONS_FOLDER = '/Users/test/.factory/sessions';
export class FakeDaemon {
    /** The Droi version /meta answers from now on; a Client compares it with its own. */
    static appVersion = '0.0.0';
    /** The current Pairing Token; resetToken() replaces it. */
    token;
    /** What /meta answers, as the Gateway would; tests may change it. */
    meta;
    url;
    requests = [];
    scratchRequests = [];
    /** Scratch Workspaces that exist, so validate_working_directory accepts them. */
    scratchFolders = new Set();
    scenario;
    #nextScratch = 1;
    #server;
    #wss;
    #connections = new Map();
    /** Every TCP socket, HTTP or upgraded, so stop() can end them all. */
    #sockets = new Set();
    #nextConnectionId = 1;
    #down = false;
    #tokenRevoked = false;
    #pendingClientAnswers = new Map();
    constructor(server, wss, port, scenario) {
        this.#server = server;
        this.#wss = wss;
        this.scenario = scenario;
        this.token = `test-token-${randomUUID()}`;
        this.url = `http://127.0.0.1:${port}`;
        this.meta = {
            app: 'Droi',
            version: FakeDaemon.appVersion,
            remoteAccess: true,
            name: 'Test Mac',
            computerId: randomUUID(),
        };
    }
    static async start(input = {}) {
        const server = createServer((request, response) => {
            // Mirror the Gateway's pairing check so the Client can distinguish a bad
            // token from an unreachable Daemon.
            const url = new URL(request.url ?? '/', 'http://fake');
            if (url.pathname === GATEWAY_DAEMON_PATH) {
                response.writeHead(daemon.acceptsToken(url) ? 204 : 401, {
                    'access-control-allow-origin': '*',
                });
                response.end();
                return;
            }
            if (url.pathname === GATEWAY_META_PATH) {
                response.writeHead(200, {
                    'content-type': 'application/json',
                    'access-control-allow-origin': '*',
                });
                response.end(JSON.stringify(daemon.meta));
                return;
            }
            if (url.pathname === GATEWAY_SESSION_FILE_PATH) {
                const path = daemon.acceptsToken(url)
                    ? daemon.sessionFile(url.searchParams.get(GATEWAY_SESSION_ID_QUERY) ?? '')
                    : null;
                response.writeHead(path ? 200 : daemon.acceptsToken(url) ? 404 : 401, {
                    'access-control-allow-origin': '*',
                    ...(path ? { 'content-type': 'application/json' } : {}),
                });
                response.end(path ? JSON.stringify({ path }) : undefined);
                return;
            }
            if (url.pathname.startsWith(GATEWAY_SCRATCH_PATH)) {
                const { status, body } = daemon.#answerScratch(request.method, url);
                response.writeHead(status, {
                    'access-control-allow-origin': '*',
                    ...(body ? { 'content-type': 'application/json' } : {}),
                });
                response.end(body ? JSON.stringify(body) : undefined);
                return;
            }
            response.writeHead(404);
            response.end();
        });
        const wss = new WebSocketServer({ noServer: true });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string')
            throw new Error('no port');
        const daemon = new FakeDaemon(server, wss, address.port, createScenario(input));
        server.on('connection', (socket) => {
            daemon.#sockets.add(socket);
            socket.once('close', () => daemon.#sockets.delete(socket));
        });
        server.on('upgrade', (request, socket, head) => {
            const url = new URL(request.url ?? '/', 'http://fake');
            if (url.pathname !== GATEWAY_DAEMON_PATH || !daemon.acceptsToken(url)) {
                socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
                socket.destroy();
                return;
            }
            if (daemon.#down) {
                socket.write('HTTP/1.1 503 Daemon Unavailable\r\nConnection: close\r\n\r\n');
                socket.destroy();
                return;
            }
            wss.handleUpgrade(request, socket, head, (ws) => daemon.#accept(ws, request));
        });
        return daemon;
    }
    acceptsToken(url) {
        return !this.#tokenRevoked && url.searchParams.get(GATEWAY_TOKEN_QUERY) === this.token;
    }
    /** Simulate the Daemon process dying: sockets drop and upgrades fail. */
    goDown() {
        this.#down = true;
        for (const ws of this.#connections.values())
            ws.terminate();
    }
    /** Simulate the Desktop Shell restarting the Daemon. */
    comeBack() {
        this.#down = false;
    }
    /** Simulate the Pairing Token being reset in the Desktop Shell. */
    revokeToken() {
        this.#tokenRevoked = true;
    }
    /** Simulate "Reset pairing" in the Desktop Shell: a new token, the old one refused. */
    resetToken() {
        this.token = `test-token-${randomUUID()}`;
        return this.token;
    }
    /** Where the Daemon would keep the Session's transcript, laid out as the real one does. */
    sessionFile(sessionId) {
        const found = this.scenario.sessions.find((s) => s.sessionId === sessionId);
        if (!found)
            return null;
        return `${SESSIONS_FOLDER}/${found.cwd.replaceAll('/', '-')}/${sessionId}.jsonl`;
    }
    /** The Gateway's Scratch Workspace requests, answered as the real one does. */
    #answerScratch(method, url) {
        if (!this.acceptsToken(url))
            return { status: 401 };
        if (method !== 'POST')
            return { status: 405 };
        if (url.pathname === GATEWAY_SCRATCH_PATH) {
            const path = `${SCRATCH_FOLDER}/2026-09-26-${String(this.#nextScratch++).padStart(6, '0')}`;
            this.scratchFolders.add(path);
            this.scratchRequests.push({ action: 'create', path });
            return { status: 201, body: { path } };
        }
        const path = url.searchParams.get(GATEWAY_SCRATCH_PATH_QUERY) ?? '';
        if (!path.startsWith(`${SCRATCH_FOLDER}/`)) {
            return { status: 400, body: { error: `${path} is not a Scratch Workspace` } };
        }
        if (url.pathname === GATEWAY_SCRATCH_TRASH_PATH) {
            this.scratchFolders.delete(path);
            this.scratchRequests.push({ action: 'trash', path });
            return { status: 204 };
        }
        if (url.pathname === GATEWAY_SCRATCH_RESTORE_PATH) {
            this.scratchFolders.add(path);
            this.scratchRequests.push({ action: 'restore', path });
            return { status: 204 };
        }
        return { status: 404 };
    }
    get connectionCount() {
        return this.#connections.size;
    }
    /** Wait until the Client has sent a request with this method (the nth one, 1-based). */
    async waitForRequest(method, nth = 1, timeoutMs = 5_000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const found = this.requests.filter((r) => r.method === method)[nth - 1];
            if (found)
                return found;
            await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(`Fake Daemon never received ${method}`);
    }
    /** Push a Session notification to every connection. */
    notify(sessionId, notification) {
        this.#broadcast({
            jsonrpc: '2.0',
            factoryApiVersion: '1.0.0',
            factoryProtocolVersion: '1.217.0',
            type: 'notification',
            method: 'daemon.session_notification',
            params: { sessionId, notification },
        });
    }
    /** A Daemon-level notification, such as daemon.worktree.removed. */
    notifyDaemon(method, params) {
        this.#broadcast({
            jsonrpc: '2.0',
            factoryApiVersion: '1.0.0',
            factoryProtocolVersion: '1.217.0',
            type: 'notification',
            method,
            params,
        });
    }
    /** Daemon-level (not Session-level) notification about archive state. */
    notifyArchiveState(sessionId, archivedAt) {
        this.#broadcast({
            jsonrpc: '2.0',
            factoryApiVersion: '1.0.0',
            factoryProtocolVersion: '1.217.0',
            type: 'notification',
            method: 'daemon.session.archive_state_changed',
            params: { sessionId, ...(archivedAt ? { archivedAt } : {}) },
        });
    }
    /**
     * Send a Daemon-originated request (permission or ask-user) to every
     * connection and resolve with the first answer, mirroring ADR 0003.
     */
    request(method, params) {
        const id = randomUUID();
        const answer = new Promise((resolve) => {
            this.#pendingClientAnswers.set(id, resolve);
        });
        this.#broadcast({
            jsonrpc: '2.0',
            factoryApiVersion: '1.0.0',
            factoryProtocolVersion: '1.217.0',
            type: 'request',
            id,
            method,
            params,
        });
        return { id, answer };
    }
    async stop() {
        this.#down = true;
        for (const ws of this.#connections.values())
            ws.terminate();
        this.#wss.close();
        const closed = new Promise((resolve) => this.#server.close(() => resolve()));
        // close() waits for every open socket, and the page is still open: its
        // Client keeps reconnecting and polling the pairing check. On CI that kept
        // one alive until the test timed out; end them all instead.
        for (const socket of this.#sockets)
            socket.destroy();
        await closed;
    }
    #accept(ws, _request) {
        const connectionId = this.#nextConnectionId++;
        this.#connections.set(connectionId, ws);
        ws.on('close', () => this.#connections.delete(connectionId));
        ws.on('message', (data) => void this.#handleMessage(connectionId, ws, data));
    }
    async #handleMessage(connectionId, ws, data) {
        const text = data.toString();
        let message;
        try {
            message = JSON.parse(text);
        }
        catch {
            throw new Error(`Fake Daemon received non-JSON frame: ${text.slice(0, 200)}`);
        }
        // Answer from the Client to one of our own requests (permission, ask-user).
        if (message['type'] === 'response' && typeof message['id'] === 'string') {
            const resolve = this.#pendingClientAnswers.get(message['id']);
            if (resolve) {
                this.#pendingClientAnswers.delete(message['id']);
                resolve(message);
            }
            else {
                // Late answer, exactly what the real Daemon does (ADR 0003).
                this.#send(ws, {
                    jsonrpc: '2.0',
                    factoryApiVersion: '1.0.0',
                    type: 'response',
                    id: message['id'],
                    error: { code: -32602, message: `No pending request found with ID ${message['id']}` },
                });
            }
            return;
        }
        const request = validateInboundEnvelope(message);
        this.requests.push({
            connectionId,
            method: request.method,
            params: request.params,
            id: request.id,
        });
        if (request.method === 'daemon.authenticate') {
            this.#send(ws, rpcResponse(request, { userId: 'user_test', orgId: 'org_test' }));
            this.#send(ws, {
                jsonrpc: '2.0',
                factoryApiVersion: '1.0.0',
                type: 'notification',
                method: 'daemon.connection_status',
                params: {
                    isDroidCLIInPath: true,
                    droidCLIVersion: '0.223.0',
                    homedir: '/Users/test',
                    platform: 'darwin',
                    hostId: HOST_ID,
                },
            });
            return;
        }
        try {
            const result = await this.scenario.handle(request, { daemon: this, connectionId });
            this.#send(ws, rpcResponse(request, result));
        }
        catch (error) {
            if (error instanceof RpcError) {
                this.#send(ws, {
                    jsonrpc: '2.0',
                    factoryApiVersion: '1.0.0',
                    type: 'response',
                    id: request.id,
                    error: { code: error.code, message: error.message },
                });
                return;
            }
            throw error;
        }
    }
    #broadcast(message) {
        for (const ws of this.#connections.values())
            this.#send(ws, message);
    }
    #send(ws, message) {
        validateOutbound(message);
        if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify(message));
    }
}
export class RpcError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
function rpcResponse(request, result) {
    return {
        jsonrpc: '2.0',
        factoryApiVersion: '1.0.0',
        factoryProtocolVersion: '1.217.0',
        type: 'response',
        id: request.id,
        result,
    };
}
