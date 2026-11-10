#!/usr/bin/env python3
"""Deterministic behavior checks; no provider call or real session input."""
import fcntl
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('runner', Path(__file__).with_name('lead-check-runner.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class Checks(unittest.TestCase):
    def test_activity_ignores_timestamps_but_not_new_user_turns(self):
        one = [{'id': 'a', 'role': 'assistant', 'text': 'same', 'timestamp': 'old'}]
        two = [{**one[0], 'timestamp': 'changed'}]
        self.assertEqual(r.fingerprint(one), r.fingerprint(two))
        two.append({'id': 'u', 'role': 'user', 'text': 'new turn'})
        self.assertNotEqual(r.fingerprint(one), r.fingerprint(two))

    def test_prefix_round_limit_and_timeout(self):
        class Console:
            def messages(self): return []
            def request(self, *args): return {'ok': True}
        e = r.Exchange(Console(), .001, .002)
        with self.assertRaises(ValueError): e.dispatch('send_message', {'text': 'unprefixed'})
        e.dispatch('send_message', {'text': 'Bryan: first'})
        with self.assertRaises(ValueError): e.dispatch('send_message', {'text': 'Bryan: overlapping'})
        self.assertEqual(e.dispatch('wait_for_reply', {})['reply'], 'no answer')
        e.dispatch('send_message', {'text': 'Bryan: second'})
        e.dispatch('wait_for_reply', {})
        with self.assertRaises(ValueError): e.dispatch('send_message', {'text': 'Bryan: third'})
        self.assertTrue(e.timed_out)

    def test_busy_turn_and_adopted_echo_are_not_old_answer(self):
        old = {'id': 'a', 'role': 'assistant', 'text': 'old'}
        class Console:
            sent = False
            def messages(self):
                return [old] if not self.sent else [old, {'id': 'u', 'role': 'user', 'text': 'Bryan: first'},
                    {'id': 'b', 'role': 'assistant', 'text': 'new'}]
            def request(self, *args): self.sent = True
        e = r.Exchange(Console(), 1, .001)
        e.dispatch('send_message', {'text': 'Bryan: first'})
        self.assertEqual(e.dispatch('wait_for_reply', {})['reply'], 'new')

    def test_lock_and_record_time_not_file_time(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            with (p / '.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertEqual(r.run({'records': d})['line'], 'check already running')
            (p / 'new.json').write_text(json.dumps({'time': '2026-11-10T12:00:00+00:00', 'record': 'new'}))
            (p / 'old.json').write_text(json.dumps({'time': '2026-11-10T10:00:00+00:00', 'record': 'old'}))
            self.assertEqual(r.pack_module.previous_record({'records': d})[2]['record'], 'new')

    def test_no_activity_skips_without_model(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / 'last.json').write_text(json.dumps({'time': '2026-11-10T12:00:00+00:00', 'record': 'last',
                'activity': r.fingerprint([])}))
            with patch.object(r, 'Console') as c:
                c.return_value.messages.return_value = []
                self.assertEqual(r.run({'records': d})['line'], 'no new lead turn')

    def test_pack_uses_record_cutoff_and_keeps_all_checks(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'goals').write_text('# Goals\n1. **Use the page.** Body excluded')
            labels = ''.join(f'### M{i} milestone\n' + ''.join(f'- **{i}{c} check label:** body excluded\n' for c in 'ABCDEF') for i in range(1, 8))
            (root / 'steering').write_text(labels)
            (root / 'decisions').write_text('### D1 (2026-11-10T09:00Z): old\n### D2 (2026-11-10T11:00Z): new')
            (root / 'queue').write_text('- DONE 2026-11-10T09:00Z old\n- STARTED 2026-11-10T11:00Z new')
            records = root / 'records'; records.mkdir()
            (records / 'record.json').write_text(json.dumps({'time': '2026-11-10T10:00:00+00:00', 'record': 'x' * 3000}))
            cfg = {k: str(root / k) for k in ('goals', 'steering', 'decisions', 'queue', 'records')}
            cfg.update(console_db=str(root / 'unused'), lead_assignment='lead', initial_since='2026-11-10T08:00:00+00:00', repositories=[])
            db = MagicMock()
            db.execute.side_effect = lambda query, *args: SimpleNamespace(fetchone=lambda: {'description': 'Working', 'status': 'active'}) if 'coordination_assignments' in query else []
            with patch.object(r.pack_module.sqlite3, 'connect') as connect:
                connect.return_value.__enter__.return_value = db
                pack = r.pack_module.build_pack(cfg)
            self.assertLessEqual(len(pack.encode()), 8000)
            self.assertEqual(pack.count('### M'), 7)
            self.assertEqual(pack.count('check label:**'), 42)
            self.assertNotIn('D1 (', pack)
            self.assertIn('D2 (', pack)
            self.assertNotIn('09:00Z old', pack)
            self.assertIn('11:00Z new', pack)
            self.assertIn('x' * 3000, pack)
            self.assertNotIn('body excluded', pack)

    def test_no_answer_writes_record_line_and_usage(self):
        self.no_answer_run('on track', 'partial')

    def test_on_track_line_may_say_what_is_new_to_open(self):
        self.no_answer_run('on track: the second page is new\nto open', 'partial')

    def test_unknown_line_fails_and_record_says_why(self):
        result = self.no_answer_run('all good', 'failed')
        self.assertIn('Failure: Bryan line must start with', result['record'])

    def no_answer_run(self, bryan_line, expected_status):
        with tempfile.TemporaryDirectory() as d:
            prompt = Path(d) / 'prompt'; prompt.write_text('Test prompt')
            cfg = {'records': d, 'checker_prompt': str(prompt), 'lead_session': 'fixture', 'reply_timeout_sec': .001, 'poll_sec': .002}
            def checker(**kwargs):
                host = kwargs['tool_host']
                for text in ('Bryan: first', 'Bryan: second'):
                    host.dispatch('send_message', {'text': text})
                    host.dispatch('wait_for_reply', {})
                return {'ok': True, 'response_text': json.dumps({'answer_summary': 'No answer', 'commitment': 'None', 'bryan_line': bryan_line}),
                    'llm_usage': {'input_tokens': 10, 'output_tokens': 2, 'total_tokens': 12}}
            with patch.object(r, 'Console') as c, patch.object(r.pack_module, 'build_pack', return_value='pack'), \
                 patch.object(r.subprocess, 'run', return_value=SimpleNamespace(stdout=json.dumps({'model': 'fixture', 'effort': 'high'}))), \
                 patch('agent_consult.scripts.run_agent_consult.run_agent', side_effect=checker):
                c.return_value.messages.return_value = []
                result = r.run(cfg)
            self.assertEqual(result['status'], expected_status)
            self.assertEqual(result['line'], 'needs you: no answer from the lead')
            self.assertEqual(result['llm_usage']['total_tokens'], 12)
            self.assertIn('needs you: no answer from the lead', (Path(d) / 'LINES.md').read_text())
            self.assertTrue((Path(result['evidence']) / 'record.md').exists())
            return result

    def test_credential_creation_never_overwrites_or_prints_key(self):
        import subprocess
        with tempfile.TemporaryDirectory() as d:
            cfg = Path(d) / 'config.json'
            key = Path(d) / 'key'
            cfg.write_text(json.dumps({'credential_file': str(key)}))
            command = ['/usr/bin/python3', str(Path(__file__).with_name('lead-check-runner.py')), '--config', str(cfg), '--init-credential']
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout.strip(), 'Local credential created')
            self.assertEqual(key.stat().st_mode & 0o777, 0o600)
            first = key.stat().st_mtime_ns
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(key.stat().st_mtime_ns, first)


if __name__ == '__main__': unittest.main()
