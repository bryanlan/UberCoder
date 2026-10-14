# Peer-wake audit

Console owns wake measurements. Waltium schedules deterministic checks every five minutes and
a daily 24-hour audit at 07:10 in the machine's local timezone. Neither job launches an LLM.
Message delivery remains enabled. Review the first seven days of daily reports to calibrate
the warning thresholds; there is no automatic switch to throttling after that week.

The read-only owner command is:

```bash
node apps/server/dist/coordination/audit-cli.js --hours 1
node apps/server/dist/coordination/audit-cli.js --hours 24 --usage
```

Use `--config PATH` for an isolated runtime. The command opens existing SQLite read-only and
never constructs `AppDatabase`, migrates tables, restores a session or contacts a provider.
The default check reads SQLite and bounded private transport logs. The daily `--usage` option streams only the transcripts
of sessions with wake records in the reporting window, once per session.

## Measurements and warnings

Durable attempts sharing a session ID, timestamp and outcome form one submission group,
regardless of message count. A successful native-input submission is distinct from an
acknowledgement and from native turn completion. Counts include attempted messages, failed
and unconfirmed submissions, acknowledgements, acknowledgement delays and managed pending
messages. Agent, project, provider and peer-pair rollups retain the group counts.

Deployment fixtures are labelled from their disposable verification assignment descriptions.
A backlog-only group contains messages all queued at least one hour before submission.
Both categories remain in the audit and have separate usage totals. Frequency warnings use
normal groups only. Their initial conditions are:

| Condition | Warning |
| --- | --- |
| One agent receives at least 5 submissions in 10 minutes or 20 in one hour | Review frequency |
| One pair has at least 6 alternating wake submissions in 10 minutes | Review a possible loop |
| A client timeout, failed hook, abandoned RPC or event-loop delay of at least 1 second in the preceding 10 minutes | Investigate message transport |
| A successfully submitted peer turn completed but its message is still unacknowledged after 2 minutes | Investigate receipt and follow-up guards |
| Transport measurements are unavailable, malformed or capped | Audit coverage is incomplete |

Initial and follow-up attempts remain separate, with their ordinal in each message entry.
A message can contribute two attempts and only one acknowledgement. A follow-up remains
subject to the delivery guards in the coordination contract; warnings never bypass them.

Native clients and the backend append whitelisted measurements to daily JSONL files under
`runtimeDir/coordination/telemetry`. The directory is private (0700), files are 0600,
and records exclude prompts, peer text and credentials. Clients record request durations,
timeouts and hook failures even when the backend cannot respond. The server records RPC and
HTTP completion (excluding the long-lived event stream), abandoned responses, ten-second event-loop windows and search update costs.
Offer history distinguishes a response that finished writing from one abandoned by the client.
Neither outcome proves the agent read it; only acknowledgement records that claim.

The audit reports queue-to-first-finished-offer and finished-offer-to-acknowledgement delays
with sample counts, including messages delivered without a wake. First offers mean the first
observed in the selected report window; earlier offers outside it or before collection remain
unknown. `firstRecordedAt` and `lastRecordedAt` bound observed coverage.
The event-loop percentile is explicitly the percentile of ten-second window maxima; it is
not a percentile of every individual loop sample. Recent transport warnings clear after ten
minutes; daily `observedWarnings` retains recovered failures throughout the reporting window.

Routine files are capped at 64 MiB per UTC day. Delivery failures, abandoned responses, slow
event-loop windows and offers have a separate reserved 16 MiB/day budget in `.failures.jsonl`,
so routine traffic cannot prevent a later failure from being recorded. Both are retained for
eight days plus the current day. Exhausting either budget produces its own coverage marker.
A cap marker makes missing counts explicit. The read-only audit streams all records and keeps
numeric latency samples rather than routine request objects. It retains at most 100,000 offer
records and one million latency samples per measurement type/window. Counts and maxima continue
through these reader limits; partial offer timing or percentiles are explicitly marked incomplete.
Telemetry never enters normal agent context and append failures never change delivery.

Delivery warnings query durable attempt records for each currently pending message, independently
of the reporting window. A later follow-up does not clear an unacknowledged warning, and an old
wake does not age it out; acknowledgement or assignment closeout resolves that condition.

These conditions identify conversations to inspect; they do not establish wasted work.
Checks evaluate both current windows and windows ending at each normal wake in the preceding
ten minutes, so a burst between five-minute checks is retained. `warnings` contains these recent
conditions. `observedWarnings` records distinct conditions observed anywhere in the reporting
window, with their latest observed time. The audit reads one additional hour for threshold
context without including it in the reporting-window counts. The daily summary distinguishes
daywide observations from recent warnings. An unconfirmed submission may still be in flight
or may have been interrupted; a durable submitting marker alone does not prove interruption.
Stable warning keys allow Waltium to update one operator item per condition. A successful
clear check closes that rolling condition. Failed, malformed or stale audits cannot clear
warnings. Provider drafts, approvals and long tools may explain pending messages; pending
age alone does not stop an agent or change a delivery guard.

New wake records distinguish `already_loaded` and `restored`. A marker records the restored
process PID and actual restore time, independent of the original binding time, and retains a peer-caused
restore through provider startup deferral and is consumed by its first successful response
submission. A completed intervening response makes a later wake already loaded. Older
records without this measurement report unknown; no historical reconstruction is invented.

## Native usage and evidence

Native recognition uses the reserved coordination-control envelope for peer-inbox and unattended continuation notices, preserving classification when notice wording changes. Message-pair attribution still requires a recorded message submission interval; a silent-idle or worker-result continuation without a message is not attributed to a message pair. Usage is attributed only to a native coordination-control envelope within a unique
submission interval. Codex requires native `token_usage_record.turn_token_usage` snapshots
and a matching lifecycle turn ID; session totals and duplicated `token_count` records are
not used. Claude deduplicates streamed assistant usage by native message ID, excludes
sidechains and tool-result inputs, and stops at the next actual user prompt. Input totals
include cached input once, accounting for the providers' different native conventions.
Native outcome, completion time and duration are separate from message acknowledgement.
Reads exclude native records after the audit snapshot time. Ambiguous or missing attribution
stays unknown rather than zero. Known usage can be partial while a native turn is running.

The report includes measured and unknown wake coverage and token totals for each category.
Pricing assumptions are not configured, so estimated dollar cost remains null. These token
measurements are not subscription billing and are not charged again to the deterministic
scheduler job's zero `llm_usage`. Reports contain IDs and measurements, never prompts,
message bodies or credentials.
Usage covers the parent coordination-response turn only. Delegated Codex and Claude child-agent
transcripts are not collected; their usage remains unknown and is excluded from these totals.

Waltium retains each report beside its run summary as `.audit.json`; the summary carries the
report link, busiest agents/pairs, usage coverage and delays. Manual refresh paths are:

```bash
cd /home/bryan/code/waltium
python3 -m waltiumctl jobs run agent_console_peer_wake_check
python3 -m waltiumctl jobs run agent_console_peer_wake_daily
```

The check updates only local operator warning rows. For a report without queue changes,
run `python3 -m waltiumctl.peer_wake_audit --mode check --report-path /tmp/peer-wake-audit.json`.
