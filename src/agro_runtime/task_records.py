"""任务快照与事件的持久存储"""
import json
import sqlite3

from .errors import fail
from .management import timestamp


class TaskStore:
    def __init__(self, path):
        self.db = sqlite3.connect(path, timeout=1)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
            PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS tasks (
                request_id TEXT PRIMARY KEY, task_run_id TEXT UNIQUE NOT NULL,
                fingerprint TEXT NOT NULL, snapshot TEXT NOT NULL, status TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS task_events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, task_run_id TEXT NOT NULL, payload TEXT NOT NULL);
        ''')

    def by_request(self, identity):
        row = self.db.execute('SELECT * FROM tasks WHERE request_id=?', (identity,)).fetchone()
        return dict(row) if row else None

    def status(self, identity):
        row = self.db.execute('SELECT status FROM tasks WHERE task_run_id=?', (identity,)).fetchone()
        if row is None:
            fail('$.task_run_id', 'unknown_task', '任务运行标识不存在')
        return json.loads(row['status'])

    def snapshot(self, identity):
        row = self.db.execute('SELECT snapshot FROM tasks WHERE task_run_id=?', (identity,)).fetchone()
        if row is None:
            fail('$.task_run_id', 'unknown_task', '任务运行标识不存在')
        return json.loads(row['snapshot'])

    def reserve(self, request_id, identity, fingerprint, snapshot, status):
        now = timestamp()
        status.update(started_at=now, updated_at=now, finished_at=None)
        with self.db:
            self.db.execute('INSERT INTO tasks VALUES (?,?,?,?,?)',
                            (request_id, identity, fingerprint, json.dumps(snapshot), json.dumps(status)))
            self.event(identity, {'type': 'task_accepted', 'state': status['state']})

    def save(self, identity, status):
        status['updated_at'] = timestamp()
        if status['state'] in {'SUCCEEDED', 'FAILED', 'CANCELED', 'STOPPED'} and status.get('stop_confirmed') and not status.get('finished_at'):
            status['finished_at'] = status['updated_at']
        with self.db:
            self.db.execute('UPDATE tasks SET status=? WHERE task_run_id=?', (json.dumps(status), identity))

    def event(self, identity, payload):
        with self.db:
            self.db.execute('INSERT INTO task_events(task_run_id,payload) VALUES (?,?)',
                            (identity, json.dumps({'timestamp': timestamp(), **payload})))

    def events(self, identity):
        return [dict(seq=row['seq'], **json.loads(row['payload'])) for row in self.db.execute(
            'SELECT seq,payload FROM task_events WHERE task_run_id=? ORDER BY seq', (identity,))]

    def list(self):
        return [json.loads(row['status']) for row in self.db.execute('SELECT status FROM tasks ORDER BY rowid')]

    def close(self):
        self.db.close()
