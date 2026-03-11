import chokidar, { type FSWatcher } from 'chokidar';
import type { ProjectSummary, ProviderId, TreeResponse } from '@agent-console/shared';
import { PROVIDERS } from '@agent-console/shared';
import type { ConfigService } from '../config/service.js';
import { AppDatabase } from '../db/database.js';
import { nowIso } from '../lib/time.js';
import { ProjectService } from '../projects/project-service.js';
import { ProviderRegistry } from '../providers/registry.js';
import type { ConversationSummary } from '@agent-console/shared';
import { RealtimeEventBus } from '../realtime/event-bus.js';

export class IndexingService {
  private watchers: FSWatcher[] = [];
  private refreshTimer?: NodeJS.Timeout;
  private projectCache: Awaited<ReturnType<ProjectService['listActiveProjects']>> = [];
  private watchConfigSignature?: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly projectService: ProjectService,
    private readonly providerRegistry: ProviderRegistry,
    private readonly db: AppDatabase,
    private readonly eventBus: RealtimeEventBus,
  ) {}

  async start(): Promise<void> {
    await this.refreshAll();
  }

  async stop(): Promise<void> {
    clearTimeout(this.refreshTimer);
    await Promise.all(this.watchers.map((watcher) => watcher.close()));
    this.watchers = [];
  }

  scheduleRefresh(delayMs = 750): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      void this.refreshAll();
    }, delayMs);
  }

  async refreshAll(): Promise<void> {
    const projects = await this.projectService.listActiveProjects();
    this.projectCache = projects;
    this.persistProjectMetadata(projects);
    this.eventBus.emit({ type: 'conversation.index-updated', timestamp: nowIso() });
    const pendingConversations = this.db.listPendingConversations();
    for (const project of projects) {
      for (const providerId of PROVIDERS) {
        const settings = this.projectService.getMergedProviderSettings(project, providerId);
        if (!settings.enabled) {
          this.db.replaceConversationIndex(project.slug, providerId, []);
          continue;
        }
        const provider = this.providerRegistry.get(providerId);
        const conversations = await provider.listConversations(project, settings);
        this.reconcilePendingConversations(
          project.slug,
          providerId,
          conversations,
          pendingConversations,
        );
        this.db.replaceConversationIndex(project.slug, providerId, conversations);
      }
    }
    const timestamp = nowIso();
    this.db.setMeta('lastIndexedAt', timestamp);
    this.eventBus.emit({ type: 'conversation.index-updated', timestamp });
    await this.syncWatchers();
  }

  getTree(): TreeResponse {
    const activeSessions = this.db.listBoundSessions().filter((session) => ['starting', 'bound', 'releasing'].includes(session.status));
    const history = this.db.listConversationIndex();
    const pending = this.db.listPendingConversations()
      .filter((conversation) => typeof conversation.rawMetadata?.adoptedConversationRef !== 'string');
    const projectMap = new Map<string, ProjectSummary>();

    for (const project of this.projectCache) {
      projectMap.set(project.slug, {
        slug: project.slug,
        directoryName: project.directoryName,
        displayName: project.displayName,
        path: project.path,
        tags: project.tags,
        notes: project.notes,
        allowedLocalhostPorts: project.allowedLocalhostPorts,
        providers: {
          codex: { id: 'codex', label: 'Codex', conversations: [] },
          claude: { id: 'claude', label: 'Claude', conversations: [] },
        },
      });
    }

    for (const conversation of [...history, ...pending]) {
      const project = projectMap.get(conversation.projectSlug);
      if (!project) continue;
      project.providers[conversation.provider].conversations.push(conversation);
    }

    for (const session of activeSessions) {
      const project = projectMap.get(session.projectSlug);
      if (!project) continue;
      project.providers[session.provider].conversations = project.providers[session.provider].conversations
        .map((conversation) => conversation.ref === session.conversationRef
          ? { ...conversation, isBound: true, boundSessionId: session.id }
          : conversation);
    }

    const projects = [...projectMap.values()]
      .map((project) => ({
        ...project,
        providers: {
          codex: {
            ...project.providers.codex,
            conversations: project.providers.codex.conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
          },
          claude: {
            ...project.providers.claude,
            conversations: project.providers.claude.conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
          },
        },
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    return {
      projects,
      boundSessions: activeSessions,
      lastIndexedAt: this.db.getMeta('lastIndexedAt'),
    };
  }

  async primeProjectMetadata(): Promise<void> {
    const projects = await this.projectService.listActiveProjects();
    this.projectCache = projects;
    this.persistProjectMetadata(projects);
  }

  private async collectWatchConfig(): Promise<{ projectsRoot: string; projectPaths: string[]; providerRoots: string[] }> {
    const providerRoots = new Set<string>();
    const projectPaths = new Set<string>();
    const projects = await this.projectService.listActiveProjects();
    this.projectCache = projects;
    this.persistProjectMetadata(projects);
    for (const project of projects) {
      projectPaths.add(project.path);
      for (const providerId of PROVIDERS) {
        const settings = this.projectService.getMergedProviderSettings(project, providerId);
        providerRoots.add(settings.discoveryRoot);
      }
    }
    return {
      projectsRoot: this.configService.getProjectsRoot(),
      projectPaths: [...projectPaths],
      providerRoots: [...providerRoots],
    };
  }

  private async syncWatchers(): Promise<void> {
    const config = await this.collectWatchConfig();
    const signature = JSON.stringify({
      projectsRoot: config.projectsRoot,
      projectPaths: [...config.projectPaths].sort(),
      providerRoots: [...config.providerRoots].sort(),
    });
    if (signature === this.watchConfigSignature) {
      return;
    }

    await Promise.all(this.watchers.map((watcher) => watcher.close()));
    this.watchers = [];
    this.watchConfigSignature = signature;

    this.watchers = [
      chokidar.watch(config.projectsRoot, {
        ignoreInitial: true,
        depth: 1,
        ignored: ['**/node_modules/**', '**/.git/**'],
      }),
      chokidar.watch(config.projectPaths, {
        ignoreInitial: true,
        depth: 0,
        ignored: ['**/node_modules/**', '**/.git/**'],
      }),
      chokidar.watch(config.providerRoots, {
        ignoreInitial: true,
        depth: 8,
        ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      }),
    ];

    this.watchers[0]?.on('all', () => {
      this.scheduleRefresh(200);
    });
    this.watchers[1]?.on('all', () => {
      this.scheduleRefresh(200);
    });
    this.watchers[2]?.on('all', () => {
      this.scheduleRefresh();
    });

    for (const watcher of this.watchers) {
      watcher.on('error', () => {
        // Keep the app running even if the host is near its watch limit.
      });
    }
  }

  private reconcilePendingConversations(
    projectSlug: string,
    providerId: ProviderId,
    conversations: ConversationSummary[],
    pendingConversations: ConversationSummary[],
  ): void {
    const scopedPending = pendingConversations
      .filter((conversation) => conversation.projectSlug === projectSlug && conversation.provider === providerId)
      .sort((a, b) => (a.createdAt ?? a.updatedAt).localeCompare(b.createdAt ?? b.updatedAt));

    if (scopedPending.length === 0) return;

    const claimedRefs = new Set<string>();
    for (const pending of scopedPending) {
      const pendingTimestamp = Date.parse(pending.createdAt ?? pending.updatedAt);
      const pendingLastUserHash = typeof pending.rawMetadata?.lastUserInputHash === 'string' ? pending.rawMetadata.lastUserInputHash : undefined;
      const matchedConversation = conversations
        .filter((conversation) => !claimedRefs.has(conversation.ref) && conversation.ref !== pending.ref)
        .map((conversation) => ({
          conversation,
          delta: Math.abs(Date.parse(conversation.createdAt ?? conversation.updatedAt) - pendingTimestamp),
          score: this.scorePendingMatch(pendingLastUserHash, pending, conversation),
        }))
        .filter(({ delta, score }) => score >= 0 && Number.isFinite(delta) && delta <= 30 * 60 * 1000)
        .sort((a, b) => a.score - b.score || a.delta - b.delta)[0]?.conversation;

      if (!matchedConversation) continue;
      claimedRefs.add(matchedConversation.ref);

      const titleOverride = this.db.getConversationTitleOverride(projectSlug, providerId, pending.ref);
      if (titleOverride) {
        this.db.setConversationTitleOverride(
          projectSlug,
          providerId,
          matchedConversation.ref,
          titleOverride.title,
          nowIso(),
        );
        this.db.deleteConversationTitleOverride(projectSlug, providerId, pending.ref);
      }

      const session = pending.boundSessionId
        ? this.db.getBoundSessionById(pending.boundSessionId)
        : this.db.getBoundSessionByConversation(projectSlug, providerId, pending.ref);
      if (session && ['starting', 'bound', 'releasing'].includes(session.status) && session.conversationRef === pending.ref) {
        const reboundSession = {
          ...session,
          conversationRef: matchedConversation.ref,
          title: matchedConversation.title,
          updatedAt: nowIso(),
        };
        this.db.upsertBoundSession(reboundSession);
        this.eventBus.emit({ type: 'session.updated', session: reboundSession });
      }

      this.db.putPendingConversation({
        ...pending,
        isBound: false,
        boundSessionId: undefined,
        updatedAt: nowIso(),
        transcriptPath: matchedConversation.transcriptPath,
        rawMetadata: {
          ...(pending.rawMetadata ?? {}),
          adoptedConversationRef: matchedConversation.ref,
          adoptedTranscriptPath: matchedConversation.transcriptPath,
          adoptedAt: nowIso(),
        },
      });
    }
  }

  private scorePendingMatch(
    pendingLastUserHash: string | undefined,
    pending: ConversationSummary,
    conversation: ConversationSummary,
  ): number {
    const rawMetadata = conversation.rawMetadata ?? {};
    const candidateHashes = [
      rawMetadata.lastUserTextHash,
      rawMetadata.firstUserTextHash,
    ].filter((value): value is string => typeof value === 'string');

    if (pendingLastUserHash) {
      return candidateHashes.includes(pendingLastUserHash) ? 0 : -1;
    }

    return -1;
  }

  private persistProjectMetadata(projects: Awaited<ReturnType<ProjectService['listActiveProjects']>>): void {
    for (const project of projects) {
      this.db.setMeta(`project:${project.slug}`, JSON.stringify({
        slug: project.slug,
        directoryName: project.directoryName,
        displayName: project.displayName,
        path: project.path,
        tags: project.tags,
        notes: project.notes,
        allowedLocalhostPorts: project.allowedLocalhostPorts,
      }));
    }
  }
}
