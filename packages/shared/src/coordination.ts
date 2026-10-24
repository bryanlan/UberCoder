export type AssignmentStatus = 'active' | 'waiting' | 'finished' | 'disconnected';
export type AssignmentContinuation = 'unattended' | 'waiting_for_input';
export const MESSAGE_PRIORITIES = ['P1', 'P2', 'P3'] as const;
export type MessagePriority = typeof MESSAGE_PRIORITIES[number];
export const BROADCAST_CATEGORIES = ['releases', 'resources', 'contracts', 'ownership', 'incidents'] as const;
export type BroadcastCategory = typeof BROADCAST_CATEGORIES[number];
export interface MessageOptions { priority?: MessagePriority; validFor?: number }
export interface AssignmentTask {
  ownerId: string;
  deliverable: string;
  doneWhen: string;
  evidencePath: string;
  state: 'working' | 'blocked' | 'done';
  /** A blocked task needs a specific action from its supervisor. External waits stay working. */
  actionNeeded: string | null;
  revision: number;
  updatedAt: string;
}
/** Resolved by the backend from a Console conversation's current binding. */
export interface AgentReference {
  recipientId: string;
  provider: string;
  projectSlug: string;
  conversationRef: string;
  title: string;
}
export interface AssignmentRecovery {
  status: 'scheduled' | 'submitting' | 'submitted' | 'blocked' | 'stalled';
  attempts: number;
  reason: string;
  nextAttemptAt: string;
}

export interface CoordinationAssignment {
  id: string;
  provider: string;
  nativeSessionId: string;
  description: string;
  status: AssignmentStatus;
  startedAt: string;
  lastSeenAt: string;
  continuation: AssignmentContinuation;
  supervisorId: string | null;
  awaiting: string | null;
  recovery: AssignmentRecovery | null;
  task?: AssignmentTask | null;
}

export interface CoordinationScope {
  assignmentId: string;
  checkout: string;
  repository: string;
  summary: string;
}

export interface CoordinationEvent {
  seq: number;
  assignmentId: string;
  checkout: string | null;
  kind: string;
  text: string;
  timestamp: string;
}

export interface CoordinationMessage {
  channel?: 'supervisor' | 'worker' | 'peer';
  priority: MessagePriority;
  expiresAt: string;
  /** Shared active Bryan grants at delivery; peer text does not create authority. */
  grantIds?: string[];
  id: string;
  senderId: string;
  recipientId: string;
  text: string;
  createdAt: string;
  suppliedAt: string | null;
  acknowledgedAt: string | null;
}

export interface CoordinationSendReceipt {
  id: string;
  queued: boolean;
  recipient: {
    status: 'working' | 'idle' | 'stopped';
    assignmentStatus: AssignmentStatus;
    supervisorId: string | null;
    acceptsMessages: boolean;
    provider: string;
    lastSeenAt: string;
    resumableInConsole: boolean;
  };
  delivery: 'next_step' | 'next_turn' | 'on_resume' | 'wake_pending' | 'wake_started' | 'wake_blocked' | 'offered' | 'acknowledged' | 'mailbox' | 'expired';
  note: string;
  priority: MessagePriority;
  expiresAt: string;
}

export interface CoordinationBroadcast {
  id: string;
  senderId: string;
  category: BroadcastCategory;
  repository: string | null;
  text: string;
  createdAt: string;
  expiresAt: string;
}

export interface CoordinationSnapshot {
  enabled: boolean;
  assignments: CoordinationAssignment[];
  scopes: CoordinationScope[];
  events: CoordinationEvent[];
  messages: CoordinationMessage[];
  pendingMessageCount: number;
}
