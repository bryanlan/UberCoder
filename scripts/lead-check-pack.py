#!/usr/bin/env python3
"""Print a bounded, read-only context pack for a specified lead assignment."""
import argparse
import datetime as dt
import json
from pathlib import Path
import sqlite3
import subprocess


def excerpt(text, limit):
    return text if len(text) <= limit else text[:limit] + '\n[truncated]'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--lead', required=True)
    args = parser.parse_args()
    cfg = json.loads(args.config.read_text())
    records = Path(cfg['records'])
    previous = sorted(records.glob('*.md'), key=lambda p: p.stat().st_mtime) if records.exists() else []
    last = previous[-1] if previous else None
    since = dt.datetime.fromtimestamp(last.stat().st_mtime, dt.timezone.utc) if last else dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)
    db = sqlite3.connect(Path(cfg['console_db']).as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    lead = db.execute('select id, description, status from coordination_assignments where id=?', (args.lead,)).fetchone()
    if not lead or lead['status'] == 'finished':
        raise SystemExit('Lead assignment is missing or finished')
    board = []
    for row in db.execute("select key,value from meta where key like 'assignment-continuation:%'"):
        control = json.loads(row['value'])
        if control.get('supervisorId') != args.lead:
            continue
        aid = row['key'].split(':', 1)[1]
        assignment = db.execute('select description,status from coordination_assignments where id=?', (aid,)).fetchone()
        task = db.execute('select value from meta where key=?', ('assignment-task:' + aid,)).fetchone()
        board.append({'assignment': dict(assignment) if assignment else None, 'task': json.loads(task['value']) if task else None})
    print('# Goals\n' + excerpt(Path(cfg['goals']).read_text(), 4500))
    print('\n# Steering\n' + excerpt(Path(cfg['steering']).read_text(), 4500))
    print('\n# Lead and worker board\n' + excerpt(json.dumps({'lead': dict(lead), 'workers': board}, indent=2), 5000))
    print('\n# Changes since ' + since.isoformat())
    headings = [line for line in Path(cfg['decisions']).read_text().splitlines() if line.startswith('### D')]
    print('\n'.join(headings[-20:]))
    print('\n# Recent queue\n' + excerpt('\n'.join(Path(cfg['queue']).read_text().splitlines()[-50:]), 3000))
    for repo in cfg['repositories']:
        log = subprocess.run(['git', '-C', repo, 'log', '--all', '--since=' + since.isoformat(), '--format=%h %cs %s', '-40'], check=True, capture_output=True, text=True)
        print('\n# Commits ' + repo + '\n' + excerpt(log.stdout, 3000))
    print('\n# Previous record\n' + (excerpt(last.read_text(), 3000) if last else '(none)'))


if __name__ == '__main__':
    main()
