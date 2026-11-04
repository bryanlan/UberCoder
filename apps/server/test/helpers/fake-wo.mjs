#!/usr/bin/env node
// A stand-in for workflow_optimizer's `wo` command. It prints what the real command prints for `profiles --json`,
// `route --task ... --json` and `route --level ... --json`, and never contacts the task classifier. Tests steer it with
// environment variables:
//   FAKE_WO_MODE=fail      exit 1 with a message on stderr
//   FAKE_WO_MODE=hang      never answer (the caller's timeout ends it)
//   FAKE_WO_MODE=garbage   print text that is not JSON
//   FAKE_WO_MODE=nomodel   exit 4 with the router's "nothing available" JSON
//   FAKE_WO_LOG=<file>     append the arguments of each call as one JSON line
//   FAKE_WO_VENDOR=<name>  the vendor `route` picks when the call names none (openai, anthropic or xai); default anthropic
//   FAKE_WO_PROVISIONAL=1  `route` answers with `"provisional": true`
//   FAKE_WO_REQUEST_LEVEL=<level>, FAKE_WO_REQUEST_EFFORT=<effort>
//                          what the classifier reads in `--latest-message` (ignored when no latest message is passed): a level
//                          routes like `--level`, an effort replaces the chosen effort
import fs from 'node:fs';

const at = (model, label, effort) => ({ model, label, effort, launch_name: model });
// Each vendor's model at each level, as the catalog defines them. Grok and Mistral Vibe have no Ultra or High model.
const LEVELS = {
  openai: {
    ultra: at('gpt-6-astra', 'GPT-6 Astra', 'xhigh'),
    high: at('gpt-6.1-sol', 'GPT-6.1 Sol', 'xhigh'),
    medium: at('gpt-6.1-terra', 'GPT-6.1 Terra', 'high'),
    low: at('gpt-6-luna', 'GPT-6 Luna', 'xhigh'),
  },
  anthropic: {
    ultra: at('claude-fable-5-1', 'Claude Fable 5.1', 'xhigh'),
    high: at('claude-opus-5-5', 'Claude Opus 5.5', 'xhigh'),
    medium: at('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'high'),
    low: at('claude-haiku-5-5', 'Claude Haiku 5.5', 'high'),
  },
  xai: {
    medium: at('grok-4.7', 'Grok 4.7', 'high'),
    low: at('grok-4.6', 'Grok 4.6', 'medium'),
  },
  mistral: {
    medium: { ...at('glm-5.3', 'GLM-5.3', 'high'), launch_name: 'glm-5-3' },
    low: { ...at('glm-5.3-flash', 'GLM-5.3 Flash', 'high'), launch_name: 'zai-glm-5-3-flash' },
  },
};

const args = process.argv.slice(2);
if (process.env.FAKE_WO_LOG) fs.appendFileSync(process.env.FAKE_WO_LOG, `${JSON.stringify(args)}\n`);
const mode = process.env.FAKE_WO_MODE;
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'fail') { process.stderr.write('wo: catalog is broken\n'); process.exit(1); }
else if (mode === 'garbage') { process.stdout.write('not json'); }
else if (args[0] === 'profiles') {
  process.stdout.write(JSON.stringify({ profiles: {
    codex: { provider: 'openai', levels: LEVELS.openai },
    claude: { provider: 'anthropic', levels: LEVELS.anthropic },
    grok: { provider: 'xai', levels: LEVELS.xai },
    vibe: { provider: 'mistral', levels: LEVELS.mistral },
  } }));
} else if (args[0] === 'route') {
  const provider = args[args.indexOf('--provider') + 1];
  if (mode === 'nomodel') {
    process.stdout.write(JSON.stringify({ status: 'unavailable', role: 'implementer', model: null, reason: 'Every acceptable implementer model is near its weekly cap.' }));
    process.exit(4);
  }
  const vendor = args.includes('--provider') ? provider : (process.env.FAKE_WO_VENDOR ?? 'anthropic');
  const latest = args.includes('--latest-message');
  const requestedLevel = latest ? process.env.FAKE_WO_REQUEST_LEVEL || null : null;
  const requestedEffort = latest ? process.env.FAKE_WO_REQUEST_EFFORT || null : null;
  const level = args.includes('--level') ? args[args.indexOf('--level') + 1] : requestedLevel;
  if (level) routeLevel(level, args.includes('--level') ? 'caller' : 'classifier', vendor, requestedEffort);
  else routeRole(vendor, args.includes('--provider') ? provider : null, requestedEffort);
} else { process.stderr.write(`fake wo: unknown command ${args[0]}\n`); process.exit(2); }

function routeLevel(level, source, vendor, effort) {
  const entry = LEVELS[vendor][level];
  const common = { role: null, launcher: 'console', level, level_source: source, requested_effort: effort, classifier: null, provisional: false };
  if (!entry) {
    process.stdout.write(JSON.stringify({ ...common, status: 'unavailable', provider: null, model: null,
      reason: `The ${level} level has no model from ${vendor} that the console launcher can start.` }));
    process.exit(4);
  }
  const lead = source === 'classifier' ? `Your latest message asked for the ${level} level. ` : '';
  process.stdout.write(JSON.stringify({ ...common, status: 'route', provider: vendor, model: entry.model, label: entry.label,
    effort: effort ?? entry.effort, launch_name: entry.launch_name, quota_state: 'on_pace',
    reason: `${lead}Best ${level}-level fit is ${entry.label} at ${effort ?? entry.effort} effort; it is on pace for its weekly quota.` }));
}

function routeRole(vendor, providerFilter, requestedEffort) {
  const models = {
    openai: ['gpt-6.1-terra', 'GPT-6.1 Terra'],
    anthropic: ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
    xai: ['grok-4.7', 'Grok 4.7'],
    mistral: ['glm-5.3', 'GLM-5.3'],
  };
  const [model, label] = models[vendor];
  process.stdout.write(JSON.stringify({
    status: 'route', role: 'implementer', launcher: 'console', provider: vendor,
    model, label, effort: requestedEffort ?? 'low', launch_name: model, quota_state: 'on_pace',
    level: null, level_source: null, requested_effort: requestedEffort,
    provider_filter: providerFilter,
    reason: 'The task classifier read this as implementer work. Best implementer fit is chosen; it is on pace for its weekly quota.',
    provisional: process.env.FAKE_WO_PROVISIONAL === '1',
    classifier: { status: 'ok', role_choice: 'implementer', role_probabilities: { implementer: 0.912, reviewer: 0.088 },
      difficulty_choice: 'lighter', difficulty_probabilities: { lighter: 0.8, standard: 0.2 } },
  }));
}
