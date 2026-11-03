// Wire types for the Claude Code CLI's stream-json protocol, as spoken to a client over stdin and stdout.
//
// Written against `claude` 2.1.310 (the build the Agent SDK 0.3.310 targets). The shapes were taken from frames
// recorded on that build (docs/research/claude-headless-2026-10-26/r*.jsonl) and cross-checked against the
// `.d.ts` files of the Agent SDK package, which are used as a reference only and never copied: that package is
// under Anthropic's commercial terms. To regenerate or re-check after a CLI upgrade:
//   1. `npm pack @anthropic-ai/claude-agent-sdk@<version matching `claude --version`>` into a scratch directory
//      outside the repository and unpack it;
//   2. read `sdk.d.ts` (SDKMessage, SDKControlRequestInner, SDKControlInitializeResponse, SDKResultMessage,
//      SDKRateLimitInfo) and `sdk-tools.d.ts` (AskUserQuestionInput/Output);
//   3. record a few frames with a throwaway `CLAUDE_CONFIG_DIR` that holds no credentials (a turn then stops at
//      "Not logged in", so no model call is made) and compare them with the types below.
// Only the fields the plugin reads are typed. Every inbound interface keeps an index signature so a frame the CLI
// extends in a later release still type-checks and passes through untouched.

export const CLAUDE_CLI_VERSION = '2.1.310';

// ---------------------------------------------------------------------------------------------------------
// Outbound (client to CLI)

export type ClaudeUserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/**
 * One person-typed message. `origin: {kind: 'human'}` is required: without it the transcript records the turn as
 * SDK-originated and Console's transcript parser does not show it. `uuid` is the join key for every later frame
 * (`command_lifecycle.command_uuid`, `result.user_message_uuids`).
 */
export interface ClaudeUserMessageFrame {
  type: 'user';
  session_id: string;
  message: { role: 'user'; content: ClaudeUserContentBlock[] };
  parent_tool_use_id: null;
  uuid: string;
  origin: { kind: 'human' };
  /** `now` preempts the running turn and moves running shell commands to the background; absent queues the message. */
  priority?: 'now' | 'next' | 'later';
}

export interface InitializeRequest {
  subtype: 'initialize';
  /** Appended to the system prompt. Sent here, not on the command line, so it stays out of `ps`. */
  appendSystemPrompt?: string;
  /** Deliberately never set: declaring dialog kinds would make the CLI park `request_user_dialog` requests. */
  supportedDialogKinds?: never;
}

export interface InterruptRequest {
  subtype: 'interrupt';
  /** Also cancels every queued send; they are listed in the reply's `cancelled`. */
  cancel_queued?: boolean;
}

export interface SetModelRequest {
  subtype: 'set_model';
  model: string;
}

export interface ApplyFlagSettingsRequest {
  subtype: 'apply_flag_settings';
  settings: { effortLevel?: string };
}

export interface GetContextUsageRequest {
  subtype: 'get_context_usage';
  /** `summary` answers from the last response's usage and needs no model call. */
  detail?: 'summary' | 'full';
}

export type OutboundControlRequest = InitializeRequest | InterruptRequest | SetModelRequest | ApplyFlagSettingsRequest | GetContextUsageRequest | { subtype: 'get_settings' };

export interface ControlRequestFrame<R = OutboundControlRequest> {
  type: 'control_request';
  request_id: string;
  request: R;
}

export interface ControlSuccessResponse {
  subtype: 'success';
  request_id: string;
  response?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ControlErrorResponse {
  subtype: 'error';
  request_id: string;
  error: string;
}

export interface ControlResponseFrame {
  type: 'control_response';
  response: ControlSuccessResponse | ControlErrorResponse;
}

/** Either side withdraws a request it sent. There is no reply. */
export interface ControlCancelRequestFrame {
  type: 'control_cancel_request';
  request_id: string;
}

// ---------------------------------------------------------------------------------------------------------
// Replies to outbound control requests

export interface InitializeResponseBody {
  models?: ClaudeModelInfo[];
  account?: ClaudeAccountInfo;
  pid?: number;
  claude_code_version?: string;
  current_permission_mode?: string;
  hooks_applied?: boolean;
  session_state?: string;
  capabilities?: string[];
  [key: string]: unknown;
}

export interface ClaudeModelInfo {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  [key: string]: unknown;
}

export interface ClaudeAccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: string;
  [key: string]: unknown;
}

export interface InterruptResponseBody {
  /** Sends that were queued and will still run. */
  still_queued?: string[];
  /** Present with `cancel_queued`: sends that were dropped and will never run. */
  cancelled?: string[];
  [key: string]: unknown;
}

export interface ContextUsageResponseBody {
  totalTokens?: number;
  maxTokens?: number;
  rawMaxTokens?: number;
  percentage?: number;
  model?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------------------------------------
// Inbound frames (CLI to client)

export interface FrameBase {
  type: string;
  uuid?: string;
  session_id?: string;
  [key: string]: unknown;
}

export type CommandLifecycleState = 'queued' | 'started' | 'completed' | 'cancelled';

/**
 * Per-send state. `started` opens a turn; `completed` before the turn's `result` means the send was folded into the
 * running turn; `completed` with no `started` ever seen means the CLI already holds that uuid (nothing ran);
 * `cancelled` can also follow a `result` (an API-error turn ends that way).
 */
export interface CommandLifecycleFrame extends FrameBase {
  type: 'command_lifecycle';
  command_uuid?: string;
  state: CommandLifecycleState;
}

export interface AssistantTextBlock { type: 'text'; text: string }
export interface AssistantThinkingBlock { type: 'thinking'; thinking?: string }
export interface AssistantToolUseBlock { type: 'tool_use' | 'server_tool_use' | 'mcp_tool_use'; id: string; name: string; input?: Record<string, unknown> }
export interface UnknownBlock { type: string; [key: string]: unknown }
export type AssistantBlock = AssistantTextBlock | AssistantThinkingBlock | AssistantToolUseBlock | UnknownBlock;

/** One frame per completed content block; several share `message.id`. Dedupe by the frame's `uuid`. */
export interface AssistantFrame extends FrameBase {
  type: 'assistant';
  message: { id?: string; model?: string; content?: AssistantBlock[]; [key: string]: unknown };
  parent_tool_use_id?: string | null;
  /** Set on a synthetic message the CLI writes for an API failure, such as `authentication_failed` or `rate_limit`. */
  error?: string;
  is_api_error_message?: boolean;
  api_error_params?: { rate_limit_info?: ClaudeRateLimitInfo; [key: string]: unknown };
  user_message_uuid?: string;
  user_message_uuids?: string[];
}

export interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; is_error?: boolean; content?: unknown }

export interface UserFrame extends FrameBase {
  type: 'user';
  message?: { role?: string; content?: string | Array<ToolResultBlock | UnknownBlock> };
  parent_tool_use_id?: string | null;
  isReplay?: boolean;
}

export type ClaudeResultSubtype = 'success' | 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';

export interface ClaudeModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  costUSD?: number;
  [key: string]: unknown;
}

export interface ClaudeResultUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  iterations?: Array<{ input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }>;
  [key: string]: unknown;
}

/** Exactly one per turn. An API failure is `subtype: 'success'` with `is_error: true`. */
export interface ClaudeResultFrame extends FrameBase {
  type: 'result';
  subtype: ClaudeResultSubtype | (string & {});
  is_error?: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  result?: string;
  stop_reason?: string | null;
  terminal_reason?: string;
  api_error_status?: number | null;
  errors?: string[];
  startup_failure_reason?: string;
  total_cost_usd?: number;
  usage?: ClaudeResultUsage;
  modelUsage?: Record<string, ClaudeModelUsage>;
  permission_denials?: unknown[];
  user_message_uuid?: string;
  user_message_uuids?: string[];
  queued_turn_count?: number;
  result_index?: number;
  origin?: { kind?: string; [key: string]: unknown };
  /** Cumulative `modelUsage` minus what earlier results already reported. */
  model_usage_since_last_result?: Record<string, ClaudeModelUsage>;
  subagent_stats?: Record<string, unknown>;
  safety_stops?: number;
  fast_mode_state?: string;
  fast_mode_disabled_reason?: string;
}

export type ClaudeRateLimitType = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage';

export interface ClaudeRateLimitInfo {
  status?: 'allowed' | 'allowed_warning' | 'rejected';
  /** Unix seconds. */
  resetsAt?: number;
  rateLimitType?: ClaudeRateLimitType | (string & {});
  /** A 0..1 fraction. */
  utilization?: number;
  overageStatus?: string;
  isUsingOverage?: boolean;
  overageInUse?: boolean;
  [key: string]: unknown;
}

export interface RateLimitEventFrame extends FrameBase {
  type: 'rate_limit_event';
  rate_limit_info?: ClaudeRateLimitInfo;
}

/** Messages API stream events, only sent with `--include-partial-messages`. Typed and ignored. */
export interface StreamEventFrame extends FrameBase {
  type: 'stream_event';
  event?: { type?: string; [key: string]: unknown };
  parent_tool_use_id?: string | null;
}

export interface KeepAliveFrame extends FrameBase {
  type: 'keep_alive';
}

// `system` frames, by subtype.

export interface SystemInitFrame extends FrameBase {
  type: 'system';
  subtype: 'init';
  model?: string;
  apiKeySource?: string;
  permissionMode?: string;
  claude_code_version?: string;
  mcp_servers?: Array<{ name?: string; status?: string; [key: string]: unknown }>;
  capabilities?: string[];
  user_message_uuids?: string[];
}

export interface SystemStatusFrame extends FrameBase {
  type: 'system';
  subtype: 'status';
  status?: 'compacting' | 'requesting' | null;
  permissionMode?: string;
  compact_result?: 'success' | 'failed';
  compact_error?: string;
  user_message_uuids?: string[];
}

export interface SystemApiRetryFrame extends FrameBase {
  type: 'system';
  subtype: 'api_retry';
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number | null;
  error?: string;
}

export interface SystemCompactBoundaryFrame extends FrameBase {
  type: 'system';
  subtype: 'compact_boundary';
  compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number; [key: string]: unknown };
}

/** One entry of `background_tasks_changed.tasks`: a live background task. */
export interface BackgroundTaskEntry {
  task_id?: string;
  run_id?: string;
  task_type?: string;
  description?: string;
  /** Not activity (a watcher, a housekeeping task): hosts leave these out of "is work running". */
  ambient?: boolean;
}

export interface SystemTaskFrame extends FrameBase {
  type: 'system';
  subtype: 'task_started' | 'task_progress' | 'task_updated' | 'task_notification' | 'background_tasks_changed';
  task_id?: string;
  /** Equal on every frame of one run of a task; a resumed task keeps its id and gets a new run id. Plain string order is run order. */
  run_id?: string;
  status?: string;
  /** `task_started`: false while the spawning tool call blocks on the task (a foreground task). */
  is_backgrounded?: boolean;
  skip_transcript?: boolean;
  ambient?: boolean;
  /** `task_updated`: the fields that changed. */
  patch?: { status?: string; is_backgrounded?: boolean };
  /** `background_tasks_changed`: every live background task after the change (replace semantics). */
  tasks?: BackgroundTaskEntry[];
}

export interface SystemPermissionDeniedFrame extends FrameBase {
  type: 'system';
  subtype: 'permission_denied';
  tool_name?: string;
  tool_use_id?: string;
  decision_reason?: string;
}

export interface SystemInformationalFrame extends FrameBase {
  type: 'system';
  subtype: 'informational';
  content?: string;
  level?: 'info' | 'notice' | 'suggestion' | 'warning';
}

export interface SystemSessionStateChangedFrame extends FrameBase {
  type: 'system';
  subtype: 'session_state_changed';
  state?: 'idle' | 'running' | 'requires_action';
}

export interface SystemHookFrame extends FrameBase {
  type: 'system';
  subtype: 'hook_started' | 'hook_progress' | 'hook_response';
  hook_id?: string;
  hook_name?: string;
  hook_event?: string;
  output?: string;
  stdout?: string;
  outcome?: 'success' | 'error' | 'cancelled';
}

export interface SystemOtherFrame extends FrameBase {
  type: 'system';
  subtype: string;
}

export type SystemFrame =
  | SystemInitFrame
  | SystemStatusFrame
  | SystemApiRetryFrame
  | SystemCompactBoundaryFrame
  | SystemTaskFrame
  | SystemPermissionDeniedFrame
  | SystemInformationalFrame
  | SystemSessionStateChangedFrame
  | SystemHookFrame
  | SystemOtherFrame;

/** Every frame that is not a control frame. `OtherFrame` keeps unknown types flowing without a cast. */
export type ClaudeFrame =
  | SystemFrame
  | CommandLifecycleFrame
  | AssistantFrame
  | UserFrame
  | ClaudeResultFrame
  | RateLimitEventFrame
  | StreamEventFrame
  | KeepAliveFrame
  | FrameBase;

// ---------------------------------------------------------------------------------------------------------
// Server requests (CLI to client, each must be answered)

export interface CanUseToolRequest {
  subtype: 'can_use_tool';
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id: string;
  title?: string;
  display_name?: string;
  description?: string;
  decision_reason?: string;
  decision_reason_type?: string;
  permission_suggestions?: unknown[];
  requires_user_interaction?: boolean;
  agent_id?: string;
  [key: string]: unknown;
}

export interface ElicitationRequest {
  subtype: 'elicitation';
  mcp_server_name: string;
  message: string;
  mode?: 'form' | 'url';
  url?: string;
  elicitation_id?: string;
  requested_schema?: Record<string, unknown>;
  title?: string;
  [key: string]: unknown;
}

export type InboundServerRequest = CanUseToolRequest | ElicitationRequest;

export interface InboundControlRequestFrame {
  type: 'control_request';
  request_id: string;
  request: { subtype: string; [key: string]: unknown };
}

/** Body of the success `control_response` that answers `can_use_tool`. */
export type CanUseToolResponse =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[]; toolUseID?: string }
  | { behavior: 'deny'; message: string; interrupt?: boolean; toolUseID?: string };

/** Body of the success `control_response` that answers `elicitation`. */
export interface ElicitationResponse {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------------------
// AskUserQuestion

export interface AskUserQuestionOption { label: string; description?: string; preview?: string }

export interface AskUserQuestionItem {
  question: string;
  header?: string;
  options?: AskUserQuestionOption[];
  multiSelect?: boolean;
}

/** `answers` maps the question text to the chosen label; a multi-select answer is the labels joined with ", ". */
export interface AskUserQuestionInput {
  questions?: AskUserQuestionItem[];
  answers?: Record<string, string>;
  response?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------------------------------------
// Parsing helpers

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : [];
}

/** The uuids of the sends a turn-scoped frame belongs to: `user_message_uuids`, else the single `user_message_uuid`. */
export function messageUuidsOf(frame: { user_message_uuids?: unknown; user_message_uuid?: unknown }): string[] {
  const list = asStringArray(frame.user_message_uuids);
  if (list.length > 0) return list;
  const single = asString(frame.user_message_uuid);
  return single ? [single] : [];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
