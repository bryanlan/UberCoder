import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { ProjectSummary, ProviderId, TreeResponse } from '@agent-console/shared';
import { PROVIDERS } from '@agent-console/shared';
import type { ConfigService, MergedProviderSettings } from '../config/service.js';
import { AppDatabase, pickPreferredConversation, type ConversationSearchIndexChunk, type ConversationSearchStateRow } from '../db/database.js';
import { listFilesRecursive, pathExists, statFileSafe } from '../providers/file-utils.js';
import { buildSyntheticConversationFromSession } from '../lib/conversation-summary.js';
import { loadProviderConversationFromSummary } from '../lib/provider-conversation-cache.js';
import { nowIso } from '../lib/time.js';
import { ProjectService, type ActiveProject } from '../projects/project-service.js';
import { ProviderRegistry } from '../providers/registry.js';
import { CodexProvider } from '../providers/codex-provider.js';
import { getClaudeProjectTranscriptRoots } from '../providers/claude-provider.js';
import type { ConversationSummary } from '@agent-console/shared';
import { RealtimeEventBus } from '../realtime/event-bus.js';
import { isTreeVisibleBoundSession } from '../lib/bound-session-state.js';
import { TRANSCRIPT_PARSER_VERSION, type ProviderAdapter } from '../providers/types.js';
import { buildConversationSearchChunks } from '../search/conversation-search.js';
import { stampAgentControlledConversations } from '../lib/agent-controlled.js';
import { isBoundSessionVisibleInDiscovery, isConversationVisibleInDiscovery } from '../lib/conversation-visibility.js';
import type { CoordinationTelemetryRecord } from '../coordination/telemetry.js';

const PROVIDER_ROOT_DISCOVERY_REFRESH_DELAY_MS = 750;
const SEARCH_INDEX_WRITE_PAUSE_MS = 5;
const CODEX_NEW_FILE_INDEX_DELAY_MS = 2_000;
// A running Codex chat appends to its file on every step, and a large one takes seconds to parse.
// A write schedules one index this long after it; writes in the meantime join that index.
const CODEX_CHANGED_FILE_INDEX_DELAY_MS = 20_000;
// A growing chat is re-indexed at most this often, so its search rows trail it by up to this long.
const CODEX_CHANGED_FILE_MIN_INTERVAL_MS = 10 * 60_000;
// Before its first message a chat's title is a placeholder, so it is re-indexed sooner. An
// agent-launched chat opens with a launch prompt, not a person's message, and stays on this interval.
const CODEX_UNTITLED_FILE_MIN_INTERVAL_MS = 2 * 60_000;

type SearchUpdate = { chunks: ConversationSearchIndexChunk[]; state: ConversationSearchStateRow };
type CodexProjectGroup = { sessionsRoot: string; settings: MergedProviderSettings; projects: ActiveProject[] };

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const pauseBetweenWrites = () => new Promise<void>((resolve) => setTimeout(resolve, SEARCH_INDEX_WRITE_PAUSE_MS));

function searchParserVersionKey(projectSlug: string, providerId: ProviderId): string {
  return `searchParserVersion:${projectSlug}:${providerId}`;
}

export function getProviderTranscriptWatchPaths(providerId: ProviderId, discoveryRoot: string): string[] {
  if (providerId === 'codex') {
    return [
      path.join(discoveryRoot, 'sessions'),
      path.join(discoveryRoot, 'history.jsonl'),
    ];
  }
  if (providerId === 'grok') return [path.join(discoveryRoot, 'sessions')];
  if (providerId === 'vibe') return [path.join(discoveryRoot, 'logs', 'session', 'unified')];

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

export function getProviderTranscriptRefreshDelay(
  providerId: ProviderId,
  eventName: string,
  changedPath: string,
): number | undefined {
  const shouldRefresh = eventName === 'add'
    || eventName === 'unlink'
    || (providerId === 'claude' && eventName === 'change');
  if (shouldRefresh && changedPath.endsWith('.jsonl')) {
    return PROVIDER_ROOT_DISCOVERY_REFRESH_DELAY_MS;
  }

  return undefined;
}

/** How long to wait before indexing one Codex transcript after a file event; undefined when the event needs no index. */
export function getCodexTranscriptIndexDelay(eventName: string, changedPath: string): number | undefined {
  if (!changedPath.endsWith('.jsonl')) return undefined;
  if (eventName === 'add') return CODEX_NEW_FILE_INDEX_DELAY_MS;
  if (eventName === 'change') return CODEX_CHANGED_FILE_INDEX_DELAY_MS;
  return undefined;
}

export class IndexingService {
  private watchers: FSWatcher[] = [];
  private refreshTimer?: NodeJS.Timeout;
  private refreshDueAt?: number;
  private readonly scopedRefreshTimers = new Map<string, NodeJS.Timeout>();
  private readonly codexFileTimers = new Map<string, NodeJS.Timeout>();
  /** When each Codex transcript was last indexed, and the shortest wait before its next growth index. */
  private readonly codexFileIndexedAt = new Map<string, { at: number; minIntervalMs: number }>();
  private stopped = false;
  private codexGroupsCache?: { projects: ActiveProject[]; groups: CodexProjectGroup[] };
  private projectCache: Awaited<ReturnType<ProjectService['listActiveProjects']>> = [];
  private watchConfigSignature?: string;
  private refreshPromise?: Promise<void>;
  private fullRefreshPromise?: Promise<void>;
  private refreshGeneration = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly projectService: ProjectService,
    private readonly providerRegistry: ProviderRegistry,
    private readonly db: AppDatabase,
    private readonly eventBus: RealtimeEventBus,
    private readonly observeSearchStep?: (measurement: CoordinationTelemetryRecord) => void,
  ) {}

  async start(): Promise<void> {
    await this.syncWatchers();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.codexFileTimers.values()) {
      clearTimeout(timer);
    }
    this.codexFileTimers.clear();
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.refreshDueAt = undefined;
    for (const timer of this.scopedRefreshTimers.values()) {
      clearTimeout(timer);
    }
    this.scopedRefreshTimers.clear();
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
        // Provider file notifications are advisory; the next metadata refresh can retry.
      });
    }, Math.max(0, dueAt - Date.now()));
  }

  scheduleProjectProviderRefresh(projectSlug: string, providerId: ProviderId, delayMs = 750): void {
    const key = `${projectSlug}:${providerId}`;
    const existing = this.scopedRefreshTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.scopedRefreshTimers.delete(key);
      void this.refreshProjectProvider(projectSlug, providerId).catch(() => {
        // Provider file notifications are advisory; the next event can retry discovery.
      });
    }, Math.max(0, delayMs));
    this.scopedRefreshTimers.set(key, timer);
  }

  async refreshAll(): Promise<void> {
    if (this.fullRefreshPromise) {
      await this.fullRefreshPromise;
      return;
    }

    const fullRefresh = this.enqueueRefresh(() => this.performRefreshAll());
    const tracked = fullRefresh.finally(() => {
      if (this.fullRefreshPromise === tracked) {
        this.fullRefreshPromise = undefined;
      }
    });
    this.fullRefreshPromise = tracked;
    await tracked;
  }

  async refreshProjectProvider(projectSlug: string, providerId: ProviderId): Promise<void> {
    await this.enqueueRefresh(() => this.performProjectProviderRefresh(projectSlug, providerId));
  }

  private async enqueueRefresh(operation: () => Promise<void>): Promise<void> {
    const predecessor = this.refreshPromise ?? Promise.resolve();
    const queued = predecessor.then(operation);
    const tracked = queued.then(
      () => {
        if (this.refreshPromise === tracked) {
          this.refreshPromise = undefined;
        }
      },
      () => {
        if (this.refreshPromise === tracked) {
          this.refreshPromise = undefined;
        }
      },
    );
    this.refreshPromise = tracked;
    await queued;
  }

  private async performRefreshAll(): Promise<void> {
    this.refreshGeneration += 1;
    const projects = await this.projectService.listActiveProjects();
    this.projectCache = projects;
    this.persistProjectMetadata(projects);
    for (const providerId of PROVIDERS) {
      const provider = this.providerRegistry.get(providerId);
      if (providerId === 'codex' && provider instanceof CodexProvider) {
        await this.refreshCodexProjects(projects, provider);
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
        this.db.conversationIndex.replace(project.slug, providerId, conversations);
        await this.replaceSearchIndex(project, providerId, provider, settings, conversations);
      }
    }
    const timestamp = nowIso();
    this.db.meta.set('lastIndexedAt', timestamp);
    this.eventBus.emit({ type: 'conversation.index-updated', timestamp });
    await this.syncWatchers();
  }

  private async performProjectProviderRefresh(projectSlug: string, providerId: ProviderId): Promise<void> {
    this.refreshGeneration += 1;
    const projects = await this.projectService.listActiveProjects();
    this.projectCache = projects;
    this.persistProjectMetadata(projects);
    const project = projects.find((candidate) => candidate.slug === projectSlug);
    if (!project) {
      return;
    }

    const settings = this.projectService.getMergedProviderSettings(project, providerId);
    if (!settings.enabled) {
      this.db.conversationIndex.replace(project.slug, providerId, []);
      this.db.searchIndex.replace(project.slug, providerId, []);
    } else {
      const provider = this.providerRegistry.get(providerId);
      if (providerId === 'codex' && provider instanceof CodexProvider) {
        await this.refreshCodexProjects([project], provider);
      } else {
        const conversations = await provider.listConversations(project, settings);
        this.db.conversationIndex.replace(project.slug, providerId, conversations);
        await this.replaceSearchIndex(project, providerId, provider, settings, conversations);
      }
    }

    const timestamp = nowIso();
    this.db.meta.set('lastIndexedAt', timestamp);
    // Scoped: listeners re-check only this project's sessions of this provider, not every live session.
    this.eventBus.emit({ type: 'conversation.index-updated', projectSlug, provider: providerId, timestamp });
    await this.syncWatchers();
  }

  /** The tree without the provider lanes, which the route adds from the session manager. */
  getTree(): Omit<TreeResponse, 'structuredProviders'> {
    // One index read serves both the live-session visibility check and the history list; a lookup per
    // live session re-ran the closed-conversation scan each time and cost about a second per tree (2026-11-21).
    const indexed = this.db.conversationIndex.list();
    const indexedByKey = new Map(indexed.map((conversation) => [
      `${conversation.projectSlug}\0${conversation.provider}\0${conversation.ref}`, conversation,
    ]));
    const activeSessions = this.db.boundSessions.listTreeVisible()
      .filter((session) => isTreeVisibleBoundSession(session) && isBoundSessionVisibleInDiscovery(session, {
        getPendingConversation: (ref) => this.db.pendingConversations.get(ref),
        getIndexedConversation: (projectSlug, provider, conversationRef) => indexedByKey.get(`${projectSlug}\0${provider}\0${conversationRef}`),
      }));
    const activeSessionIds = new Set(activeSessions.map((session) => session.id));
    const history = indexed.filter(isConversationVisibleInDiscovery);
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
          grok: { id: 'grok', label: 'Grok', conversations: [] },
          vibe: { id: 'vibe', label: 'Mistral Vibe', conversations: [] },
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
      const existingIndex = conversations.findIndex((conversation) => conversation.ref === session.conversationRef);
      if (existingIndex === -1) {
        conversations.push(buildSyntheticConversationFromSession(session));
        continue;
      }
      conversations[existingIndex] = {
        ...conversations[existingIndex]!,
        isBound: true,
        boundSessionId: session.id,
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
          grok: {
            ...project.providers.grok,
            conversations: project.providers.grok.conversations.sort(compareConversationTreeOrder),
          },
          vibe: {
            ...project.providers.vibe,
            conversations: project.providers.vibe.conversations.sort(compareConversationTreeOrder),
          },
        },
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    stampAgentControlledConversations(projects, this.db.boundSessions.listAgentLaunchMarks());

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
      const claudeRefreshDelayMs = getProviderTranscriptRefreshDelay('claude', eventName, changedPath);
      if (claudeRefreshDelayMs !== undefined) {
        const claudeProject = this.findClaudeProjectForTranscript(changedPath);
        if (claudeProject) {
          this.scheduleProjectProviderRefresh(claudeProject.slug, 'claude', claudeRefreshDelayMs);
          return;
        }
      }

      const codexIndexDelayMs = getCodexTranscriptIndexDelay(eventName, changedPath);
      if (codexIndexDelayMs !== undefined && this.codexProjectGroupForTranscript(changedPath)) {
        this.scheduleCodexFileIndex(changedPath, eventName === 'change', codexIndexDelayMs);
        return;
      }

      const providerRootRefreshDelayMs = getProviderTranscriptRefreshDelay('codex', eventName, changedPath);
      if (providerRootRefreshDelayMs !== undefined) {
        this.scheduleRefresh(providerRootRefreshDelayMs);
      }
    });

    for (const watcher of this.watchers) {
      watcher.on('error', () => {
        // Keep the app running even if the host is near its watch limit.
      });
    }
  }

  private findClaudeProjectForTranscript(changedPath: string): ActiveProject | undefined {
    for (const project of this.projectCache) {
      const settings = this.projectService.getMergedProviderSettings(project, 'claude');
      if (!settings.enabled) {
        continue;
      }
      for (const transcriptRoot of getClaudeProjectTranscriptRoots(project, settings.discoveryRoot)) {
        const relativePath = path.relative(transcriptRoot, changedPath);
        if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
          return project;
        }
      }
    }
    return undefined;
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
    const parserVersionKey = searchParserVersionKey(project.slug, providerId);
    const parserVersion = String(TRANSCRIPT_PARSER_VERSION);
    const hasCurrentParserVersion = this.db.meta.get(parserVersionKey) === parserVersion;
    const deduped = new Map<string, ConversationSummary>();
    for (const summary of conversations.filter(isConversationVisibleInDiscovery)) {
      deduped.set(summary.ref, pickPreferredConversation(deduped.get(summary.ref), summary));
    }

    const indexedStates = this.db.searchIndex.getConversationStates(project.slug, providerId);
    const updates: Array<SearchUpdate & { ref: string }> = [];
    const failedRefs: string[] = [];
    for (const summary of deduped.values()) {
      const update = await this.buildSearchUpdate(
        project, provider, settings, summary, indexedStates.get(summary.ref), hasCurrentParserVersion,
      );
      if (update === 'failed') failedRefs.push(summary.ref);
      else if (update !== 'unchanged') updates.push({ ref: summary.ref, ...update });
    }
    const vanishedRefs = [...indexedStates.keys()].filter((ref) => !deduped.has(ref));

    if (options.shouldCommit && !options.shouldCommit()) {
      return;
    }
    // Each repository call commits one conversation. A full refresh must not
    // hold the SQLite writer lock across an entire project's search index.
    for (const ref of [...vanishedRefs, ...failedRefs]) {
      if (options.shouldCommit && !options.shouldCommit()) return;
      const started = performance.now();
      this.db.searchIndex.deleteConversation(project.slug, providerId, ref);
      this.observeSearchStep?.({ kind: 'index', operation: 'delete', project: project.slug,
        provider: providerId, ref, durationMs: performance.now() - started });
      await pauseBetweenWrites();
    }
    for (const update of updates) {
      if (options.shouldCommit && !options.shouldCommit()) return;
      const started = performance.now();
      this.db.searchIndex.replaceConversation(project.slug, providerId, update.ref, update.chunks, update.state);
      this.observeSearchStep?.({ kind: 'index', operation: 'replace', project: project.slug,
        provider: providerId, ref: update.ref, rows: update.chunks.length, durationMs: performance.now() - started });
      await pauseBetweenWrites();
    }
    // Stamp only a completed refresh. Interrupted work keeps the old version
    // so the next refresh cannot mistake partially rebuilt rows for current ones.
    if (options.shouldCommit && !options.shouldCommit()) return;
    this.db.meta.set(parserVersionKey, parserVersion);
  }

  /** Search chunks for one conversation, or 'unchanged' when its indexed transcript state still matches the file. */
  private async buildSearchUpdate(
    project: ActiveProject,
    provider: ProviderAdapter,
    settings: MergedProviderSettings,
    summary: ConversationSummary,
    indexed: ConversationSearchStateRow | undefined,
    hasCurrentParserVersion: boolean,
  ): Promise<SearchUpdate | 'unchanged' | 'failed'> {
    const stat = summary.transcriptPath ? await statFileSafe(summary.transcriptPath) : undefined;
    if (
      hasCurrentParserVersion
      && indexed
      && indexed.transcriptPath === summary.transcriptPath
      && stat
      && indexed.size === stat.size
      && indexed.mtimeMs === stat.mtimeMs
    ) {
      return 'unchanged';
    }
    try {
      const conversation = await loadProviderConversationFromSummary(summary)
        ?? await provider.getConversation(project, summary.ref, settings);
      if (!conversation) return 'failed';
      return {
        chunks: buildConversationSearchChunks({
          project,
          conversation: {
            ...conversation.summary,
            title: summary.title,
            isBound: summary.isBound,
            boundSessionId: summary.boundSessionId,
          },
          messages: conversation.messages,
        }),
        state: { transcriptPath: summary.transcriptPath, size: stat?.size, mtimeMs: stat?.mtimeMs },
      };
    } catch {
      return 'failed';
    }
  }

  /**
   * Indexes the Codex transcripts that are new or changed since they were last indexed, one file at a
   * time. Codex chats otherwise reached the index only through a manual refresh, which rescans every
   * project's whole history. Runs once after startup; the file watcher covers later writes.
   */
  async catchUpCodexHistory(): Promise<void> {
    const projects = await this.projectService.listActiveProjects();
    this.projectCache = projects;
    const touched = new Set<string>();
    for (const group of this.codexProjectGroups(projects)) {
      if (this.stopped || !(await pathExists(group.sessionsRoot))) continue;
      const indexedFiles = new Map<string, ConversationSearchStateRow>();
      for (const project of group.projects) {
        for (const state of this.db.searchIndex.getConversationStates(project.slug, 'codex').values()) {
          if (state.transcriptPath) indexedFiles.set(state.transcriptPath, state);
        }
      }
      const files = await listFilesRecursive(group.sessionsRoot, (candidate) => candidate.endsWith('.jsonl'));
      for (const filePath of files) {
        if (this.stopped) return;
        const indexedState = indexedFiles.get(filePath);
        if (indexedState) {
          const stat = await statFileSafe(filePath);
          if (stat && stat.size === indexedState.size && stat.mtimeMs === indexedState.mtimeMs) continue;
        }
        let projectSlugs: string[] = [];
        await this.enqueueRefresh(async () => { projectSlugs = await this.indexCodexFile(filePath); });
        for (const projectSlug of projectSlugs) touched.add(projectSlug);
        if (projectSlugs.length > 0) await pauseBetweenWrites();
        else await yieldToEventLoop();
      }
    }
    // One event per project: listeners re-check that project's Codex sessions once, not once per file.
    if (!this.stopped) this.emitCodexIndexUpdates([...touched]);
  }

  private scheduleCodexFileIndex(filePath: string, isGrowth: boolean, delayMs: number): void {
    const scheduled = this.codexFileTimers.get(filePath);
    if (isGrowth) {
      if (scheduled) return;
      const lastIndexed = this.codexFileIndexedAt.get(filePath);
      if (lastIndexed) {
        delayMs = Math.max(delayMs, lastIndexed.at + lastIndexed.minIntervalMs - Date.now());
      }
    }
    clearTimeout(scheduled);
    this.codexFileTimers.set(filePath, setTimeout(() => {
      this.codexFileTimers.delete(filePath);
      let projectSlugs: string[] = [];
      void this.enqueueRefresh(async () => { projectSlugs = await this.indexCodexFile(filePath); })
        .then(() => this.emitCodexIndexUpdates(projectSlugs))
        .catch(() => {
          // Provider file notifications are advisory; the next write or a manual refresh can retry.
        });
    }, delayMs));
  }

  /** Adds or updates one Codex transcript's index and search rows in each project it belongs to; returns those projects. */
  private async indexCodexFile(filePath: string): Promise<string[]> {
    const provider = this.providerRegistry.get('codex');
    const group = this.codexProjectGroupForTranscript(filePath);
    if (this.stopped || !group || !(provider instanceof CodexProvider)) return [];
    const touched: string[] = [];
    const summaries = await provider.summarizeFileForProjects(filePath, group.projects);
    const hasFirstMessage = summaries.some((summary) => typeof summary.rawMetadata?.firstUserTextHash === 'string');
    this.codexFileIndexedAt.set(filePath, {
      at: Date.now(),
      minIntervalMs: hasFirstMessage ? CODEX_CHANGED_FILE_MIN_INTERVAL_MS : CODEX_UNTITLED_FILE_MIN_INTERVAL_MS,
    });
    for (const summary of summaries) {
      const project = group.projects.find((candidate) => candidate.slug === summary.projectSlug);
      if (!project || this.stopped) continue;
      // A transcript with no user message yet carries a placeholder title; keep the title a live session gave its row.
      const storedTitle = this.db.conversationIndex.getStoredTitle(project.slug, 'codex', summary.ref);
      const item = storedTitle !== undefined && typeof summary.rawMetadata?.firstUserTextHash !== 'string'
        ? { ...summary, title: storedTitle }
        : summary;
      if (!isConversationVisibleInDiscovery(item)) continue;
      this.db.conversationIndex.upsert(item);
      touched.push(project.slug);

      // Read the row back for the title override and the bound session the search rows carry.
      const indexed = this.db.conversationIndex.get(project.slug, 'codex', item.ref);
      if (!indexed) continue;
      const update = await this.buildSearchUpdate(
        project,
        provider,
        group.settings,
        indexed,
        this.db.searchIndex.getConversationState(project.slug, 'codex', indexed.ref),
        this.db.meta.get(searchParserVersionKey(project.slug, 'codex')) === String(TRANSCRIPT_PARSER_VERSION),
      );
      if (update === 'unchanged' || this.stopped) continue;
      const started = performance.now();
      if (update === 'failed') {
        this.db.searchIndex.deleteConversation(project.slug, 'codex', indexed.ref);
        this.observeSearchStep?.({ kind: 'index', operation: 'delete', project: project.slug,
          provider: 'codex', ref: indexed.ref, durationMs: performance.now() - started });
        continue;
      }
      this.db.searchIndex.replaceConversation(project.slug, 'codex', indexed.ref, update.chunks, update.state);
      this.observeSearchStep?.({ kind: 'index', operation: 'replace', project: project.slug,
        provider: 'codex', ref: indexed.ref, rows: update.chunks.length, durationMs: performance.now() - started });
    }
    return touched;
  }

  private emitCodexIndexUpdates(projectSlugs: string[]): void {
    if (projectSlugs.length === 0) return;
    const timestamp = nowIso();
    this.db.meta.set('lastIndexedAt', timestamp);
    // Scoped to the project, as the Claude refresh is: its Codex sessions, pending ones included, re-check
    // their conversation; sessions in other projects and of other providers do not.
    for (const projectSlug of new Set(projectSlugs)) {
      this.eventBus.emit({ type: 'conversation.index-updated', projectSlug, provider: 'codex', timestamp });
    }
  }

  /** Projects with Codex enabled, grouped by the sessions directory their transcripts live in. */
  private codexProjectGroups(projects: ActiveProject[]): CodexProjectGroup[] {
    const groups = new Map<string, CodexProjectGroup>();
    for (const project of projects) {
      const settings = this.projectService.getMergedProviderSettings(project, 'codex');
      if (!settings.enabled) continue;
      const sessionsRoot = path.join(settings.discoveryRoot, 'sessions');
      const group = groups.get(sessionsRoot);
      if (group) group.projects.push(project);
      else groups.set(sessionsRoot, { sessionsRoot, settings, projects: [project] });
    }
    return [...groups.values()];
  }

  private codexProjectGroupForTranscript(filePath: string): CodexProjectGroup | undefined {
    // A running chat fires a change event on every write; group once per project list, not per event.
    if (this.codexGroupsCache?.projects !== this.projectCache) {
      this.codexGroupsCache = { projects: this.projectCache, groups: this.codexProjectGroups(this.projectCache) };
    }
    return this.codexGroupsCache.groups.find((group) => {
      const relativePath = path.relative(group.sessionsRoot, filePath);
      return relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
    });
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
        const hasCurrentParserVersion = this.db.meta.get(searchParserVersionKey(project.slug, providerId))
          === String(TRANSCRIPT_PARSER_VERSION);
        if (scopedConversations.length === 0
          || (hasCurrentParserVersion && this.db.searchIndex.hasRowsFor(project.slug, providerId))) {
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
        this.db.conversationIndex.replace(project.slug, 'codex', conversations);
        await this.replaceSearchIndex(project, 'codex', provider, group.settings, conversations);
      }
    }
  }

}
