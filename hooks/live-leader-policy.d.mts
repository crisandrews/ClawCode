export interface LeaderPolicy { enabled?: boolean; maxConcurrent?: number; coordinationTools?: string[] }
export interface NormalizedLeaderPolicy { enabled: boolean; maxConcurrent: number; coordinationTools: string[] }
export type HookDecision = Record<string, never> | { hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string } };
export function normalizeLeaderPolicy(value?: unknown): NormalizedLeaderPolicy;
export function leaderEnvironment(policy: LeaderPolicy | undefined, environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function evaluateLeaderTool(payload: any, policy: LeaderPolicy | undefined, environment?: NodeJS.ProcessEnv): HookDecision;
export function denyLeaderTool(reason: string): HookDecision;
export function supportsLeaderRuntime(versionString: unknown): boolean;
