"""Keep frozen HSM inputs separate from frequently persisted runtime state."""
import json

from .configuration import encoded, identifier


class SessionRecords:
    FROZEN = ('definition', 'dependencies')

    def __init__(self, store):
        self.store = store
        self._frozen = {}

    def _frozen_json(self, record):
        identity = record['id']
        if identity not in self._frozen:
            row = self.store.db.execute("SELECT body FROM documents WHERE kind='hsm_frozen' AND id=?", (identity,)).fetchone()
            self._frozen[identity] = row[0] if row else encoded({key: record[key] for key in self.FROZEN if key in record})
        return self._frozen[identity]

    def _hydrate(self, record):
        identity = record.pop('_frozen_session', None)
        if identity is not None:
            if identity not in self._frozen:
                # A missing frozen record is a storage error, never an empty definition
                self._frozen[identity] = encoded(self.store.get('hsm_frozen', identity))
            record.update(json.loads(self._frozen[identity]))
        return record

    def get(self, identity):
        return self._hydrate(self.store.get('hsm_session', identity))

    def list(self):
        return [self._hydrate(record) for record in self.store.list('hsm_session')]

    def save(self, record):
        identity = record['id']
        identifier(identity)
        body = encoded({**{key: value for key, value in record.items() if key not in self.FROZEN}, '_frozen_session': identity})
        existing = self.store.db.execute("SELECT 1 FROM documents WHERE kind='hsm_frozen' AND id=?", (identity,)).fetchone()
        frozen = self._frozen_json(record) if not existing else None
        # First frozen inputs and first mutable state commit together; subsequent
        # transitions keep the same durable boundary without rewriting the inputs
        with self.store.db:
            if frozen is not None:
                self.store.db.execute('INSERT INTO documents VALUES (?,?,?)', ('hsm_frozen', identity, frozen))
            self.store.db.execute('INSERT OR REPLACE INTO documents VALUES (?,?,?)', ('hsm_session', identity, body))
        return record

    def json(self, record, operations=None):
        if record is None:
            return 'null'
        mutable = {key: value for key, value in record.items() if key not in self.FROZEN}
        result = json.dumps(mutable, ensure_ascii=False, allow_nan=False)[:-1]
        frozen = self._frozen_json(record)[1:-1]
        if frozen:
            result += ',' + frozen
        if operations is not None:
            result += ',"operations":' + operations(record['id'])
        return result + '}'
