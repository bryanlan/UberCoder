#!/usr/bin/env python3
"""Bounded pointers and headings, never a dump of the steering documents."""
import argparse
import datetime as dt
import json
import re
import sqlite3
import subprocess
from pathlib import Path


def utcnow():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def previous_record(cfg):
    records = []
    for p in Path(cfg['records']).glob('*.json'):
        if p.name.endswith('.exchange.json'):
            continue
        d = json.loads(p.read_text())
        if 'time' in d:
            records.append((d['time'], p, d))
    return max(records, key=lambda x: dt.datetime.fromisoformat(x[0]), default=None)


def event_time(line, inherited=None):
    match = re.search(r'20\d\d-\d\d-\d\d(?:T\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)?)?', line)
    if match:
        raw = match[0]
        if len(raw) == 10:
            return inherited  # a date alone cannot prove it is newer
        return dt.datetime.fromisoformat(raw.replace('Z', '+00:00')).replace(tzinfo=dt.timezone.utc)
    return inherited


def heading(text, limit=35):
    # A compact label with its assignment pointer, not task-body source text.
    words = text.split()
    result = ''
    for word in words:
        if len((result + ' ' + word).encode()) > limit:
            return result + ' ...'
        result = (result + ' ' + word).strip()
    return result


def build_pack(cfg):
    previous = previous_record(cfg)
    since = previous[2]['time'] if previous else cfg['initial_since']
    cutoff = dt.datetime.fromisoformat(since.replace('Z', '+00:00'))
    sections = []
    for name, key in [('Goals', 'goals'), ('Steering milestones and checks', 'steering')]:
        lines = []
        for line in Path(cfg[key]).read_text().splitlines():
            if key == 'goals' and (line.startswith('#') or re.match(r'^\d+\. \*\*', line)):
                lines.append(line.split('**', 2)[0] + '**' + line.split('**', 2)[1] + '**' if '**' in line else line)
            elif key == 'steering' and (re.match(r'^### M\d', line) or re.match(r'^- \*\*\d[A-Z] ', line)):
                lines.append(line.split('**', 2)[0] + '**' + line.split('**', 2)[1] + '**' if '**' in line else line)
        if key == 'steering':
            lines.sort(key=lambda line: 0 if line.startswith('### M') else 1)
        sections.append((name + ' (' + cfg[key] + ')', lines))
    with sqlite3.connect(Path(cfg['console_db']).as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        lead = db.execute('select description,status from coordination_assignments where id=?', (cfg['lead_assignment'],)).fetchone()
        if not lead or lead['status'] == 'finished':
            raise ValueError('Lead assignment missing or finished')
        board = ['Lead ' + cfg['lead_assignment'] + ': ' + heading(lead['description'], 160)]
        for row in db.execute("select key,value from meta where key like 'assignment-continuation:%'"):
            if json.loads(row['value']).get('supervisorId') != cfg['lead_assignment']:
                continue
            aid = row['key'].split(':', 1)[1]
            task = db.execute('select value from meta where key=?', ('assignment-task:' + aid,)).fetchone()
            if task:
                task = json.loads(task['value'])
                updated = task.get('updatedAt')
                if task.get('state') == 'done' and updated and dt.datetime.fromisoformat(updated.replace('Z', '+00:00')) <= cutoff:
                    continue
                board.append(aid[:8] + ': ' + task.get('state', '?') + ' ' + heading(task.get('deliverable', '')) + ('; needs action (see task)' if task.get('actionNeeded') else ''))
        sections.append(('Lead and workers', board))
    headings = []
    stamp = None
    for line in Path(cfg['decisions']).read_text().splitlines():
        if line.startswith('### D'):
            stamp = event_time(line)
            if stamp and stamp > cutoff:
                headings.append(line)
    sections.append(('Decision headings since ' + since + ' (' + cfg['decisions'] + ')', headings))
    queue = []
    stamp = None
    for line in Path(cfg['queue']).read_text().splitlines():
        stamp = event_time(line)
        if stamp and stamp > cutoff and re.search(r'\b(STARTED|DONE)\b', line):
            queue.append(line)
    sections.append(('Desktop STARTED/DONE (' + cfg['queue'] + ')', queue))
    for repo in cfg['repositories']:
        log = subprocess.run(['git', '-C', repo, 'log', '--all', '--since=' + since, '--format=%h %s'], check=True, capture_output=True, text=True)
        sections.append(('Commit subjects (' + repo + ')', log.stdout.splitlines()))
    # Goals, every milestone/check label, every worker state and the last record are mandatory.
    # Only the since-time change lists may elide rows, with counts and source pointers.
    last = previous[2]['record'] if previous else '(none)'
    prefix = '# Check time ' + utcnow() + '\n'
    suffix = '\n# Previous record\n' + last + '\n'
    core = ''.join('\n# ' + title + '\n' + '\n'.join(lines) + '\n' for title, lines in sections[:3])
    changes = sections[3:]
    budget = 8000 - len((prefix + core + suffix).encode())
    if budget < 600:
        raise ValueError('Required headings and previous record leave insufficient pack space')
    chunks = []
    per = budget // len(changes)
    for title, lines in changes:
        chunk = '\n# ' + title + '\n'
        omitted = 0
        for line in lines:
            if len((chunk + line + '\n').encode()) > per - 70:
                omitted += 1
            else:
                chunk += line + '\n'
        if omitted:
            chunk += f'[{omitted} more lines at source pointer]\n'
        chunks.append(chunk)
    pack = prefix + core + ''.join(chunks) + suffix
    if len(pack.encode()) > 8000:
        raise ValueError('Pack exceeds 8000 bytes')
    return pack


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--config', type=Path, required=True)
    args = p.parse_args()
    print(build_pack(json.loads(args.config.read_text())), end='')


if __name__ == '__main__':
    main()
