export { isRecord, asString, asNumber, readConfigValue } from './readers.js';
export { ACP_METHODS } from './methods.js';
export { buildPromptBlocks, isTransientFileError, type PromptImage } from './prompt.js';
export { buildMcpServers } from './mcp.js';
export { buildChildEnv, expandHome, isInheritedIdentityKey } from './env.js';
export { INTERRUPT_GRACE_MS, UNRESPONSIVE_LIMIT_MS, hostIdFor, launchMetaKey, turnMetaKey, createRequestIdClock } from './meta.js';
export { classifyStandardUpdate, completedToolCall, itemKindForTool, stopReasonStatus, type StandardUpdate } from './updates.js';
export { decideHandshakeFailure, type HandshakeFailureAction, type HandshakeKind } from './lifecycle.js';

/** The Console has no approval screen. A permission request that reaches it is declined. */
export const DECLINED_PERMISSION = { outcome: { outcome: 'cancelled' } } as const;
