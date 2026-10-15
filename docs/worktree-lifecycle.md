# Worktree lifecycle and sweep

Agents create Git worktrees for isolated edits. Before October 15, 2026 nothing removed them when a session ended early, so 243 linked worktrees and about 53 GB accumulated in one week. Most of the space was Rust build output (`target/`) repeated in every worktree.

`scripts/worktree-sweep.mjs` takes inventory of every linked worktree in the repositories that Console knows about. It also removes the ones nobody can still use. It reads Console state read-only and changes nothing in Console.

## What the sweep protects

A worktree directory is a view of a branch. The sweep never deletes a branch, so committed work always survives. It keeps a directory when any of the following applies:

- **Someone is using it.** An assignment that announced the checkout has a running process, or is active or waiting and recorded no process to check. A process whose working directory, executable, open files or arguments point inside it also counts.
- **Console could resume its session.** An announcing assignment has a restorable binding, including a pending launch, but no process runs in the worktree. The sweep reports it as `resumable`.
- **It was used recently.** Commits, Git index changes, edited files or cache writes happened within the last 24 hours.
- **It holds something a branch does not reproduce.** Uncommitted or untracked files, ignored files outside build caches, a detached HEAD, a Git operation in progress, worktree-private Git state (for example `config.worktree`), commits reachable only from its HEAD reflog, or index entries marked assume-unchanged or skip-worktree.
- **It is parked.** `git worktree lock --reason "<why>" <path>` excludes it permanently.
- **It is not agent-managed.** Only worktrees inside a directory named `<something>-wt` are eligible. Others are inventory only.

## What the sweep removes

| Condition | Action |
|---|---|
| Nothing above applies, and every announcing assignment is finished or ended with no resumable session | Remove the directory, keep the branch |
| Nothing above applies, the worktree was never announced, and its branch tip is already in another branch | Remove the directory, keep the branch |
| Kept for any reason except current use, recent activity, lock or scope | Delete build caches only: ignored directories with a valid `CACHEDIR.TAG` (Cargo `target/`) |

A `resumable` worktree therefore keeps its directory but loses its build caches after 24 idle hours. A resumed session rebuilds them, which costs compile time but no work.

Removal first renames the worktree to `.retiring-<name>-<pid>-<start>` beside it, so no agent can open it by its known path. Then it checks again and lets `git worktree remove` delete it. If anything changed, the worktree moves back. A sweep interrupted after the rename leaves a `.retiring-*` worktree; the next applying sweep moves it back.

Cache deletion refuses links, mounts, other devices, tracked or untracked files and protected names (`.git`, `.env*`, `.venv`, `venv`) anywhere below the cache.

Check-then-act is not atomic. A process would have to enter a worktree idle for 24 hours with no resumable owner, during the seconds of a sweep, and evade the process scan. Even then Git still refuses to delete tracked or untracked changes, so only ignored files or cache output could be lost. Likewise, a session resumed during those seconds could start a build while its cache is being deleted; that build fails and the next one rebuilds. We accept that risk; closing it would need a lock shared by every launcher.

The sweep does nothing when Console's schema version is not one it was reviewed for, when Console state cannot be read, or when process visibility is incomplete. That last case covers a sandboxed PID namespace and any of this user's processes that `/proc` hides. The exceptions are a short list of login daemons that hide themselves by design. In that state it exits with status 2.

To recover a removed worktree, run the `recovery` command recorded in the report: `git -C <repo> worktree add <path> <branch>`.

## Running it

```bash
node scripts/worktree-sweep.mjs status            # classify only
node scripts/worktree-sweep.mjs sweep             # same, labelled as a dry run
node scripts/worktree-sweep.mjs sweep --apply     # act
# --repo <main checkout> limits the run; --json prints the full report
```

Every run writes `~/.local/share/agent-console/worktree-sweep/<time>.json` and `latest.json`, keeping the last 72 runs. Each worktree has a state, reason, action and outcome. Kept worktrees list their owners and the reason they were kept.

The Waltium scheduler runs `sweep --apply` hourly. It uses the main checkout so that it runs integrated, reviewed code.

## Rules for agents

- Use one worktree per assignment per repository, and reuse it across tasks: commit, then `git switch -c <next-branch>` in the same directory.
- A replacement lane takes over its predecessor's worktree only when its lead hands it over.
- Announce the checkout with `agent_coordination update` so the sweep can tell when you are done.
- Commit before stopping, even as a WIP commit. Uncommitted work keeps a worktree forever and is lost if the machine fails.
- Never delete a worktree with `rm -rf`. Use `git worktree remove <path>` (without `--force`) for your own finished worktree, or leave it for the sweep.
- Park a worktree that must stay with `git worktree lock --reason`.

## Changing Console's schema

`SUPPORTED_SCHEMA_VERSIONS` lists the Console schema versions whose assignment, scope and binding meanings were reviewed. A migration that changes those meanings must update the sweep's queries. `apps/server/test/worktree-sweep.test.ts` fails until the new version is added to the list.
