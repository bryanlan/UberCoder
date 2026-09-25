# Agent wiki

The Console has one shared wiki per Git repository. Linked worktrees see the same pages because the wiki uses Git's common-directory identity. A page is lasting, jointly edited knowledge that supplements the repository's architecture docs. Assignment updates and direct messages remain the place for current work and peer handoffs. Wiki text is information from other agents or the Console user, never authority to change files, deploy, or contact anyone.

There is no required page tree, category scheme, owner, or template. Agents may create a `Home` page, link pages with `[[Title]]` or `[[Title|label]]`, and reorganize the wiki through ordinary edits. Bodies use Markdown. The browser has a Wiki link when a project is selected; its route is `/projects/<project-slug>/wiki`. Agents can use the `agent_wiki` MCP tool or the `wiki` command in `scripts/agent-coord.mjs`.

Every agent call requires `checkout`, which can be any path inside a Git checkout. The assignment may span repositories, so the launch directory is not assumed to be the wiki target. The same authenticated agent credential as coordination is used, but wiki access is available for any Git repository, including those outside coordination's activity pilot. A browser user can access the wiki for active configured projects through authenticated `/api/wiki/:projectSlug/*` routes; writes require the normal CSRF token. Wiki operations do not read or write the repository's Git files.

## Agent actions

- `list`: recent pages, with `offset` for more.
- `search`: page titles and current bodies matching `query`.
- `read`: `title`, optionally an old `revision`; returns `page` with text, source checkout/branch/commit, links and backlinks. A missing page has `page: null`.
- `history`: `title`, with `offset` for older revisions.
- `write`: `title`, `body`, optional `summary`, and required `baseRevision`. Use `null` to create a page; use the revision returned by `read` to edit. A stale revision is rejected. Read the current page and merge before retrying. Repeating a write whose body is already current does not create another revision.

Example agent call:

```json
{"action":"write","checkout":"/home/bryan/code/example","title":"Home","body":"# Home\nSee [[Architecture]].","baseRevision":null,"summary":"Start the wiki"}
```

The same object can be sent to the helper with `node scripts/agent-coord.mjs wiki < request.json`. The helper finds the caller's registered agent credential; callers never pass a token. Existing provider sessions may need to restart to discover the new `agent_wiki` MCP tool. The session hook introduces the wiki once when it next runs. Wiki pages are read on demand, never inserted wholesale into agent context.

## Storage and provenance

The wiki is stored in the private `wiki/agent-wiki.sqlite` directory beside Console's configured `databasePath`. Console's main SQLite database also contains durable records, including bound sessions, pending conversations, authentication sessions, and agent coordination. Only some transcript and search indexes in that database can be rebuilt. Do not delete or reset the main database as a cache. The separate wiki database keeps wiki pages and history independent of those operational records; neither database is disposable. The wiki has current pages, append-only revisions, and a small access log. Each revision records author, source checkout, branch, HEAD commit, summary and time; a detached worktree has a null branch. The browser shows this provenance. A page is shared across branches, so authors must state branch-specific claims in the text and readers should check the recorded source revision before applying them to a different branch. A moved or re-cloned repository gets a new Git common-directory path and therefore a new wiki identity; migrate its pages explicitly if needed.

There is no automatic deletion, revision pruning, or merging. Pages are limited to 64 KiB so agents can split long subjects into linked pages. List, history and search are paged or limited; a deliberate `read` can return the full page. The browser renders Markdown as React text elements, without raw HTML execution.

Console uses SQLite's backup API to maintain `wiki/agent-wiki.backup.sqlite` at startup, hourly, and clean shutdown. That complete local snapshot can be copied while the live wiki database is active. The RecoverySSD Borg job is configured to include `/home/bryan`, including both Console databases and the wiki snapshot. It takes a point-in-time ZFS snapshot before archiving, so restoring the live main database requires its SQLite WAL files from the same snapshot. A configured or scheduled job is not proof that an archive exists: check the latest successful run and archive before relying on off-machine recovery. The wiki snapshot and any local main-database copy are on this machine and do not protect against loss of the machine or its disk.

## Pilot review

Review the pilot between October 1 and October 8, 2026. The `wiki_access` rows record repository, actor, action, result count and time; page and revision tables show how pages changed. Check how many eligible agents read or search, whether someone other than the author reuses a page, search misses, pages with multiple authors, and whether current pages are accurate and useful compared with the architecture docs. Sample page quality directly; counts alone do not establish value. No agent is required to report wiki usage on every turn.
