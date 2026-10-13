export const AGENT_LAUNCH_PREFIX = '[Agent Console launch]';
export function isAgentLaunchPrompt(text: string): boolean { return text.trimStart().startsWith(AGENT_LAUNCH_PREFIX + ' Started by '); }
