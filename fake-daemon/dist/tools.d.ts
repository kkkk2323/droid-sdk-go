import type { MethodHandler } from './scenario.js';
export interface SkillFixture {
    name: string;
    description?: string;
    /** Defaults to personal. */
    location?: 'project' | 'personal' | 'builtin' | 'automation';
    userInvocable?: boolean;
    /** Levels that turned it off; `org` makes it read-only. */
    disabledAt?: Array<'user' | 'project' | 'org'>;
    content?: string;
}
export interface McpServerFixture {
    name: string;
    /** Defaults to connected. */
    status?: 'connecting' | 'connected' | 'disconnected' | 'failed' | 'disabled';
    /** Defaults to user. */
    source?: 'user' | 'project' | 'org';
    type?: 'stdio' | 'http' | 'sse';
    toolCount?: number;
    error?: string;
    requiresAuth?: boolean;
    hasAuthTokens?: boolean;
    tools?: Array<{
        name: string;
        description?: string;
        enabled?: boolean;
    }>;
}
export interface McpRegistryFixture {
    name: string;
    description: string;
    type: 'stdio' | 'http' | 'sse';
    command?: string;
    args?: string[];
    url?: string;
    note?: string;
}
export interface ToolsInput {
    skills?: SkillFixture[];
    /** Whether the Sessions' Workspaces take project-level skill switches. */
    projectAvailable?: boolean;
    mcpServers?: McpServerFixture[];
    mcpRegistry?: McpRegistryFixture[];
}
export declare function toolHandlers(input: ToolsInput): Record<string, MethodHandler>;
