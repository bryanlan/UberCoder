export const PEER_WAKE_PROMPT: string;
export const UNATTENDED_CONTINUATION_PROMPT: string;
export const GRANTED_RESTART_PROMPT: string;
export function isCoordinationWakePrompt(text: string): boolean;
export function scheduledWakePrompt(objective: string): string;
export function coordinationWakeStatus(text: string): string | undefined;
export function isScheduledWakePrompt(text: string): boolean;
