import { z } from 'zod';
export declare const JsonRpcRequestSchema: z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    method: z.ZodString;
    params: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    type: z.ZodOptional<z.ZodLiteral<"request">>;
}, z.core.$strip>;
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;
