"""单机 SQLite 操作意图与结果台账"""
import json
from contextlib import contextmanager
import sqlite3

from .errors import fail
from .models import OperationError, OperationSnapshot, OperationState, StopState


class OperationLedger:
    def __init__(self, path):
        self.path = str(path)
        self._closed = False
        try:
            self._db = sqlite3.connect(self.path, timeout=1)
            self._db.row_factory = sqlite3.Row
            self._db.executescript('''
                PRAGMA synchronous=FULL;
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                INSERT OR IGNORE INTO metadata VALUES ('control_epoch', '0');
                INSERT OR IGNORE INTO metadata VALUES ('estop', '0');
                CREATE TABLE IF NOT EXISTS operations (
                    request_id TEXT PRIMARY KEY,
                    operation_id TEXT NOT NULL UNIQUE,
                    fingerprint TEXT NOT NULL,
                    target_id TEXT,
                    intent TEXT NOT NULL,
                    resources TEXT NOT NULL,
                    snapshot TEXT,
                    needs_review INTEGER NOT NULL DEFAULT 0
                );
            ''')
        except sqlite3.Error as exc:
            fail('$.records', 'ledger_unavailable', f'操作台账不可用: {exc}')

    def _check(self):
        if self._closed:
            fail('$.records', 'ledger_closed', '操作台账已关闭')

    def _execute(self, sql, parameters=()):
        self._check()
        try:
            return self._db.execute(sql, parameters)
        except sqlite3.Error as exc:
            fail('$.records', 'ledger_unavailable', f'操作台账访问失败: {exc}')

    @contextmanager
    def _transaction(self):
        self._check()
        try:
            with self._db:
                yield
        except sqlite3.Error as exc:
            fail('$.records', 'ledger_unavailable', f'操作台账事务失败: {exc}')

    def metadata(self, key):
        row = self._execute('SELECT value FROM metadata WHERE key=?', (key,)).fetchone()
        return row['value'] if row else None

    def set_metadata(self, key, value):
        self._check()
        with self._transaction():
            self._execute('INSERT OR REPLACE INTO metadata VALUES (?, ?)', (key, str(value)))

    def advance_epoch(self):
        self._check()
        with self._transaction():
            self._execute("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='control_epoch'")
            return int(self.metadata('control_epoch'))

    def persist_estop(self, active):
        with self._transaction():
            self._execute("UPDATE metadata SET value=? WHERE key='estop'", (str(int(active)),))
            self._execute("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='control_epoch'")
            return int(self.metadata('control_epoch'))

    def get_record(self, request_id):
        row = self._execute('SELECT * FROM operations WHERE request_id=?', (request_id,)).fetchone()
        if row is None:
            return None
        result = dict(row)
        for name in ('intent', 'resources', 'snapshot'):
            result[name] = json.loads(result[name]) if result[name] is not None else None
        result['needs_review'] = bool(result['needs_review'])
        return result

    def get_operation(self, operation_id):
        row = self._execute('SELECT snapshot FROM operations WHERE operation_id=?', (operation_id,)).fetchone()
        if row is None or row['snapshot'] is None:
            fail('$.operation_id', 'unknown_operation', '台账中没有可读取的执行快照')
        return OperationSnapshot.model_validate_json(row['snapshot'])

    def reserve(self, request, operation_id, fingerprint, resources):
        target = request.input.get('target_id')
        if target is None and isinstance(request.input.get('target'), dict):
            target = request.input['target'].get('target_id')
        with self._transaction():
            self._execute('INSERT INTO operations (request_id,operation_id,fingerprint,target_id,intent,resources) VALUES (?,?,?,?,?,?)',
                          (request.request_id, operation_id, fingerprint, target, request.model_dump_json(),
                           json.dumps([resource.model_dump(mode='json') for resource in resources])))

    def discard_unaccepted(self, operation_id):
        with self._transaction():
            self._execute('DELETE FROM operations WHERE operation_id=? AND snapshot IS NULL', (operation_id,))

    def save(self, snapshot):
        with self._transaction():
            cursor = self._execute('UPDATE operations SET snapshot=?, needs_review=? WHERE operation_id=?',
                                  (snapshot.model_dump_json(), int(snapshot.state == OperationState.UNKNOWN), snapshot.operation_id))
            if cursor.rowcount != 1:
                fail('$.operation_id', 'unknown_operation', '不能更新不存在的操作意图')

    def recover_pending(self):
        rows = self._execute('SELECT * FROM operations').fetchall()
        unresolved = []
        with self._transaction():
            for row in rows:
                snapshot = (OperationSnapshot.model_validate_json(row['snapshot']) if row['snapshot'] else
                            OperationSnapshot(operation_id=row['operation_id'], state='UNKNOWN', stop_state='UNCONFIRMED',
                                              error=OperationError(code='restart_requires_review', reason='重启发现未确认的操作意图')))
                if snapshot.state in {OperationState.ACCEPTED, OperationState.RUNNING, OperationState.CANCELING}:
                    snapshot.state = OperationState.UNKNOWN
                    snapshot.stop_state = StopState.UNCONFIRMED
                    snapshot.result = None
                    snapshot.error = OperationError(code='restart_requires_review', reason='重启发现执行中操作，需要核对，不会重发')
                self._execute('UPDATE operations SET snapshot=?,needs_review=? WHERE operation_id=?',
                              (snapshot.model_dump_json(), int(snapshot.state == OperationState.UNKNOWN), row['operation_id']))
                if snapshot.stop_state == StopState.UNCONFIRMED:
                    unresolved.append((row['operation_id'], json.loads(row['resources'])))
        return unresolved

    def close(self):
        if not self._closed:
            self._db.close()
            self._closed = True
