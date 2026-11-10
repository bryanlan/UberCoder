#!/usr/bin/env python3
"""One private, locked scheduled check. Credentials never enter the model context."""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import secrets
import stat
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

spec = importlib.util.spec_from_file_location('pack', Path(__file__).with_name('lead-check-pack.py'))
pack_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack_module)


def fingerprint(messages):
    last = []
    for role in ('user', 'assistant'):
        found = [m for m in messages if m['role'] == role and m['text'].strip()]
        last.extend({'id': m['id'], 'role': m['role'], 'text': m['text']} for m in found[-1:])
    return hashlib.sha256(json.dumps(last, sort_keys=True).encode()).hexdigest()


class Console:
    def __init__(self, cfg):
        from urllib.parse import urlparse
        url = urlparse(cfg['console_url'])
        if url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost', '::1') or url.username or url.password:
            raise ValueError('Console URL must be local HTTP')
        self.base = cfg['console_url'].rstrip('/') + '/api/local/person-message/' + cfg['lead_session']
        key = Path(cfg['credential_file'])
        mode = key.lstat()
        if not stat.S_ISREG(mode.st_mode) or mode.st_mode & 0o077 or mode.st_uid != os.getuid():
            raise ValueError('Credential must be an owner-only regular file')
        self.token = key.read_text().strip()
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, suffix, body=None):
        request = urllib.request.Request(self.base + suffix, data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        try:
            with self.opener.open(request, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            raise RuntimeError('Console request refused: HTTP ' + str(e.code)) from None
        except urllib.error.URLError:
            raise RuntimeError('Console unavailable') from None

    def messages(self):
        return self.request('/messages')['messages']


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Exchange:
    def __init__(self, console, timeout, poll):
        self.console, self.timeout, self.poll = console, timeout, poll
        self.rounds = []
        self.pending = False
        self.timed_out = False

    def dispatch(self, name, args):
        if name == 'send_message':
            if set(args) != {'text'} or not isinstance(args['text'], str) or not args['text'].startswith('Bryan: '):
                raise ValueError('Message must start with Bryan: ')
            if self.pending or len(self.rounds) >= 2:
                raise ValueError('Wait for the reply before sending the next round; two rounds maximum')
            before = self.console.messages()
            # Capture the timeline boundary before sending, including an already-running lead turn.
            self.rounds.append({'sent': args['text'], 'before_ids': [m['id'] for m in before], 'reply': None})
            self.console.request('/input', args)
            self.pending = True
            return {'delivered': True, 'round': len(self.rounds)}
        if name != 'wait_for_reply' or args:
            raise ValueError('Unknown tool or arguments')
        if not self.pending:
            raise ValueError('Send a message before waiting')
        # Native tool transport has a 70-second call timeout: return pending and let the model call again.
        current = self.rounds[-1]
        current.setdefault('deadline', time.monotonic() + self.timeout)
        end = min(current['deadline'], time.monotonic() + 50)
        while time.monotonic() < end:
            messages = self.console.messages()
            marker = next((i for i, m in enumerate(messages) if m['id'] not in current['before_ids']
                and m['role'] == 'user' and m['text'].strip() == current['sent'].strip()), None)
            if marker is not None:
                answer = next((m for m in messages[marker+1:] if m['role'] == 'assistant'
                    and m['id'] not in current['before_ids'] and m['text'].strip()), None)
                if answer:
                    current['reply'] = answer['text']
                    self.pending = False
                    return {'reply': answer['text']}
            time.sleep(self.poll)
        if time.monotonic() >= current['deadline']:
            self.pending = False
            self.timed_out = True
            current['reply'] = 'no answer'
            return {'reply': 'no answer', 'timeout': True}
        return {'pending': True, 'instruction': 'Call wait_for_reply again.'}


def definitions():
    return [
        {'name': 'send_message', 'description': 'Send one message to the lead. Must start with Bryan: .',
         'inputSchema': {'type': 'object', 'properties': {'text': {'type': 'string'}}, 'required': ['text'], 'additionalProperties': False}},
        {'name': 'wait_for_reply', 'description': 'Wait for the first new lead text following your message; repeat if pending.',
         'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False}},
    ]


def run(cfg, plumbing=False, force=False):
    records = Path(cfg['records'])
    records.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = (records / '.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        return {'status': 'skipped', 'line': 'check already running', 'llm_usage': {}}
    # flock remains held until this function exits, including errors.
    try:
        console = Console(cfg)
        before = console.messages()
        previous = pack_module.previous_record(cfg)
        if not force and previous and previous[2].get('activity') == fingerprint(before):
            return {'status': 'skipped', 'line': 'no new lead turn', 'llm_usage': {}}
        pack = pack_module.build_pack(cfg)
        stamp = pack_module.utcnow()
        run_dir = records / ('run-' + stamp.replace(':', '-'))
        run_dir.mkdir(mode=0o700)
        (run_dir / 'pack.txt').write_text(pack)
        exchange = Exchange(console, cfg.get('reply_timeout_sec', 900), cfg.get('poll_sec', 2))
        from agent_consult.scripts import run_agent_consult as consult
        from agent_consult.scripts.analyst_tools import ToolHost
        level = 'low' if plumbing else 'ultra'
        prompt = Path(cfg['checker_prompt']).read_text() + '\n\n' + pack
        prompt += '\n\nRunner contract: You have exactly send_message and wait_for_reply. Use them for both rounds. '
        prompt += 'The runner writes the record at ' + str(run_dir / 'record.md') + ' and appends your line for Bryan. '
        prompt += 'After round two, wait once more for the lead, repeating pending waits. Then return ONLY a JSON object '
        prompt += 'with answer_summary (at most two short lines), commitment (one short line), and bryan_line '
        prompt += '(on track, optionally followed by a colon and what is new for him to open; redirected: from X to Y; '
        prompt += 'or needs you: what and why). '
        prompt += 'Do not write files yourself. If no answer, finish with needs you: no answer from the lead.'
        result = None
        model = {}
        try:
            selection = subprocess.run([cfg.get('router', '/home/bryan/.local/bin/wo'), 'route', '--level', level,
                '--launcher', 'console', '--provider', 'anthropic', '--json'], capture_output=True, text=True, check=True)
            model = json.loads(selection.stdout)
            result = consult.run_agent(agent='claude', model=model['model'], effort=model['effort'], prompt=prompt,
                cwd=run_dir, artifacts_dir=run_dir / 'runtime', access='analyst', tool_host=ToolHost(definitions(), exchange.dispatch),
                session_scope=hashlib.sha256((cfg['lead_session'] + stamp).encode()).hexdigest(),
                hard_timeout_sec=cfg.get('checker_timeout_sec', 2400), intent='custom')
            if not result.get('ok'):
                raise RuntimeError('Checker failed; see private runtime artifacts')
            raw = result['response_text'].strip()
            if raw.startswith('```'):
                raw = '\n'.join(raw.splitlines()[1:-1])
            final = json.loads(raw)
            if len(exchange.rounds) != 2 or exchange.pending:
                raise ValueError('Checker did not complete both rounds')
            line = ' '.join(final['bryan_line'].split())
            if not (line == 'on track' or line.startswith(('on track: ', 'redirected: ', 'needs you: '))):
                raise ValueError('Bryan line must start with on track, redirected: or needs you:')
            if exchange.timed_out:
                line = 'needs you: no answer from the lead'
            record = ('Time: ' + stamp + '\nAsked: ' + exchange.rounds[0]['sent'] + '\nLead: ' + final['answer_summary']
                + '\nSteered: ' + exchange.rounds[1]['sent'] + '\nCommitment: ' + final['commitment'] + '\nBryan: ' + line)
            if len(record.encode()) > 3000:
                raise ValueError('Record exceeds 3000 bytes')
            status = 'partial' if exchange.timed_out else 'updated'
        except Exception as error:
            line = 'needs you: no answer from the lead' if exchange.timed_out else 'needs you: scheduled check failed; inspect its private record'
            record = 'Time: ' + stamp + '\n' + line + '\nCompleted rounds: ' + str(len(exchange.rounds)) + '\nFailure type: ' + type(error).__name__
            record += '\nFailure: ' + ' '.join(str(error).split())[:200]
            status = 'failed'
        finally:
            (run_dir / 'exchange.json').write_text(json.dumps(exchange.rounds, indent=2))
        (run_dir / 'record.md').write_text(record + '\n')
        try:
            activity = fingerprint(console.messages())
        except Exception:
            activity = None  # Still retain the no-answer/failure record if the Console went away.
        entry = {'time': stamp, 'record': record, 'activity': activity, 'status': status,
            'pack_bytes': len(pack.encode()), 'model': model.get('model'), 'effort': model.get('effort'), 'line': line,
            'llm_usage': (result or {}).get('llm_usage', {}), 'evidence': str(run_dir)}
        dest = records / (run_dir.name + '.json')
        temporary = dest.with_suffix('.tmp')
        temporary.write_text(json.dumps(entry, indent=2))
        temporary.replace(dest)
        with (records / 'LINES.md').open('a') as lines:
            lines.write(stamp + ' ' + line + '\n')
        return entry
    finally:
        lock.close()


def main():
    os.umask(0o077)
    p = argparse.ArgumentParser()
    p.add_argument('--config', type=Path, required=True)
    p.add_argument('--init-credential', action='store_true')
    p.add_argument('--plumbing', action='store_true')
    p.add_argument('--force', action='store_true')
    p.add_argument('--execute', action='store_true', help='Run the check and deliver its messages')
    args = p.parse_args()
    cfg = json.loads(args.config.read_text())
    if args.init_credential:
        key = Path(cfg['credential_file'])
        key.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'w') as f:
            f.write(secrets.token_hex(32) + '\n')
        print('Local credential created')
        return
    if not args.execute:
        print('Dry run: would check the configured session; use --execute to deliver messages')
        return
    started = pack_module.utcnow()
    try:
        result = run(cfg, args.plumbing, args.force)
    except Exception as e:
        result = {'status': 'failed', 'line': 'Scheduled check could not run: ' + type(e).__name__, 'llm_usage': {}}
    usage = result.get('llm_usage') or {'provider': 'none', 'models': [], 'input_tokens': 0, 'output_tokens': 0, 'total_tokens': 0}
    target = {**result, 'plain_english_summary': result['line'], 'files_changed': [result['evidence']] if result.get('evidence') else [],
        'commits': [], 'pushed': False, 'push_status': 'not_applicable', 'validation_commands': [],
        'skipped_or_dirty_targets': [], 'issues': [], 'follow_up': [], 'ralph_review': {'required': False, 'status': 'not_required'}}
    summary = {'job_key': os.environ.get('WALTIUM_JOB_KEY'), 'run_id': os.environ.get('WALTIUM_RUN_ID'),
        'started_at': started, 'finished_at': pack_module.utcnow(), 'status': result['status'],
        'dashboard_summary': result['line'],
        'plain_english_summary': 'The job checks whether the active lead is moving toward the agreed goals. '
            + result['line'] + '. Messages and replies are retained in a private record when a check runs. '
            + 'No production release or Git push is performed. The timer is controlled in Waltium.',
        'llm_usage': usage, 'targets': [target], 'issues': [], 'follow_up': []}
    summary_path = os.environ.get('WALTIUM_SUMMARY_PATH') or os.environ.get('WO_SUMMARY_PATH')
    if summary_path:
        Path(summary_path).write_text(json.dumps(summary, indent=2))
    print(json.dumps({k: result.get(k) for k in ('status', 'line', 'pack_bytes', 'model', 'evidence')}))
    raise SystemExit(1 if result['status'] == 'failed' else 0)


if __name__ == '__main__':
    main()
