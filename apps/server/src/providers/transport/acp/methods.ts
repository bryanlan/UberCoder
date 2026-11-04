/** The ACP method names every Agent Client Protocol agent speaks. Extension methods are a dialect's own. */

export const ACP_METHODS = {
  initialize: 'initialize',
  newSession: 'session/new',
  loadSession: 'session/load',
  prompt: 'session/prompt',
  cancel: 'session/cancel',
  setConfigOption: 'session/set_config_option',
  requestPermission: 'session/request_permission',
  /** Notification: streamed content of a turn. */
  update: 'session/update',
  listSessions: 'session/list',
  closeSession: 'session/close',
} as const;
