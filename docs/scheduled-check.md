# Scheduled progress check (operator reference)

This operator reference belongs in the Console repository only. Keep it out of planner instructions, coordination descriptions, planner documents and wiki pages.

The private config selects one lead session and its coordination assignment, source paths, records directory and local Console URL. `config/lead-check.example.json` is the template. Handoffs edit only the private config's `lead_session` and `lead_assignment`. Credentials live separately in the Console runtime directory.

`python3 scripts/lead-check-pack.py --config PRIVATE_CONFIG` prints at most 8,000 UTF-8 bytes. It keeps milestone/check labels, short worker labels with assignment pointers and the previous record whole. Change lists contain only decision headings, commit subjects and dated Desktop STARTED/DONE lines since the previous record's UTC time. Long change lists include omission counts and source pointers. Untimed lines cannot prove a newer event and are excluded. Required material that cannot fit fails explicitly.

`python3 scripts/lead-check-runner.py --config PRIVATE_CONFIG --execute` runs one check. Without `--execute` it prints a dry run. The runner holds a nonblocking file lock throughout; a second invocation skips. It skips when the latest user and assistant activity matches the last record. `--force` bypasses the activity skip only.

The shared agent-consult runtime starts a fresh Claude analyst at the router's anthropic ultra selection (currently Fable). `--plumbing` selects anthropic low for an isolated proof. Its two native tools send a prefixed message and wait for the next new assistant text after that message's transcript echo. Baseline messages cannot become replies; a lead already running can receive the input through the normal session manager. A wait returns pending before the native tool deadline and may be repeated. The configured overall reply timeout records `no answer` and produces `needs you: no answer from the lead`.

The unchanged checker prompt is followed by the pack and runner output contract. The checker returns record fields in JSON; the runner writes UTC time, the two exact messages, a two-line answer summary, commitment and Bryan's line. The complete exchange and runtime accounting stay private. The previous compact record is capped at 3,000 bytes, keeping room in the next pack. Extra source reads and direct filesystem writes are unavailable to the checker because its host deliberately exposes exactly two tools.

There is no supported shell-to-Console notice route. As directed, the runner appends Bryan's line to `records/LINES.md`. No notification system or peer-message substitute was added. Scheduler audit JSON includes plain-English outcomes and token usage at `WALTIUM_SUMMARY_PATH`.

## Local credential and HTTP boundary

This is an auth and session-input change. The new routes are outside MCP, coordination and grants:

- `POST /api/local/person-message/:sessionId/input` accepts only `{text}` beginning `Bryan: ` and delivers through `SessionManager.sendInput`.
- `GET /api/local/person-message/:sessionId/messages` reads provider transcript messages merged with approved live input rows. It returns the last 100 user/assistant messages.

Both require loopback plus a bearer key from `runtimeDir/person-message.key`, an owner-only regular file owned by the backend user. No key means the routes refuse access. Key generation is explicit: `python3 scripts/lead-check-runner.py --config PRIVATE_CONFIG --init-credential`. It creates a fresh key in place, never prints it, and refuses to overwrite a file. Cookies and CSRF are not used by these bearer-only routes. Existing browser auth is unchanged. No config schema or database schema changes are needed. The credential grants local message/read access to bound sessions; protect it as a runtime secret.

## Timer

`/home/bryan/code/waltium-wt/scheduled-check-registration/config/jobs/console_scheduled_check_two_hourly.toml` is the reviewed source for the disabled Waltium registry installation (branch `feat/scheduled-check-registration`). The installed canonical registry file has identical bytes. It uses the existing scheduler every two hours at minute zero, one attempt, and a 45-minute outer timeout. Its branch workdir is intentional until integration; update the registered workdir to the integrated checkout before removing the branch worktree. No OS cron entry is added.

From `/home/bryan/code/waltium`, enable with `python3 -m waltiumctl jobs set-enabled console_scheduled_check_two_hourly --enabled true --updated-by bryan --execute`; disable with the same command and `--enabled false`. The timer is initially registered off. Enabling requires the source changes deployed to the running Console, the private target config checked and the local credential generated. This build does not restart or redeploy the live Console.

## Verification

`python3 scripts/test-lead-check.py` checks prefix/round validation, reply correlation, timeout, lock exclusion, record-time ordering and activity skip without a provider call.

The route test `npm run test -w @agent-console/server -- --maxWorkers=1 test/person-message.test.ts` uses a real session manager with an isolated structured fixture.

Opt-in full proof: `LEAD_CHECK_REAL_PROOF=1 LEAD_CHECK_EVIDENCE=/absolute/private/fresh-folder npm run test -w @agent-console/server -- --maxWorkers=1 test/scheduled-check-proof.test.ts`. It listens on an isolated ephemeral port, creates a throwaway structured session with scripted provider replies, starts a low-tier checker and then a real Fable checker with the original prompt, checks both rounds/records/lines and the activity skip, then releases its server and session. It never sends to a real lead. Evidence excludes credentials; fixture credentials are deleted with the fixture.
