export type AssignmentStatus = 'active' | 'waiting' | 'finished' | 'disconnected';

export interface CoordinationAssignment {
  id: string;
  provider: string;
  nativeSessionId: string;
  description: string;
  status: AssignmentStatus;
  startedAt: string;
  lastSeenAt: string;
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
  id: string;
  senderId: string;
  recipientId: string;
  text: string;
  createdAt: string;
  suppliedAt: string | null;
  acknowledgedAt: string | null;
}

export interface CoordinationSnapshot {
  enabled: boolean;
  assignments: CoordinationAssignment[];
  scopes: CoordinationScope[];
  events: CoordinationEvent[];
  messages: CoordinationMessage[];
  pendingMessageCount: number;
}
