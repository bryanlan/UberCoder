#!/usr/bin/env node
// A stand-in for workflow_optimizer's `wo` command. It prints what the real command prints for `profiles --json` and
// `route --task ... --json`, and never contacts the task classifier. Tests steer it with environment variables:
//   FAKE_WO_MODE=fail      exit 1 with a message on stderr
//   FAKE_WO_MODE=hang      never answer (the caller's timeout ends it)
//   FAKE_WO_MODE=garbage   print text that is not JSON
//   FAKE_WO_MODE=nomodel   exit 4 with the router's "nothing available" JSON
//   FAKE_WO_LOG=<file>     append the arguments of each call as one JSON line
//   FAKE_WO_VENDOR=<name>  the vendor `route` picks when the call names none (openai, anthropic or xai); default anthropic
//   FAKE_WO_PROVISIONAL=1  `route` answers with `"provisional": true`
import fs from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_WO_LOG) fs.appendFileSync(process.env.FAKE_WO_LOG, `${JSON.stringify(args)}\n`);
const mode = process.env.FAKE_WO_MODE;
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'fail') { process.stderr.write('wo: catalog is broken\n'); process.exit(1); }
else if (mode === 'garbage') { process.stdout.write('not json'); }
else if (args[0] === 'profiles') {
  const level = (model, label, effort) => ({ model, label, effort, launch_name: model });
  process.stdout.write(JSON.stringify({ profiles: {
    codex: { provider: 'openai', levels: {
      high: level('gpt-6-astra', 'GPT-6 Astra', 'xhigh'),
      medium: level('gpt-6.1-sol', 'GPT-6.1 Sol', 'xhigh'),
      low: level('gpt-6-luna', 'GPT-6 Luna', 'xhigh'),
    } },
    claude: { provider: 'anthropic', levels: {
      high: level('claude-fable-5-1', 'Claude Fable 5.1', 'xhigh'),
      medium: level('claude-opus-5-5', 'Claude Opus 5.5', 'xhigh'),
      low: level('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'high'),
    } },
    grok: { provider: 'xai', levels: {
      high: level('grok-4.7', 'Grok 4.7', 'xhigh'),
      medium: level('grok-4.7', 'Grok 4.7', 'high'),
      low: level('grok-4.6', 'Grok 4.6', 'medium'),
    } },
  } }));
} else if (args[0] === 'route') {
  const provider = args[args.indexOf('--provider') + 1];
  if (mode === 'nomodel') {
    process.stdout.write(JSON.stringify({ status: 'unavailable', role: 'implementer', model: null, reason: 'Every acceptable implementer model is near its weekly cap.' }));
    process.exit(4);
  }
  const vendor = args.includes('--provider') ? provider : (process.env.FAKE_WO_VENDOR ?? 'anthropic');
  const models = {
    openai: ['gpt-6.1-terra', 'GPT-6.1 Terra'],
    anthropic: ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
    xai: ['grok-4.7', 'Grok 4.7'],
  };
  const [model, label] = models[vendor];
  process.stdout.write(JSON.stringify({
    status: 'route', role: 'implementer', launcher: 'console', provider: vendor,
    model, label, effort: 'low', launch_name: model, quota_state: 'on_pace',
    provider_filter: args.includes('--provider') ? provider : null,
    reason: 'The task classifier read this as implementer work. Best implementer fit is chosen; it is on pace for its weekly quota.',
    provisional: process.env.FAKE_WO_PROVISIONAL === '1',
    classifier: { status: 'ok', role_choice: 'implementer', role_probabilities: { implementer: 0.912, reviewer: 0.088 },
      difficulty_choice: 'lighter', difficulty_probabilities: { lighter: 0.8, standard: 0.2 } },
  }));
} else { process.stderr.write(`fake wo: unknown command ${args[0]}\n`); process.exit(2); }
