export type AssignmentStatus = 'active' | 'waiting' | 'finished' | 'disconnected';
export type AssignmentContinuation = 'unattended' | 'waiting_for_input';
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
    provider: string;
    lastSeenAt: string;
    resumableInConsole: boolean;
  };
  delivery: 'next_step' | 'next_turn' | 'on_resume' | 'wake_pending' | 'wake_started' | 'wake_blocked' | 'offered' | 'acknowledged';
  note: string;
}

export interface CoordinationSnapshot {
  enabled: boolean;
  assignments: CoordinationAssignment[];
  scopes: CoordinationScope[];
  events: CoordinationEvent[];
  messages: CoordinationMessage[];
  pendingMessageCount: number;
}
