"""Lossless gzip records with read-back, per-record and aggregate witnesses."""
import gzip
import hashlib
import json
from pathlib import Path
import sqlite3
import struct
import time


MAX_RAW_RECORD = 512 * 1024 * 1024


def file_sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1048576), b''):
            h.update(block)
    return h.hexdigest()


def raw(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


class Archive:
    def __init__(self, root, cap, segment_records=128):
        self.root = Path(root)
        self.cap = cap
        self.segment_records = segment_records
        self.index = []
        self.records = 0
        self.stream = None
        self.chain = hashlib.sha256()
        self.closed = False

    def append(self, value):
        if self.closed:
            raise RuntimeError('ARCHIVE_CLOSED')
        if self.stream is None:
            self.path = self.root / f'raw-{len(self.index):06d}.jsonl.gz'
            self.file = self.path.open('xb')
            self.stream = gzip.GzipFile(filename='', mode='wb', fileobj=self.file, compresslevel=6, mtime=0)
            self.segment_count = 0
            self.segment_raw_bytes = 0
            self.segment_write_wall = 0.0
            self.segment_write_cpu = 0.0
            self.segment_chain = hashlib.sha256()
        payload = raw({'counter': self.records, 'payload': value})
        line = raw({'sha256': hashlib.sha256(payload).hexdigest(), 'record': json.loads(payload)}) + b'\n'
        started_wall, started_cpu = time.monotonic(), time.process_time()
        if len(line) > MAX_RAW_RECORD:
            raise RuntimeError('RAW_RECORD_CAP_NO_TRUNCATION')
        self.stream.write(line)
        self.segment_write_wall += time.monotonic() - started_wall
        self.segment_write_cpu += time.process_time() - started_cpu
        self.segment_raw_bytes += len(line)
        self.chain.update(line)
        self.segment_chain.update(line)
        counter = self.records
        self.records += 1
        self.segment_count += 1
        if self.segment_count >= self.segment_records:
            self.seal()
        return {'counter': counter, 'payloadSha256': hashlib.sha256(payload).hexdigest()}

    def seal(self):
        if self.stream is None:
            return
        seal_start_wall, seal_start_cpu = time.monotonic(), time.process_time()
        self.stream.close()
        self.file.close()
        meta = {'file': self.path.name, 'firstCounter': self.records - self.segment_count,
                'records': self.segment_count, 'rawSha256': self.segment_chain.hexdigest(),
                'fileSha256': file_sha(self.path),
                'compressedBytes': self.path.stat().st_size, 'rawBytes': self.segment_raw_bytes,
                'compressionWriteWallSeconds': self.segment_write_wall,
                'compressionWriteProcessCpuSeconds': self.segment_write_cpu,
                'sealWallSeconds': time.monotonic() - seal_start_wall,
                'sealProcessCpuSeconds': time.process_time() - seal_start_cpu,
                'cpuAttribution': 'PROCESS_REAL_TIME_INCLUDES_CONCURRENT_THREADS'}
        # Verify retained bytes, not the writer's in-memory source.
        readback_started = time.monotonic()
        verify_segment(self.path, meta, max_uncompressed=self.cap)
        meta['retainedReadbackWallSeconds'] = time.monotonic() - readback_started
        self.index.append(meta)
        self.stream = None
        if sum(item['compressedBytes'] for item in self.index) > self.cap:
            raise RuntimeError('ARCHIVE_OUTPUT_CAP')

    def close(self):
        self.seal()
        self.closed = True
        index = {'schema': 'c21-lossless-archive/v2', 'codec': 'gzip-6-mtime0',
                 'records': self.records, 'rawSha256': self.chain.hexdigest(), 'segments': self.index}
        (self.root / 'archive-index.json').write_bytes(raw(index) + b'\n')
        verify_archive(self.root, self.cap)


def verify_segment(path, meta, max_uncompressed):
    if path.stat().st_size > max_uncompressed or file_sha(path) != meta['fileSha256']:
        raise RuntimeError('RETAINED_FILE_HASH')
    h = hashlib.sha256()
    count = 0
    total = 0
    with gzip.open(path, 'rb') as stream:
        while line := stream.readline(min(MAX_RAW_RECORD, max_uncompressed) + 1):
            total += len(line)
            if len(line) > MAX_RAW_RECORD or total > max_uncompressed or not line.endswith(b'\n'):
                raise RuntimeError('RETAINED_PAYLOAD_CAP')
            value = json.loads(line)
            if value['record']['counter'] != meta['firstCounter'] + count:
                raise RuntimeError('RETAINED_COUNTER_GAP')
            if hashlib.sha256(raw(value['record'])).hexdigest() != value['sha256']:
                raise RuntimeError('RETAINED_PAYLOAD_INTEGRITY')
            h.update(line)
            count += 1
    if count != meta['records'] or h.hexdigest() != meta['rawSha256']:
        raise RuntimeError('RETAINED_ROW_COUNT_OR_HASH')
    return count


def verify_archive(root, cap):
    root = Path(root).resolve(strict=True)
    index = json.loads((root / 'archive-index.json').read_bytes())
    count = 0
    chain = hashlib.sha256()
    for meta in index['segments']:
        path = root / meta['file']
        if path.parent != root or path.is_symlink():
            raise RuntimeError('ARCHIVE_PATH_ESCAPE')
        if meta['firstCounter'] != count:
            raise RuntimeError('ARCHIVE_SEGMENT_GAP')
        count += verify_segment(path, meta, cap)
        with gzip.open(path, 'rb') as stream:
            while line := stream.readline(MAX_RAW_RECORD + 1):
                if len(line) > MAX_RAW_RECORD:
                    raise RuntimeError('ARCHIVE_READBACK_RECORD_CAP')
                chain.update(line)
    actual = {p.name for p in root.glob('raw-*.jsonl.gz')}
    if actual != {m['file'] for m in index['segments']} or count != index['records'] or chain.hexdigest() != index['rawSha256']:
        raise RuntimeError('ARCHIVE_INCOMPLETE')
    return {'recordsReadFromRetainedFiles': count, 'rawSha256': chain.hexdigest()}


def sql_scalar(value):
    if value is None:
        return ['null']
    if type(value) is int:
        return ['integer', str(value)]
    if type(value) is float:
        return ['real', struct.pack('>d', value).hex()]
    if isinstance(value, bytes):
        return ['blob', value.hex()]
    return ['text', value]


def retain_cut(path, emit, label, byte_cap, deadline):
    """All retained SQLite rows and column types, in one independent RO transaction."""
    db = sqlite3.connect(Path(path).as_uri() + '?mode=ro', uri=True, timeout=1)
    db.execute('PRAGMA query_only=ON')
    db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 10000)
    result = {'label': label, 'tables': [], 'encodedBytes': 0, 'rows': 0}
    try:
        db.execute('BEGIN')
        schema = db.execute('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').fetchall()
        result['schema'] = schema
        for (name,) in db.execute("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name"):
            q = '"' + name.replace('"', '""') + '"'
            columns = list(db.execute(f'PRAGMA table_xinfo({q})'))
            hashes = []
            emit('sqlite-table-start', cut=label, table=name, columns=columns)
            names = ','.join('"' + c[1].replace('"', '""') + '"' for c in columns)
            for ordinal, row in enumerate(db.execute(f'SELECT {names} FROM {q}')):
                typed = [sql_scalar(v) for v in row]
                payload = raw(typed)
                result['encodedBytes'] += len(payload)
                result['rows'] += 1
                if result['encodedBytes'] > byte_cap or time.monotonic() >= deadline:
                    raise RuntimeError('FULL_RAW_CUT_BUDGET')
                ref = emit('sqlite-retained-row', cut=label, table=name, ordinal=ordinal, values=typed)
                hashes.append(hashlib.sha256(payload).hexdigest())
                if not ref:
                    raise RuntimeError('RAW_ROW_NOT_RETAINED')
            result['tables'].append({'name': name, 'columns': columns, 'rows': len(hashes),
                                     'sortedRowsSha256': hashlib.sha256(raw(sorted(hashes))).hexdigest()})
        snapshot = db.execute('SELECT body,digest FROM snapshots WHERE slot=0').fetchone()
        if not snapshot or hashlib.sha256(snapshot[0].encode()).hexdigest() != snapshot[1]:
            raise RuntimeError('SNAPSHOT_CHECKSUM')
        body = json.loads(snapshot[0])
        result['tick'] = body.get('world', body)['tick']
        result['snapshotDigest'] = snapshot[1]
        result['instanceId'] = db.execute("SELECT value FROM metadata WHERE key='world-instance-id'").fetchone()[0]
        result['logicalSha256'] = hashlib.sha256(raw({'schema': schema, 'tables': result['tables']})).hexdigest()
        result['coverage'] = 'ALL_TABLES_ALL_RETAINED_ROWS_ALL_COLUMNS_ONE_ACTUAL_READ_TRANSACTION'
        emit('sqlite-cut-complete', **result)
        return result
    finally:
        db.rollback()
        db.close()
