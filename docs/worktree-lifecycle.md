# Worktree lifecycle and sweep

Agents create Git worktrees for isolated edits. Before October 15, 2026 nothing removed them when a session ended early, so 243 linked worktrees and about 53 GB accumulated in one week. Most of the space was Rust build output (`target/`) repeated in every worktree.

`scripts/worktree-sweep.mjs` takes inventory of every linked worktree in the repositories that Console knows about. It also removes the ones nobody can still use, deletes local branches whose work has landed (see [Branches](#branches)), and clears agents' leftover build caches and Docker storage (see [Scratch space and Docker](#scratch-space-and-docker)). It reads Console state read-only and changes nothing in Console.

By October 18, 2026 the repositories held 773 local branches, because worktree removal kept every branch. Most came from lane-per-delivery programs. The first run with branch retirement, at 21:45 UTC that day, deleted 240 branches whose work was already in a kept branch and 15 expired snapshots, with no failures.

## What the sweep protects

A worktree directory is a view of a branch. Removing a worktree keeps its branch, so committed work survives; branches follow their own rule under [Branches](#branches). The sweep keeps a directory when any of the following applies:

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

Cache deletion refuses links, mounts, other devices, tracked or untracked files and protected names (`.git`, `.env*`, `.venv`, `venv`) anywhere below the cache, and any cache holding `pyvenv.cfg`. Its final walk also skips a cache when anything inside was written in the last 24 hours, which catches rewrites that leave directory times unchanged.

Check-then-act is not atomic. A process would have to enter a worktree idle for 24 hours with no resumable owner, during the seconds of a sweep, and evade the process scan. Even then Git still refuses to delete tracked or untracked changes, so only ignored files or cache output could be lost. Likewise, a session resumed during those seconds could start a build while its cache is being deleted; that build fails and the next one rebuilds. We accept that risk; closing it would need a lock shared by every launcher.

The sweep does nothing when Console's schema version is not one it was reviewed for, when Console state cannot be read, or when process visibility is incomplete. That last case covers a sandboxed PID namespace and any of this user's processes that `/proc` hides. The exceptions are a short list of login daemons that hide themselves by design. In that state it exits with status 2.

To recover a removed worktree, run the `recovery` command recorded in the report: `git -C <repo> worktree add <path> <branch>`. If a later run deleted that branch, first run the branch's own `recovery` command.

## Branches

The sweep deletes a local branch only when nothing it holds would be lost or hidden. Kept refs are never deleted and hold commits safely: the default branch (`main`, `master` or the target of `origin/HEAD`), remote-tracking branches, tags and every branch a worktree has checked out, except snapshot branches, which expire by age.

| Condition | Action |
|---|---|
| Its tip is in a kept ref other than its own remote copy, and every commit its reflog names is in a kept ref | Delete |
| Snapshot branch (`snapshot/*` or `worktree-snapshot/*`) whose base, the first parent of its tip, is in the default branch | Delete |
| Snapshot branch whose tip commit is more than 30 days old | Delete |
| Anything else | Keep |

Pushing is not landing: a branch whose only other copy is its own remote branch stays. Its own copy is the same-name remote branch, or a differently named configured upstream that no other local branch tracks; an upstream several branches track, such as a program's integration branch, is a landing target. Identical changes under different commits are not proof either, because Git's patch comparison ignores whitespace, which changes Python behavior; such branches stay. A branch whose reflog holds an older commit no kept ref has, such as the tip before a reset, stays until Git expires that entry (30 days by default). The sweep never deletes the default branch, a symbolic ref or its target, a checked-out branch, a branch a paused rebase or bisect holds (including stack branches `rebase --update-refs` will move), a branch another local branch tracks, or a branch updated within the last 24 hours. Activity is the newest reflog entry or tip commit. Reflog file times are ignored because `git gc` rewrites every reflog file.

Deletion follows a fresh assessment of the repository. One Git ref transaction then deletes the branch only at its assessed commit, and only while the kept ref that holds its work is unchanged, so a branch that moves or loses that ref meanwhile stays. A branch a worktree checks out in that instant is restored when the final check sees it. A checkout that resolves the branch before deletion but writes its HEAD after that check leaves the worktree on a missing branch. For a landed branch the commits are in the kept ref, and the report's `recovery` command recreates it. Closing that window would need a lock shared by every Git client; we accept the risk, as for worktree removal. Only a concurrent ref change counts as skipped; any other deletion error fails the run. A branch whose worktree is removed in the same run was still checked out when assessed, so it waits for a later run. A repository whose branches or linked worktree records cannot be read is reported as a failed run, and none of its branches are deleted. The report records the decision actually applied, which can differ from the first assessment. Just before the transaction the sweep also requires the branch reflog to be unchanged and rechecks that kept refs still hold every commit it names; these checks are not atomic with the deletion. Each deletion records a quoted `recovery` command: `git -C <repo> branch -- <name> <sha>`. A landed branch's commits stay in the kept ref. An expired snapshot's commits have no guaranteed recovery period after deletion: `git gc` may prune them at its next run, because its cutoff uses the objects' age.

## Scratch space and Docker

`/tmp` shares a disk pool with `/home`, and it is emptied only at reboot. By October 15, 2026 agents had left about 134 GB there, 81 GB of it Rust build output from `CARGO_TARGET_DIR` settings, plus about 55 GB of Docker volumes from deleted temporary Postgres containers. The command-line sweep therefore also covers:

| What | Removed when |
|---|---|
| Build caches in `/tmp` (and `$TMPDIR`) up to four levels down: directories this user owns with a valid `CACHEDIR.TAG` | No process references anything inside, nothing in it was written in 24 hours, every entry is this user's, no mount point lies on its path, and the same disposable checks as worktree caches pass. Every enclosing Git checkout must report no tracked or untracked files in it. Protected names (`.venv`, `venv`, `var`, `dist`, `build`, `.env*`) are never searched, and any directory holding `pyvenv.cfg` is refused, because `uv` tags virtual environments with `CACHEDIR.TAG` too. |
| Docker volumes | Anonymous (Docker created it for a container), no container uses it, and created over 24 hours ago. Docker itself refuses a volume in use. Named volumes are never removed. |
| Docker build cache | Unused for 7 days (`docker builder prune --filter until=168h`). |

Everything else in `/tmp` is left alone, including agents' notes and logs. If Docker is unavailable, that part is skipped and reported. `runSweep` touches scratch space and Docker only when its caller passes `scratchRoots` and `docker`; the command line passes both.

## Running it

```bash
node scripts/worktree-sweep.mjs status            # classify only
node scripts/worktree-sweep.mjs sweep             # same, labelled as a dry run
node scripts/worktree-sweep.mjs sweep --apply     # act
# --repo <main checkout> limits the run; --json prints the full report
```

Every run writes `~/.local/share/agent-console/worktree-sweep/<time>.json` and `latest.json`, keeping the last 72 runs. Each worktree and local branch has a state, reason, action and outcome. Kept worktrees list their owners and the reason they were kept.

The Waltium scheduler runs `sweep --apply` hourly. It uses the main checkout so that it runs integrated, reviewed code.

## Rules for agents

- Use one worktree per assignment per repository, and reuse it across tasks: commit, then `git switch -c <next-branch>` in the same directory.
- A replacement lane takes over its predecessor's worktree only when its lead hands it over.
- Announce the checkout with `agent_coordination update` so the sweep can tell when you are done.
- Commit before stopping, even as a WIP commit. Uncommitted work keeps a worktree forever and is lost if the machine fails.
- Never delete a worktree with `rm -rf`. Use `git worktree remove <path>` (without `--force`) for your own finished worktree, or leave it for the sweep.
- Park a worktree that must stay with `git worktree lock --reason`.
- Before retiring a worktree with uncommitted work you are not integrating, commit it to `snapshot/<lane>`. The sweep deletes the snapshot once its base reaches the default branch or after 30 days.
- Build in the worktree's own `target/`, not a `CARGO_TARGET_DIR` under `/tmp`. Keep nothing you need in `/tmp`: it is scratch, cleared at reboot.
- Remove a temporary container with `docker rm -v` (or run it with `--rm`), so its anonymous volume goes with it.

## Changing Console's schema

`SUPPORTED_SCHEMA_VERSIONS` lists the Console schema versions whose assignment, scope and binding meanings were reviewed. A migration that changes those meanings must update the sweep's queries. `apps/server/test/worktree-sweep.test.ts` fails until the new version is added to the list.
