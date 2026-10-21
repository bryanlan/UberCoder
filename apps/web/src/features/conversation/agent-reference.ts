import type { DragEvent } from 'react';
import type { AgentReference, ProviderId } from '@agent-console/shared';

export const CONVERSATION_DRAG_TYPE = 'application/x-agent-console-conversation';

export interface ConversationDragReference {
  projectSlug: string;
  provider: ProviderId;
  conversationRef: string;
}

export function startConversationDrag(event: DragEvent<HTMLElement>, reference: ConversationDragReference): void {
  // Chat dragging must not start the enclosing project's reorder gesture.
  event.stopPropagation();
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData(CONVERSATION_DRAG_TYPE, JSON.stringify(reference));
}

export function readConversationDrag(data: DataTransfer): ConversationDragReference | undefined {
  try {
    const value = JSON.parse(data.getData(CONVERSATION_DRAG_TYPE));
    if (typeof value?.projectSlug === 'string' && value.projectSlug.length > 0 && value.projectSlug.length <= 200
      && (value.provider === 'codex' || value.provider === 'claude')
      && typeof value.conversationRef === 'string' && value.conversationRef.length > 0 && value.conversationRef.length <= 200) return value;
  } catch { /* A malformed drag is rejected without changing the draft. */ }
  return undefined;
}

export function formatAgentReference(reference: AgentReference): string {
  return `[Agent ${JSON.stringify(reference.title)} · ${reference.provider} · ${reference.projectSlug} · agent_coordination recipientId=${reference.recipientId}]`;
}
