# Historical plan: durable queued Codex model-profile selections

Prepared: 2026-09-18. Repository: `/home/bryan/code/UberCoder/agent-console-mvp/agent-console`.

Status: implemented and deployed to the local Agent Console service on 2026-09-24. This file preserves the original design and acceptance checklist; current behavior is described in `docs/architecture.md` and `docs/fileindex.md`. The live SQLite database migrated to schema 11. The original reported conversation was not used for testing. Live Codex `/model` picker behavior was verified in disposable sessions in both regular entry and Text Bypass; the full queued-switch navigate-away scenario in section 9 was covered by automated tests but was not repeated against the live service.

Subsequent approved profile changes superseded the original mapping: Codex H/M/L now use GPT-6 Astra/Sol/Luna at `xhigh`, and Claude has its own H/M/L mapping. The instruction below to preserve profile definitions describes the queue implementation's original scope, not the later explicit changes.

## 1. Outcome and scope

When Bryan selects High, Medium, or Low during a Codex turn, the server must save that choice immediately and apply it when the session is safe to switch. Navigating to another conversation, refreshing, or closing the browser must neither lose the choice nor prevent its application. A queued choice must also survive an ordinary backend restart.

This is one durable pending request per bound session, not a general job system. The backend owns acceptance, persistence, cancellation, execution, and results. The frontend submits selections and displays authoritative state. Keep the existing profile definitions in `packages/shared/src/index.ts`; do not change models or reasoning levels.

Not in scope: changing Claude behavior, saving browser-only composer drafts across navigation, replaying interrupted prompts, automatically continuing a stopped turn, redesigning recovery, changing conversation ownership, or changing authentication/proxy exposure. This uses Agent Console's own SQLite database, not a Waltium business database.

## 2. Starting point: do not redo the previous fix

Baseline when this plan was written: commit `d5e92f8681ed89c70927afe9b1836658a775f840` on `codex/redesign-readable-transcript-surface`. Recheck HEAD and the working tree before implementation; do not reset to this commit.

The previous fix already made actual Codex turn completion/abort release the working state, registered missing transcript paths, and prevented older polled session data from replacing newer realtime state. Preserve those fixes. In particular, do not use the output-recency cooldown to decide whether a turn is running.

At the planning baseline, the remaining defect was in `LiveSessionInputBridge` in `apps/web/src/components/ConversationPane.tsx`: `queuedProfile` existed only in React state. The browser waited for `isWorking` to become false before POSTing the model change, so unmounting the component lost the request before the server received it.

The existing server switch operation resumes the same native Codex conversation by restarting its owned tmux/provider process. That is why this is more than storing a preference: a wrong-time switch can interrupt a new prompt or lose unsent terminal input.

The original reported conversation is `http://127.0.0.1:4317/projects/waltium-ops/codex/01a0b457-790e-70c3-9d13-ebd711ff1168`. It is context, NOT a smoke-test target. Do not send prompts, switch models, or release that conversation to test this work.

### Preflight

1. Read effective `AGENTS.md`/`AGENTS.override.md`, then `docs/architecture.md`, `docs/fileindex.md`, `docs/agent_docs/running_tests.md`, and `docs/agent-coordination.md`.
2. Inspect `git status --short`, current diffs, and peer activity. Preserve all pre-existing work. Announce the actual files being edited through advisory coordination.
3. The source tree was already dirty in `session-manager.ts`, conversation routes, provider/transcript code, live-output code, several tests, `useConversationData.ts` and its tests, and both architecture/index docs. Untracked first-turn tests also existed. These are not permission to rewrite or commit someone else's work. Use an isolated worktree if needed; discuss genuine overlap.
4. Inspect symlinks before edits. Never replace or recreate one without Bryan's approval.
5. Record baseline test failures separately from failures introduced by this change. Do not run live smoke scripts with their defaults; some target existing conversations and send input.

## 3. Product behavior: implement this table

| Situation | Required behavior |
| --- | --- |
| Select a different profile during a turn | Persist the request before acknowledging it. Show the active profile separately from the pending target. Do not restart yet. |
| Select while safely idle | Use the same durable request/execution path; apply promptly. There must not be a second browser-only or immediate-switch execution path. |
| Navigate, refresh, or close the page | The request remains on the original session and executes without any browser connection. Never apply it to the newly viewed conversation. |
| Select another target before execution starts | Replace the pending request. Latest server-accepted selection wins. Only the latest request can complete or clear itself. |
| Select the already-active profile | Cancel any not-yet-applying request and keep the current profile; no restart. Do not guess that an unknown active profile matches. |
| Explicitly cancel a pending request | Clear that exact request. Do not stop the turn or undo a completed switch. |
| Press Escape/Stop during a turn | Preserve normal stop/recovery-cancellation behavior. A model request remains pending and can apply after the provider confirms the turn ended. Escape itself is not a completion signal. |
| New prompt races with the switch | Use existing per-session serialization. If input wins and starts a turn, keep the request queued until that turn ends. If switching wins, submit input through the normal path after switching completes. Never drop or replay input. |
| Unsent terminal draft, queued provider message, or interactive selection/approval | Defer with a visible reason. Do not send Enter/Escape, clear the draft, dismiss the prompt, or restart to force progress. Reconsider when safe. |
| A pending first conversation has no recorded user input | Preserve the existing ability to select the profile for its first turn without restarting. Describe this as the first-turn selection, not proof of a running process's model. |
| First turn exists but is not yet natively resumable | Keep the request queued until native adoption makes switching safe. Same-session-ID adoption preserves the request. |
| Explicit release, end, or replacement with a different session ID | Cancel the old session's request. Do not inherit it onto the replacement. An already-applied first-turn profile continues to follow existing launch behavior. |
| Project/provider disabled, ownership changed, or live provider unavailable | Do not switch or resurrect a process for the request. Cancel an ended/superseded request; otherwise retain a visible failed request explaining the problem. |
| Ordinary backend restart with a queued request | Reload it, revalidate the current session/ownership/turn, and continue waiting or apply safely without opening the UI. |
| Backend dies during an actual switch | Reconcile the recorded attempt without blindly restarting again. Proven successful startup may be finalized; ambiguous outcomes become visible failures requiring a new user action. |
| Provider switch fails | Retain the existing bounded rollback behavior, verify its outcome, and expose failure. Do not add an automatic retry loop. |

While an attempt is actually applying, disable profile/cancel controls in that client. Requests from another client still go through the same server lock: process them against the resulting current state, not a stale pre-switch snapshot. "Latest wins" applies to accepted pending choices, not retroactive cancellation of an already-started process restart.

## 4. Data and API contract

### One independently owned request record

Add optional `modelProfileRequest` to `BoundSession`, backed by one nullable `model_profile_request_json` column in `bound_sessions`.

Use a discriminated shared type with these states:

- Common fields: `requestId` (server-generated UUID), `profile`, and `requestedAt` (UTC ISO timestamp).
- `queued`: optional `deferredReason`, with explicit codes such as `turn_running`, `unsent_input`, `interactive_input`, `provider_message_queued`, `starting`, `awaiting_native_conversation`, or `cannot_verify_idle`.
- `applying`: `startedAt`, `previousProfile` when known, and the native conversation reference being resumed. This is the durable attempt journal, written before stopping the old process.
- `failed`: a safe user-facing `message` and `failedAt`. No automatic retry; a fresh selection creates a new request, and Cancel dismisses the failure.

Success clears the request and updates `codexProfile` together. Cancellation clears the request. Record meaningful acceptance/replacement/cancellation/success/failure as existing status events, not fake user/assistant transcript messages. Do not persist credentials, provider settings snapshots, or raw screen contents in this record.

Follow the independent-column ownership pattern already used by `setRunFailure()` in `apps/server/src/db/repos/bound-sessions.ts`: ordinary bound-session upserts must not overwrite the request from stale screen/status snapshots. Add focused repository operations for setting/replacing a request and compare-and-set transitions by `requestId` and expected state. Finalizing success must atomically update the active profile and clear that same request. Never clear a newer request using an older attempt's completion.

Keep `codexProfile` as the confirmed active/first-turn-selected profile, not the requested target. In the current native switch code it is assigned before startup succeeds; move that assignment to verified success. While applying, report the prior confirmed value plus the explicit applying state; the UI must not claim the target is active yet. If recovery cannot establish a running profile, show failure/unavailable state rather than treating the old persisted selection as proof of a live model.

Add the next migration in `apps/server/src/db/schema.ts` using its existing migration framework. Version was 9 at plan time: inspect again and use the next unused version. Test upgrades, fresh databases, and reopening. Do not edit the live database by hand or introduce another migration framework.

### HTTP contract: acceptance is not completion

Keep `POST /api/sessions/:sessionId/model-profile` with `{ "profile": "high" | "medium" | "low" }`. After validation, it saves/replaces the request under the session lock, emits the updated session, schedules execution, and returns HTTP 200 with `{ session: BoundSession }`. The acknowledgment means the request was accepted, not that the target is active. A no-op/current-profile selection may immediately return no pending request.

Change `SessionModelProfileResponse` and all consumers together to this `{ session }` shape. Remove the old top-level `profile`, `model`, and `reasoningEffort` success fields; they cannot truthfully describe a queued request. Do not retain compatibility aliases. Search every call site and fixture before removing them.

Add `DELETE /api/sessions/:sessionId/model-profile/requests/:requestId`, returning `{ session }`:

- Matching queued/failed request: clear it.
- No request: idempotent success; this does not undo an already-applied profile.
- A different current request or an applying request: HTTP 409, leave it unchanged, and have the client refresh state.

Keep authentication/CSRF checks and input validation on both mutations. Reject invalid profiles, unknown sessions, wrong providers, disabled configuration, and noncanonical/released sessions with the existing appropriate error conventions. Never advertise a saved queue after persistence fails. Do not retry failed/ambiguous POSTs automatically from the browser; reconcile by fetching the session.

Queue changes must update the session projection's `updatedAt`, emit `session.updated`, and be included in ordinary reads/tree/screen responses. Read the fresh database row after mutations instead of spreading an old session object. Preserve the existing frontend newest-session merge behavior; add regressions for out-of-order responses and rapid updates, including equal-timestamp ordering. Do not change conversation activity/recency timestamps merely because the queue progressed.

## 5. Backend execution: one guarded path

### Ownership and scheduling

Keep execution in `SessionManager`; `RunRecovery` remains the owner of provider turn observation/retry, not of model requests. Use existing recovery dependencies to resolve the current project, provider adapter, and merged settings at execution time. Never rely on a browser request's captured objects surviving navigation/restart.

Separate request acceptance from a single internal switch executor that runs with the session lock already held. All process restart logic must live in that executor; remove the obsolete public immediate-switch path after migrating its callers. Do not copy the restart body into a queue handler.

Schedule a deduplicated per-session drain after:

1. Request acceptance/replacement.
2. Authoritative provider completion/abort, including events observed with no connected browser.
3. Native conversation adoption and relevant terminal draft/menu/input changes.
4. Startup reconciliation and the existing periodic reconciliation safety net.

Ensure queued sessions actually have lifecycle watchers attached without a mounted conversation component. In-memory scheduling flags are fine; the pending intent must exist only in the database. Clear scheduling flags on completion/error so a failed drain does not wedge future work. A deferred request must wait for a meaningful event or the existing reconciliation interval, not continually reschedule itself.

**Deadlock warning:** `RunRecovery` callbacks can run inside `runtimes.run(sessionId, ...)`. Do not await a second `runtimes.run` for the same session from that callback or from a locked drain. Enqueue/coalesce later work without awaiting it there; invoke the internal already-locked executor directly from the drain. Refreshing run state can fire the callback again, so suppress recursive drain storms and test this explicitly.

### Before any destructive process operation

Under the same session lock, re-read the request and session, then:

1. Verify the request ID/state, Codex provider, enabled project/configuration, and canonical restorable owner. Check actual tmux ownership using `@agent_console_session_id`, not just a matching tmux name.
2. Check liveness without restoring missing sessions merely to service a queue. Avoid the restoring default of `refreshSessionState()` in this background path.
3. Refresh provider run state and preserve the submitted-input guard added by the previous fix. A newly submitted turn must not be mistaken for an older completed turn. Use screen-working heuristics only where authoritative lifecycle state is unavailable; do not resurrect the recency timer as a busy flag.
4. Capture a fresh screen and verify a safe idle prompt: no real terminal draft, interactive selection/approval, startup, or provider-queued input. Existing placeholder parsing in `session-screen.ts` already distinguishes some starter suggestions; reuse/test it rather than treating every visible prompt suggestion as a draft. Unknown readiness must defer visibly, not trigger a restart.
5. Resolve first-turn/native adoption. If genuinely safe, atomically transition that request to `applying` before killing anything. Retain the prior confirmed profile until verified startup succeeds.
6. Reuse the owned native-resume switch and bounded rollback. Check ownership again immediately before destructive operations and cleanup, including rollback cleanup; never kill a replacement writer merely because its tmux name matches.
7. Verify liveness, ownership, and the intended launch/profile before finalizing. Persist the active profile and clear the exact request atomically; publish a freshly read session. On failure, persist a failed request and truthful session state after any rollback attempt.

Input, keystrokes, release, switching, and automatic recovery submission must remain serialized through the same session runtime. Do not introduce a separate lock for the model queue. Do not reprioritize/replay automatic recovery: whichever operation obtains the lock first proceeds under its existing safety checks; the other rechecks the resulting state.

### Crash recovery and release

Persist an attempt marker on the owned tmux session, for example `@agent_console_model_profile_request_id`, only after successful startup verification and before committing the request's success. On backend startup, inspect applying records before ordinary restore/reconciliation can recreate or replace those same processes:

- Matching request marker, canonical owner, native conversation, target-profile metadata, and verified live process: finalize success without another restart.
- Missing/contradictory evidence, a dead process, or unverifiable ownership: retain a failed request with an interrupted-switch explanation. Do not replay the attempt or kill a surviving process. Require explicit manual recovery/reselection; prevent automatic restore from silently replaying this uncertain operation.

For queued requests, revalidate current state and resume normal scheduling. A server restart must not cause a second restart of a successfully switched provider. Do not claim exactly-once tmux operations across process crashes: the safety contract is durable intent, serialized attempts, evidence-based reconciliation, and no blind replay.

Release/end/supersession must clear pending intent durably. Guard delayed callbacks with current ownership/request identity so they cannot resurrect cleared work. Same-ID pending-to-native adoption preserves intent; different-ID replacement does not transfer it. Stop/shutdown must cancel in-memory scheduling and avoid scheduling new work after `stopped`, without clearing durable queued requests just because the backend is shutting down.

## 6. Frontend behavior

Remove `queuedProfile` as executable local state and remove its auto-apply effect from `ConversationPane.tsx`. H/M/L shortcuts and buttons always submit to the server, even while working. Local HTTP-in-flight state is allowed only to manage the request UI, not as the source of pending intent.

Render active, pending, applying, and failed state from `BoundSession`. Suggested copy:

- Active: `Current: Medium`.
- Queued during a turn: `High queued until this turn finishes.`
- Deferred on input: `High queued. Send or clear the terminal draft first.`
- Applying: `Switching to High…`.
- Failed: `Could not switch to High: <safe reason>` with a fresh-selection retry and Cancel/dismiss affordance.

Do not say "High selected" just because POST returned 200. Do not visually present a pending target as already active. Provide an accessible Cancel control for queued/failed state. Browser-only unsent text should remain untouched by queue updates; adding cross-navigation composer persistence is outside scope.

Update the callback contract through `App.tsx` and the API client. Scope every response/cache update to its requested session ID, even if the user navigates before the HTTP response arrives. On mount/reload, get the pending state through existing session/conversation data. A missed websocket event must not strand the UI; normal refetch reconciles it. Client navigation must never send Cancel automatically.

## 7. File map and implementation order

| Order | Existing files / proposed new tests | Work |
| --- | --- | --- |
| 1 | `packages/shared/src/index.ts`; `apps/server/src/db/schema.ts`; `apps/server/src/db/repos/bound-sessions.ts`; `apps/server/test/database.test.ts` | Request union, response contract, additive migration, independent persistence/CAS, atomic success, migration tests. |
| 2 | `apps/server/src/sessions/session-manager.ts`; inspect `session-runtime.ts`, `run-recovery.ts`, `session-screen.ts`, `screen-heuristics.ts` in that directory | One locked executor, safe request/drain scheduling, lifecycle/restart/release handling. Change adjacent modules only when required; do not redesign them. |
| 3 | `apps/server/src/routes/sessions.ts`; `apps/server/test/session-routes.test.ts`; proposed `apps/server/test/model-profile-queue.test.ts` | Accept/cancel routes, authentication and validation, backend behavior matrix using temporary DB/fake tmux/transcript events. |
| 4 | `apps/web/src/lib/api.ts`; `apps/web/src/App.tsx`; `apps/web/src/components/ConversationPane.tsx`; their applicable tests | Server-owned UI, cancel/failure display, session-scoped callbacks; remove the browser queue. |
| 5 | Existing `apps/web/src/features/conversation/useConversationData.ts` and tests, only if necessary; proposed `apps/web/e2e/model-profile-queue.spec.ts` | Preserve newest-session merging, test navigation/reload/delayed responses, desktop/mobile controls. |
| 6 | `docs/architecture.md`; `docs/fileindex.md`; `docs/agent_docs/running_tests.md` if commands change | Document ownership, lifecycle, API, and verification; preserve existing dirty documentation edits. |

Use `rg` to find every old switch/response/queue reference, including fixtures. Write focused failing regressions before the implementation. Keep coupled shared-contract and caller changes in one working batch; typecheck and run focused tests at each buildable checkpoint. Do not paper over compile failures with aliases or maintain both old/new executable paths.

## 8. Required automated acceptance tests

Use temporary databases and controlled provider/tmux fixtures. Do not depend on the real conversation or timing-sensitive sleeps where events/barriers suffice.

- [ ] Accept while running: database has the target before response; no kill/restart; current profile unchanged.
- [ ] No browser mounted: matching `task_complete` and `turn_aborted` each drain exactly once; Escape alone does not bypass lifecycle confirmation.
- [ ] Terminal completion followed by new input: if input wins the lock, no mid-turn switch; if the drain wins, input is delivered once after switching.
- [ ] Latest choice wins; choosing the active profile cancels without restart; repeated matching selections do not create redundant successful restarts.
- [ ] Cancel exact ID succeeds; stale cancellation cannot remove a newer choice; applying/finished behavior matches the API contract.
- [ ] Ordinary screen/status upserts cannot erase a request or resurrect a cleared one. Atomic completion cannot clear a newer request.
- [ ] Real terminal draft, queued provider message, menu/approval, startup, and unknown readiness defer safely. Empty prompts/starter placeholders do not block forever. Clearing a blocker permits progress without viewing the page.
- [ ] First-turn profile selection works; not-yet-resumable first turn waits; same-ID adoption preserves the request; different-ID replacement/release/supersession cancels it.
- [ ] Wrong provider, missing/disabled project, wrong tmux owner, dead/unknown provider, and persistence errors cause no unsafe process operation.
- [ ] Duplicate lifecycle events, screen updates, and reconciliation triggers neither duplicate execution nor deadlock. Explicitly exercise `refresh -> onRunState` inside the runtime lock.
- [ ] Close/reopen the database and reconstruct the manager: queued intent survives; watchers/drain start without any screen HTTP request.
- [ ] Crash points before kill, after kill, after launch, after verified marker, and after DB success: reconcile safely, finalize only with evidence, never blindly repeat a process restart.
- [ ] Switch failure/rollback success and rollback failure produce truthful state; active target is not announced early; no automatic switch retry loop.
- [ ] Queue activity does not fabricate user/assistant transcript rows or move conversation recency through background status updates.
- [ ] Frontend immediately POSTs while busy; navigation/reload recovers server state; cancellation is explicit; POST acknowledgment is not labeled completion.
- [ ] Delayed response from conversation A cannot alter B; stale poll/realtime responses cannot overwrite newer queue/active state. Include rapid/equal-timestamp updates.
- [ ] Authentication/CSRF and malformed-body protections cover both mutations. Existing run recovery, working-state, recency, model-profile, input, and pending-adoption tests remain passing.

Browser route mocks can verify rendering and navigation but cannot prove server execution without a browser. Require a real SessionManager/database integration test for that behavior, plus the live acceptance below if deployment is authorized.

Run the repository verification commands from the root; use isolated Playwright ports/configuration:

```bash
npm test
NODE_ENV=test npm run test -w @agent-console/web
npm run typecheck
npm run build
npm run test:e2e
```

`npm test` covers server tests, not the separate web unit suite. Existing useful regressions include `model-profile-lifecycle.test.ts`, `session-runtime.test.ts`, `session-lifecycle.test.ts`, `working-state.test.ts`, `session-recency.test.ts`, `run-recovery.test.ts`, and `pending-adoption.test.ts`. Recheck names at execution time; do not report old test counts as current results.

## 9. Authorized deployment and live proof

Historical checklist from before the 2026-09-24 local deployment. The original service backup and deployment evidence are retained outside Git under `/home/bryan/.local/state/codex-recovery/`; use the current architecture and runbook for future changes.

Do not deploy or restart the shared service merely because implementation tests pass. Obtain current authorization. Stage/commit/push only this feature if Bryan requests those actions; never stage the whole dirty worktree.

The deployment observed during the prior fix used the user service `agent-console.service`, executing `apps/server/dist/index.js`, with `KillMode=process` to preserve provider/tmux sessions. Recheck actual unit/config paths and process behavior; these are not guaranteed future facts. Build scoped, reviewed source, not an unrelated dirty tree, and deploy shared/server/web artifacts from the same revision. A Git push or healthy `/api/health` response alone is not deployment proof.

Before migration/deployment, obtain a consistent SQLite backup using supported SQLite backup semantics, verify it, and retain rollback artifacts. Do not copy only the main file of a running WAL database. Do not commit local config, credentials, database contents, or browser profiles.

With authorization, use a dedicated disposable Codex conversation and a harmless bounded turn:

1. Confirm its session ID, native conversation, canonical tmux owner, active profile, and actual `task_started`.
2. Select a different profile and prove the server persisted the queued request while the turn is still working.
3. Navigate to another conversation or close the tested page before the turn ends. Do not return to the original pane to trigger anything.
4. Let that turn finish, or stop only the disposable session through an approved control and confirm its matching `turn_aborted`.
5. Before reopening the page, verify the server cleared the request, the same native conversation is still bound, and the actual owned provider process/launch uses the target model and reasoning effort. Confirm only one switch occurred and unrelated sessions were not restarted.
6. Reopen and refresh: active target is shown, no stale queue remains. Repeat a browser reload while a request is pending to verify rehydration.
7. If backend-restart testing is authorized, queue another harmless disposable turn, restart the backend without killing its provider, and verify waiting/application without a browser. Otherwise explicitly report this live restart case as unverified; automated restart coverage is still required.
8. Release only the disposable session through the normal authenticated API. Preserve transcripts and evidence; do not delete user conversations or broad runtime directories.

For visible browser automation, follow repository instructions for `codex-visible-chrome` and the persistent profile; never copy/delete that profile. Do not run `scripts/verify-live-console.mjs` against its default conversation targets.

Rollback: disable further processing/cancel pending requests deliberately before returning to old code that does not understand them. Handle applying requests by checking actual ownership/liveness, not by blindly restoring database state. The nullable column can remain; do not drop it merely to roll back binaries. Do not overwrite a live database with an old backup and lose conversations created since that backup. If a safe rollback requires broader recovery, stop and explain it to Bryan.

## 10. Completion gate and final handoff

The feature is complete only when queued intent is server-owned, the old browser execution path is removed, focused/full verification passes, and the implemented behavior matches this contract. If deployment was requested, verify one real navigate-away example in the running service; otherwise say runtime behavior remains unverified.

Report: changed files and architecture, tests actually run/results, any remaining limitation, schema/session-lifecycle implications, commit/push status if requested, and exact deployment/live-proof status. Never say "fixed" solely because a button showed a queued label or a POST succeeded.

Suggested instruction for the implementing agent:

> Implement `docs/agent_docs/durable-model-profile-queue-plan.md` after reading repository instructions and the current diff. Preserve unrelated work and the existing turn-state fixes. Follow the behavior table and one-server-owned-request design; remove the browser queue rather than keeping a second execution path. Run the required tests. If current code invalidates a material design assumption, explain the conflict before changing the plan. Do not commit, push, deploy, restart shared services, or mutate existing user conversations unless I separately authorize it. Report what is verified and what remains unverified.
