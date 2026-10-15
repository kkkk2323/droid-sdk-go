import { type JsonRpcRequest } from './protocol.js';
export declare function rememberMethod(id: string | number, method: string): void;
export declare function validateInboundEnvelope(message: unknown): JsonRpcRequest;
export declare function validateOutbound(message: Record<string, unknown>): void;
