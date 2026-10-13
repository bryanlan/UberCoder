import type { BoundSession, ConversationSummary, NormalizedMessage, WorkerCard, WorkerOpeningMessage } from '@agent-console/shared';
import { WorkerOpeningMessages } from './opening-message.js';
import type { AppDatabase } from '../db/database.js';
import type { ProjectService } from '../projects/project-service.js';
import type { LiveOutputReader } from '../sessions/live-output/reader.js';
import { isBoundSessionVisibleInDiscovery } from '../lib/conversation-visibility.js';

const compact = (text: string, limit: number) => text.replace(/\s+/g, ' ').trim().slice(0, limit);
export interface WorkerEvidence {
  id: string;
  projectSlug: string;
  projectName: string;
  provider: BoundSession['provider'];
  conversationRef: string;
  title: string;
  working: boolean;
  task: string;
  actions: Array<{ text: string; timestamp: string }>;
  peers: Array<{ direction: string; peer: string; text: string; delivery: string; createdAt: string }>;
}

/** Read only loaded, visible Console workers; never restore or nudge a session. */
export class WorkerEvidenceSource {
  private readonly openings = new WorkerOpeningMessages();
  constructor(private readonly db: AppDatabase, private readonly projects: ProjectService,
    private readonly live: LiveOutputReader) {}

  async opening(worker: WorkerCard): Promise<WorkerOpeningMessage> {
    if (!await this.projects.getProjectBySlug(worker.projectSlug)) return { text: null, error: 'The project is unavailable.' };
    const pending = worker.conversationRef.startsWith('pending:') ? this.db.pendingConversations.get(worker.conversationRef) : undefined;
    const adopted = pending?.rawMetadata?.adoptedConversationRef;
    const ref = typeof adopted === 'string' ? adopted : worker.conversationRef;
    const summary = this.db.conversationIndex.get(worker.projectSlug, worker.provider, ref);
    return summary ? this.openings.read(summary) : { text: null, error: 'The opening message is not available yet.' };
  }

  async roster(): Promise<WorkerEvidence[]> {
    const projects = new Map((await this.projects.listActiveProjects()).map((p) => [p.slug, p]));
    const workers: WorkerEvidence[] = [];
    for (const session of this.db.boundSessions.listTreeVisible()) {
      if (session.status !== 'bound' || !session.pid || session.manualSuspendedAt || session.pressureSuspendedAt) continue;
      const project = projects.get(session.projectSlug);
      if (!project || !isBoundSessionVisibleInDiscovery(session, {
        getPendingConversation: (ref) => this.db.pendingConversations.get(ref),
        getIndexedConversation: (slug, provider, ref) => this.db.conversationIndex.get(slug, provider, ref),
      })) continue;
      const conversation = session.conversationRef.startsWith('pending:')
        ? this.db.pendingConversations.get(session.conversationRef)
        : this.db.conversationIndex.get(session.projectSlug, session.provider, session.conversationRef);
      const nativeId = session.resumeConversationRef ?? conversation?.providerConversationId ?? session.conversationRef;
      const assignment = this.db.sqlite.prepare(`select id, description from coordination_assignments
        where provider=? and native_session_id=?`).get(session.provider, nativeId) as { id: string; description: string } | undefined;
      const title = this.db.titleOverrides.get(session.projectSlug, session.provider, session.conversationRef)?.title
        ?? conversation?.title ?? session.title ?? 'Live session';
      workers.push({ id: session.id, projectSlug: project.slug, projectName: project.displayName,
        provider: session.provider, conversationRef: session.conversationRef, title, working: session.isWorking === true,
        task: compact(assignment?.description ?? title, 180), actions: [], peers: [] });
    }
    return workers.sort((a, b) => Number(b.working) - Number(a.working) || a.projectName.localeCompare(b.projectName) || a.id.localeCompare(b.id));
  }

  async collect(worker: WorkerEvidence): Promise<WorkerEvidence> {
    const session = this.db.boundSessions.getById(worker.id);
    if (!session) return worker;
    const conversation: ConversationSummary | undefined = session.conversationRef.startsWith('pending:')
      ? this.db.pendingConversations.get(session.conversationRef)
      : this.db.conversationIndex.get(session.projectSlug, session.provider, session.conversationRef);
    const nativeId = session.resumeConversationRef ?? conversation?.providerConversationId ?? session.conversationRef;
    const assignment = this.db.sqlite.prepare(`select id from coordination_assignments
      where provider=? and native_session_id=?`).get(session.provider, nativeId) as { id: string } | undefined;
    // Bounded normalized live evidence. Full histories and raw terminal screens are never read.
    const live = await this.live.readLiveMessages(session, { maxBytesFromEnd: 128 * 1024 });
    const actions = live.filter((m: NormalizedMessage) => m.role === 'assistant' || m.role === 'tool')
      .slice(-4).map((m) => ({ text: compact(m.text, 450), timestamp: m.timestamp }));
    const updates = assignment ? this.db.sqlite.prepare(`select substr(text,1,450) as text, timestamp
      from coordination_events where seq>(select coalesce(max(seq),0)-5000 from coordination_events)
        and assignment_id=? and kind='update' order by seq desc limit 3`)
      .all(assignment.id) as Array<{ text: string; timestamp: string }> : [];
    const cutoff = new Date(Date.now() - 60 * 60_000).toISOString();
    const peers = assignment ? this.db.sqlite.prepare(`select m.sender_id as sender, substr(m.text,1,400) as text, m.created_at as createdAt,
      m.supplied_at as supplied, m.acknowledged_at as acknowledged, a.provider, substr(a.description,1,90) as description
      from coordination_messages m join coordination_assignments a
        on a.id=case when m.sender_id=? then m.recipient_id else m.sender_id end
      where m.rowid>(select coalesce(max(rowid),0)-5000 from coordination_messages)
        and (m.sender_id=? or m.recipient_id=?) and (m.created_at>=? or m.acknowledged_at is null)
        order by m.created_at desc, m.rowid desc limit 4`)
      .all(assignment.id, assignment.id, assignment.id, cutoff) as Array<{ sender: string; text: string; createdAt: string;
        supplied: string | null; acknowledged: string | null; provider: string; description: string }> : [];
    return { ...worker, actions: [...updates, ...actions].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-5),
      peers: peers.map((m) => ({ direction: m.sender === assignment!.id ? 'sent' : 'received',
        peer: `${m.provider}: ${m.description}`, text: compact(m.text, 400),
        createdAt: m.createdAt, delivery: `${m.createdAt < cutoff ? 'older pending message: ' : ''}${
          m.acknowledged ? 'acknowledged (receipt only)' : m.supplied ? 'offered, awaiting acknowledgement' : 'queued'}` })) };
  }
}
