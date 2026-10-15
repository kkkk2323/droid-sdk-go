import { type MessageFixture } from './scenario.js';
export declare const SCRIPT_SOURCE: string;
/** A call the Script made: user-only, tagged with the run it belongs to. */
export declare function nestedCallMessage(runId: string, id: string, name: string, input: Record<string, unknown>): MessageFixture;
export declare function toolResultBlocks(toolUseId: string, texts: string[]): MessageFixture;
export declare function scriptScenario(): {
    audit: import("./scenario.js").SessionFixture;
    report: import("./scenario.js").SessionFixture;
    sessions: import("./scenario.js").SessionFixture[];
};
export declare const RELEASE_REPORT: {
    root: string;
    elements: {
        card: {
            type: string;
            props: {
                title: string;
            };
            children: string[];
        };
        status: {
            type: string;
            props: {
                text: string;
                status: string;
            };
            children: never[];
        };
        table: {
            type: string;
            props: {
                columns: {
                    header: string;
                    key: string;
                }[];
                rows: {
                    name: string;
                    version: string;
                }[];
            };
            children: never[];
        };
        progress: {
            type: string;
            props: {
                progress: number;
                label: string;
            };
            children: never[];
        };
        bars: {
            type: string;
            props: {
                data: {
                    label: string;
                    value: number;
                }[];
                showPercentage: boolean;
            };
            children: never[];
        };
    };
};
