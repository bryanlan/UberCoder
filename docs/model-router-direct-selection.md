# Direct model routing, 2026-11-07

`wo route --task` now asks JEV for a model and reasoning effort directly from eligible models,
authored capability guidance, sample tasks and subscription quota. New receipts omit task
categories and difficulty shifts. Explicit human tier/model requests constrain the inventory.
The existing per-provider conversation binding remains mandatory.

Console sends its enabled new-chat providers as `--providers` before selection. It validates
the returned choice and never replaces it with an alternative model. A bound conversation
still sends exactly its own provider. No enabled providers means no selector request.

The adapter accepts the new receipt shape without category fields. Existing saved decisions
with old category metadata remain readable. The existing visible Medium fallback on routing
failure is unchanged. No auth, proxy, session-host, or localhost exposure contract changes.

Owner contract and audit: `workflow_optimizer/docs/architecture.md` and
`workflow_optimizer/docs/model-routing-audit-2026-11-07.md`. Worktree evidence is in
`/home/bryan/.local/share/workflow_optimizer/router-audits/2026-11-07/`.

All 2,067 server tests passed (five skipped), including 48 routing/start tests. Server build
and source/test typecheck passed. Installed adapter and backend adoption are retained in
`console-installed-route.json` and `console-runtime-adoption.json`. Browser e2e was not run.
