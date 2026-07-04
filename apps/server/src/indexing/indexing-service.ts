import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { ProjectSummary, ProviderId, TreeResponse } from '@agent-console/shared';
import { PROVIDERS } from '@agent-console/shared';
import type { ConfigService, MergedProviderSettings } from '../config/service.js';
import { AppDatabase, pickPreferredConversation, type ConversationSearchIndexChunk } from '../db/database.js';
import { buildSyntheticConversationFromSession } from '../lib/conversation-summary.js';
import { loadProviderConversationFromSummary } from '../lib/provider-conversation-cache.js';
import { nowIso } from '../lib/time.js';
import { ProjectService, type ActiveProject } from '../projects/project-service.js';
import { ProviderRegistry } from '../providers/registry.js';
import { CodexProvider } from '../providers/codex-provider.js';
import type { ConversationSummary } from '@agent-console/shared';
import { RealtimeEventBus } from '../realtime/event-bus.js';
import { isTreeVisibleBoundSession } from '../lib/bound-session-state.js';
import type { ProviderAdapter } from '../providers/types.js';
import { buildConversationSearchChunks } from '../search/conversation-search.js';
import { isBoundSessionVisibleInDiscovery, isConversationVisibleInDiscovery } from '../lib/conversation-visibility.js';
import { adoptPendingConversation, findPendingAdoptionMatch } from '../sessions/pending-adoption.js';

const PROVIDER_ROOT_DISCOVERY_REFRESH_DELAY_MS = 750;

export function getProviderTranscriptWatchPaths(providerId: ProviderId, discoveryRoot: string): string[] {
  if (providerId === 'codex') {
    return [
      path.join(discoveryRoot, 'sessions'),
      path.join(discoveryRoot, 'history.jsonl'),
    ];
  }

  return [
    path.join(discoveryRoot, 'projects'),
    path.join(discoveryRoot, 'history.jsonl'),
  ];
}

function compareConversationTreeOrder(a: ConversationSummary, b: ConversationSummary): number {
  const aPlacedAt = a.createdAt ?? a.updatedAt;
  const bPlacedAt = b.createdAt ?? b.updatedAt;
  const placedAtComparison = bPlacedAt.localeCompare(aPlacedAt);
  return placedAtComparison || a.ref.localeCompare(b.ref);
}

function getProviderRootRefreshDelay(eventName: string, changedPath: string): number | undefined {
  if ((eventName === 'add' || eventName === 'unlink') && changedPath.endsWith('.jsonl')) {
    return PROVIDER_ROOT_DISCOVERY_REFRESH_DELAY_MS;
  }

  return undefined;
}

export class IndexingService {
  private watchers: FSWatcher[] = [];
  private refreshTimer?: NodeJS.Timeout;
  private refreshDueAt?: number;
  private projectCache: Awaited<ReturnType<ProjectService['listActiveProjects']>> = [];
  private watchConfigSignature?: string;
  private refreshPromise?: Promise<void>;
  private refreshQueued = false;
  private refreshGeneration = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly projectService: ProjectService,
    private readonly providerRegistry: ProviderRegistry,
    private readonly db: AppDatabase,
    private readonly eventBus: RealtimeEventBus,
  ) {}

  async start(): Promise<void> {
    await this.syncWatchers();
  }

  async stop(): Promise<void> {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.refreshDueAt = undefined;
    await Promise.all(this.watchers.map((watcher) => watcher.close()));
    this.watchers = [];
  }

  scheduleRefresh(delayMs = 750): void {
    const dueAt = Date.now() + delayMs;
    if (this.refreshTimer && this.refreshDueAt !== undefined && this.refreshDueAt <= dueAt) {
      return;
    }

    clearTimeout(this.refreshTimer);
    this.refreshDueAt = dueAt;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refreshDueAt = undefined;
      void this.loadProjectMetadata().catch(() => {
        // Provider file notifications are advisory; explicit refresh remains available if metadata refresh fails.
      });
    }, Math.max(0, dueAt - Date.now()));
  }

  async refreshAll(): Promise<void> {
    await this.requestRefresh(false);
  }

  private async requestRefresh(queueIfRunning: boolean): Promise<void> {
    if (this.refreshPromise) {
      if (queueIfRunning) {
        this.refreshQueued = true;
      }
      await this.refreshPromise;
      return;
    }

    this.refreshPromise = this.runRefreshLoop()
      .finally(() => {
        this.refreshPromise = undefined;
      });
    await this.refreshPromise;
  }

  private async runRefreshLoop(): Promise<void> {
    do {
      this.refreshQueued = false;
      await this.performRefreshAll();
    } while (this.refreshQueued);
  }

  private async performRefreshAll(): Promise<void> {
    this.refreshGeneration += 1;
    const projects = await this.projectService.listActiveProjects();
    this.projectCache = projects;
    this.persistProjectMetadata(projects);
    const pendingConversations = this.db.pendingConversations.list();
    for (const providerId of PROVIDERS) {
      const provider = this.providerRegistry.get(providerId);
      if (providerId === 'codex' && provider instanceof CodexProvider) {
        await this.refreshCodexProjects(projects, pendingConversations, provider);
        continue;
      }

      for (const project of projects) {
        const settings = this.projectService.getMergedProviderSettings(project, providerId);
        if (!settings.enabled) {
          this.db.conversationIndex.replace(project.slug, providerId, []);
          this.db.searchIndex.replace(project.slug, providerId, []);
          continue;
        }
        const conversations = await provider.listConversations(project, settings);
        this.reconcilePendingConversations(
          project.slug,
          providerId,
          conversations,
          pendingConversations,
        );
        this.db.conversationIndex.replace(project.slug, providerId, conversations);
        await this.replaceSearchIndex(project, providerId, provider, settings, conversations);
      }
    }
    const timestamp = nowIso();
    this.db.meta.set('lastIndexedAt', timestamp);
    this.eventBus.emit({ type: 'conversation.index-updated', timestamp });
    await this.syncWatchers();
  }

  getTree(): TreeResponse {
    const activeSessions = this.db.boundSessions.list()
      .filter((session) => isTreeVisibleBoundSession(session) && isBoundSessionVisibleInDiscovery(session, {
        getPendingConversation: (ref) => this.db.pendingConversations.get(ref),
        getIndexedConversation: (projectSlug, provider, conversationRef) => this.db.conversationIndex.get(projectSlug, provider, conversationRef),
      }));
    const activeSessionIds = new Set(activeSessions.map((session) => session.id));
    const sessionSummaryMap = this.db.interactionSummaries.listBySessionIds(activeSessions.map((session) => session.id));
    const history = this.db.conversationIndex.list().filter(isConversationVisibleInDiscovery);
    const pending = this.db.pendingConversations.list()
      .filter((conversation) => typeof conversation.rawMetadata?.adoptedConversationRef !== 'string')
      .filter(isConversationVisibleInDiscovery)
      .map((conversation) => (
        conversation.boundSessionId && !activeSessionIds.has(conversation.boundSessionId)
          ? { ...conversation, isBound: false, boundSessionId: undefined }
          : conversation
      ));
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
      const conversations = project.providers[session.provider].conversations;
      const storedSessionSummary = sessionSummaryMap.get(session.id);
      const sessionSummary = storedSessionSummary ? {
        ...storedSessionSummary,
        projectSlug: session.projectSlug,
        provider: session.provider,
        conversationRef: session.conversationRef,
      } : undefined;
      const existingIndex = conversations.findIndex((conversation) => conversation.ref === session.conversationRef);
      if (existingIndex === -1) {
        conversations.push(buildSyntheticConversationFromSession(session, sessionSummary));
        continue;
      }
      conversations[existingIndex] = {
        ...conversations[existingIndex]!,
        isBound: true,
        boundSessionId: session.id,
        sessionSummary,
      };
    }

    const projects = [...projectMap.values()]
      .map((project) => ({
        ...project,
        providers: {
          codex: {
            ...project.providers.codex,
            conversations: project.providers.codex.conversations.sort(compareConversationTreeOrder),
          },
          claude: {
            ...project.providers.claude,
            conversations: project.providers.claude.conversations.sort(compareConversationTreeOrder),
          },
        },
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    return {
      projects,
      boundSessions: activeSessions,
      lastIndexedAt: this.db.meta.get('lastIndexedAt'),
    };
  }

  async loadProjectMetadata(options: { backfillSearchIndex?: boolean } = {}): Promise<void> {
    const projects = await this.projectService.listActiveProjects();
    this.projectCache = projects;
    this.persistProjectMetadata(projects);
    if (options.backfillSearchIndex === true) {
      await this.backfillMissingSearchIndexRows(projects);
    }
    this.eventBus.emit({ type: 'conversation.index-updated', timestamp: nowIso() });
  }

  private async collectWatchConfig(): Promise<{ watchPaths: string[] }> {
    const watchPaths = new Set<string>();
    const projects = await this.projectService.listActiveProjects();
    this.projectCache = projects;
    this.persistProjectMetadata(projects);
    for (const project of projects) {
      for (const providerId of PROVIDERS) {
        const settings = this.projectService.getMergedProviderSettings(project, providerId);
        if (!settings.enabled) {
          continue;
        }
        for (const watchPath of getProviderTranscriptWatchPaths(providerId, settings.discoveryRoot)) {
          watchPaths.add(watchPath);
        }
      }
    }
    return {
      watchPaths: [...watchPaths],
    };
  }

  private async syncWatchers(): Promise<void> {
    const config = await this.collectWatchConfig();
    const signature = JSON.stringify({
      watchPaths: [...config.watchPaths].sort(),
    });
    if (signature === this.watchConfigSignature) {
      return;
    }

    await Promise.all(this.watchers.map((watcher) => watcher.close()));
    this.watchers = [];
    this.watchConfigSignature = signature;

    if (config.watchPaths.length === 0) {
      return;
    }

    this.watchers = [
      chokidar.watch(config.watchPaths, {
        ignoreInitial: true,
        depth: 4,
        ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      }),
    ];

    this.watchers[0]?.on('all', (eventName, changedPath) => {
      const delayMs = getProviderRootRefreshDelay(eventName, changedPath);
      if (delayMs !== undefined) {
        this.scheduleRefresh(delayMs);
      }
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
      const matchedConversation = findPendingAdoptionMatch(pending, conversations, { claimedRefs });
      if (!matchedConversation) continue;

      const adoption = adoptPendingConversation({
        db: this.db,
        projectSlug,
        providerId,
        pendingRef: pending.ref,
        matchedConversation,
      });
      if (!adoption.adopted) continue;
      claimedRefs.add(matchedConversation.ref);
      if (adoption.reboundSession) {
        this.eventBus.emit({ type: 'session.updated', session: adoption.reboundSession });
      }
    }
  }

  private persistProjectMetadata(projects: Awaited<ReturnType<ProjectService['listActiveProjects']>>): void {
    for (const project of projects) {
      const metaKey = `project:${project.slug}`;
      const nextMetadata = JSON.stringify({
        slug: project.slug,
        directoryName: project.directoryName,
        displayName: project.displayName,
        path: project.path,
        tags: project.tags,
        notes: project.notes,
        allowedLocalhostPorts: project.allowedLocalhostPorts,
      });
      if (this.db.meta.get(metaKey) === nextMetadata) {
        continue;
      }

      this.db.meta.set(metaKey, nextMetadata);
      this.db.searchIndex.updateProjectMetadata({
        projectSlug: project.slug,
        displayName: project.displayName,
        path: project.path,
        tags: project.tags,
      });
    }
  }

  private async replaceSearchIndex(
    project: ActiveProject,
    providerId: ConversationSummary['provider'],
    provider: ProviderAdapter,
    settings: MergedProviderSettings,
    conversations: ConversationSummary[],
    options: { shouldCommit?: () => boolean } = {},
  ): Promise<void> {
    const chunks: ConversationSearchIndexChunk[] = [];
    const deduped = new Map<string, ConversationSummary>();
    for (const summary of conversations.filter(isConversationVisibleInDiscovery)) {
      deduped.set(summary.ref, pickPreferredConversation(deduped.get(summary.ref), summary));
    }
    for (const summary of deduped.values()) {
      try {
        const conversation = await loadProviderConversationFromSummary(summary)
          ?? await provider.getConversation(project, summary.ref, settings);
        if (!conversation) {
          continue;
        }
        chunks.push(...buildConversationSearchChunks({
          project,
          conversation: {
            ...conversation.summary,
            title: summary.title,
            isBound: summary.isBound,
            boundSessionId: summary.boundSessionId,
          },
          messages: conversation.messages,
        }));
      } catch {
        continue;
      }
    }
    if (options.shouldCommit && !options.shouldCommit()) {
      return;
    }
    this.db.searchIndex.replace(project.slug, providerId, chunks);
  }

  private async backfillMissingSearchIndexRows(projectsOverride?: ActiveProject[]): Promise<void> {
    const startedRefreshGeneration = this.refreshGeneration;
    const shouldCommit = () => !this.refreshPromise && this.refreshGeneration === startedRefreshGeneration;
    const projects = projectsOverride ?? (this.projectCache.length > 0
      ? this.projectCache
      : await this.projectService.listActiveProjects());
    const conversations = this.db.conversationIndex.list();
    let changed = false;

    for (const project of projects) {
      for (const providerId of PROVIDERS) {
        if (!shouldCommit()) {
          return;
        }
        const settings = this.projectService.getMergedProviderSettings(project, providerId);
        if (!settings.enabled) {
          if (this.db.searchIndex.hasRowsFor(project.slug, providerId)) {
            this.db.searchIndex.replace(project.slug, providerId, []);
            changed = true;
          }
          continue;
        }
        const scopedConversations = conversations.filter((conversation) => (
          conversation.projectSlug === project.slug
          && conversation.provider === providerId
        ));
        if (scopedConversations.length === 0 || this.db.searchIndex.hasRowsFor(project.slug, providerId)) {
          continue;
        }
        const provider = this.providerRegistry.get(providerId);
        await this.replaceSearchIndex(
          project,
          providerId,
          provider,
          settings,
          scopedConversations,
          { shouldCommit },
        );
        changed = true;
      }
    }

    if (!changed || !shouldCommit()) {
      return;
    }
    const timestamp = nowIso();
    this.db.meta.set('lastIndexedAt', timestamp);
    this.eventBus.emit({ type: 'conversation.index-updated', timestamp });
  }

  private async refreshCodexProjects(
    projects: ActiveProject[],
    pendingConversations: ConversationSummary[],
    provider: CodexProvider,
  ): Promise<void> {
    const groups = new Map<string, {
      settings: MergedProviderSettings;
      projects: ActiveProject[];
    }>();

    for (const project of projects) {
      const settings = this.projectService.getMergedProviderSettings(project, 'codex');
      if (!settings.enabled) {
        this.db.conversationIndex.replace(project.slug, 'codex', []);
        this.db.searchIndex.replace(project.slug, 'codex', []);
        continue;
      }

      const key = settings.discoveryRoot;
      const existing = groups.get(key);
      if (existing) {
        existing.projects.push(project);
        continue;
      }
      groups.set(key, { settings, projects: [project] });
    }

    for (const group of groups.values()) {
      const conversationsByProject = await provider.listConversationsForProjects(group.projects, group.settings);
      for (const project of group.projects) {
        const conversations = conversationsByProject.get(project.slug) ?? [];
        this.reconcilePendingConversations(
          project.slug,
          'codex',
          conversations,
          pendingConversations,
        );
        this.db.conversationIndex.replace(project.slug, 'codex', conversations);
        await this.replaceSearchIndex(project, 'codex', provider, group.settings, conversations);
      }
    }
  }

}
