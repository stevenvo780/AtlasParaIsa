#!/usr/bin/env python3
"""Native-only capsule; authoring may parse this file but must not invoke it.

Runs real App/HTTP. Every safety failure aborts; C21/global acceptance stays UNKNOWN.
No shell, network installation, public credentials or external service management.
"""
import argparse
from collections import OrderedDict
import concurrent.futures
import datetime as dt
import hashlib
import http.client
import json
import os
from pathlib import Path
import queue
import re
import secrets
import shutil
import signal
import sqlite3
import struct
import subprocess
import threading
import time

HERE = Path(__file__).resolve().parents[3]
OWN = HERE / '.orchestration/c21-app-v1'
MAX_RESPONSE = 8 * 1024 * 1024


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def canon(v):
    return json.dumps(v, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


def hashed(v):
    return hashlib.sha256(canon(v).encode()).hexdigest()


def write(path, value):
    with Path(path).open('x', encoding='utf8') as f:
        f.write(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def utc():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def now_iso(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def tree(root):
    root = Path(root).resolve(strict=True)
    result = {}
    for p in sorted(root.rglob('*')):
        if p.is_symlink() and not p.resolve().is_relative_to(root):
            raise RuntimeError('EXTERNAL_DEPENDENCY_SYMLINK')
        if p.is_file():
            result[str(p.relative_to(root))] = digest(p)
    return result


def physical(root):
    return {p.name: {'bytes': p.stat().st_size, 'sha256': digest(p)}
            for p in sorted(root.glob('world.sqlite*')) if p.is_file()}


def sql_value(v):
    # Independent oracle, exact types, float bits and blobs; no Store imports.
    if v is None:
        return ['null']
    if isinstance(v, int):
        return ['integer', str(v)]
    if isinstance(v, float):
        return ['real', struct.pack('>d', v).hex()]
    if isinstance(v, bytes):
        return ['blob', v.hex()]
    return ['text', v]


def cut(path, cap, deadline):
    db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=1)
    db.execute('PRAGMA query_only=ON')
    db.set_progress_handler(lambda: int(time.monotonic() >= deadline), 10000)
    encoded = 0
    count = 0
    try:
        db.execute('BEGIN')
        schema = db.execute('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').fetchall()
        tables = []
        for (name,) in db.execute("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name"):
            q = '"' + name.replace('"', '""') + '"'
            columns = [r[1] for r in db.execute(f'PRAGMA table_xinfo({q})')]
            rows = []
            names = ','.join('"' + c.replace('"', '""') + '"' for c in columns)
            for row in db.execute(f'SELECT {names} FROM {q}'):
                text = canon([sql_value(v) for v in row])
                encoded += len(text.encode())
                count += 1
                if encoded > cap or count > 2000000 or time.monotonic() >= deadline:
                    raise RuntimeError('ORACLE_BUDGET')
                rows.append(text)
            tables.append({'name': name, 'columns': columns, 'rows': len(rows),
                           'sha256': hashed(sorted(rows))})
        raw = db.execute('SELECT body,digest,saved_at FROM snapshots WHERE slot=0').fetchone()
        if not raw or hashlib.sha256(raw[0].encode()).hexdigest() != raw[1]:
            raise RuntimeError('SNAPSHOT_CHECKSUM')
        body = json.loads(raw[0])
        # Tick metadata is observable; the codec/full logical digest is separate.
        tick = (body.get('world', {}) if 'snapshotEncoding' in body else body).get('tick')
        instance = db.execute("SELECT value FROM metadata WHERE key='world-instance-id'").fetchone()
        result = {'schemaHash': hashed(schema), 'tables': tables,
                  'applicationId': db.execute('PRAGMA application_id').fetchone()[0],
                  'userVersion': db.execute('PRAGMA user_version').fetchone()[0]}
        result['sha256'] = hashed(result)
        result.update(tick=tick, instanceId=instance[0] if instance else None,
                      snapshotBodyHash=raw[1], savedAt=raw[2], encodedBytes=encoded,
                      coverage='ALL_TABLES_ALL_COLUMNS_ONE_READ_TRANSACTION',
                      semanticLedger='UNKNOWN', powerLoss='UNKNOWN')
        return result
    finally:
        db.rollback()
        db.close()


class Capsule:
    def __init__(self, manifest, admission, manifest_hash, mode, duration):
        self.m = manifest
        self.a = admission
        self.mode = mode
        self.duration = duration
        self.children = []
        self.failed = threading.Event()
        self.finished = threading.Event()
        self.reason = None
        self.events_lock = threading.Lock()
        self.ack_lock = threading.Lock()
        self.acks = {}
        self.inflight = {}
        self.errors = []
        self.requests = [0] * 12
        self.observations = [0] * 12
        self.common_cuts = OrderedDict()
        self.common_comparisons = 0
        self.exposure = []
        self.out = OWN / 'runs' / admission['runId']
        self.deadline = time.monotonic() + manifest['limits']['absoluteSeconds'][mode]
        self.cgroup_text = Path('/proc/self/cgroup').read_text().strip()
        if not OWN.resolve().is_relative_to(HERE) or OWN.is_symlink():
            raise RuntimeError('OWNERSHIP_PATH_ESCAPE')
        if admission['schema'] != 'c21-app-native-admission/v1' or admission['manifestSha256'] != manifest_hash:
            raise RuntimeError('ADMISSION_MANIFEST')
        if admission.get('authorizedBy') != 'root' or admission.get('mode') != mode or admission.get('durationSeconds') != duration:
            raise RuntimeError('ADMISSION_SCOPE')
        if not re.fullmatch(r'c21-app-[A-Za-z0-9_-]{1,48}', admission['runId']):
            raise RuntimeError('RUN_ID')
        if not 0 <= time.time() - now_iso(admission['issuedAt']) <= 900 or now_iso(admission['expiresAt']) <= time.time():
            raise RuntimeError('ADMISSION_STALE')
        if admission.get('preflightFresh') is not True or admission.get('reservationsReconciled') is not True or admission.get('hostMonitorActive') is not True:
            raise RuntimeError('NATIVE_PREFLIGHT_REQUIRED')
        unified = [v[3:] for v in self.cgroup_text.splitlines() if v.startswith('0::')]
        if len(unified) != 1 or unified[0] != admission['cgroupPath'] or unified[0] == '/':
            raise RuntimeError('CGROUP_IDENTITY')
        cg = Path('/sys/fs/cgroup' + unified[0])
        quota, period = (cg / 'cpu.max').read_text().split()
        memory = (cg / 'memory.max').read_text().strip()
        if quota == 'max' or int(quota) / int(period) > manifest['limits']['cpuCount'] or memory == 'max' or int(memory) > manifest['limits']['memoryBytes']:
            raise RuntimeError('CGROUP_CAPS')
        self.cg = cg
        if self.out.exists() or (OWN / 'runs').is_symlink():
            raise RuntimeError('OUTPUT_MUST_BE_NEW')
        self.out.mkdir(parents=True, mode=0o700)
        for name in ('stage', 'data', 'tmp', 'cache', 'logs', 'evidence', 'home'):
            (self.out / name).mkdir(mode=0o700)
        self.event_file = (self.out / 'evidence/events.ndjson').open('x', encoding='utf8')
        self.env = {key: value.replace('{output}', str(self.out))
                    for key, value in manifest['childEnvTemplate'].items()}
        if any('{' in v or '}' in v for v in self.env.values()):
            raise RuntimeError('UNRESOLVED_ENV')
        write(self.out / 'admission.json', admission)
        write(self.out / 'run-manifest.json', {'manifestSha256': manifest_hash, 'mode': mode,
              'durationSeconds': duration, 'environment': self.env, 'startedAt': utc(),
              'deadlineMonotonic': self.deadline, 'limits': manifest['limits'],
              'scope': 'APP_HTTP_PROCESS_CRASH_ONLY', 'scientificAcceptance': False})
        self.monitor = threading.Thread(target=self.watch, daemon=True)
        self.monitor.start()

    def event(self, kind, **payload):
        with self.events_lock:
            self.event_file.write(canon({'kind': kind, 'utc': utc(), 'monotonic': time.monotonic(), **payload}) + '\n')
            self.event_file.flush()

    def check(self):
        if self.failed.is_set() or time.monotonic() >= self.deadline:
            raise RuntimeError(self.reason or 'ABSOLUTE_TIMEOUT')

    def watch(self):
        try:
            while not self.finished.wait(0.5):
                size = 0
                logs = 0
                for p in self.out.rglob('*'):
                    if p.is_symlink():
                        raise RuntimeError('OUTPUT_SYMLINK')
                    if p.is_file():
                        n = p.stat().st_size
                        size += n
                        if p.is_relative_to(self.out / 'logs'):
                            logs += n
                if size > self.m['limits']['outputBytes'] or logs > self.m['limits']['logBytes']:
                    raise RuntimeError('OUTPUT_LOG_CAP')
                if int((self.cg / 'memory.current').read_text()) > self.m['limits']['memoryBytes']:
                    raise RuntimeError('MEMORY_CAP')
                if time.monotonic() >= self.deadline:
                    raise RuntimeError('ABSOLUTE_TIMEOUT')
                self.event('resource', outputBytes=size, logBytes=logs,
                           memoryBytes=int((self.cg / 'memory.current').read_text()),
                           cpuStat=(self.cg / 'cpu.stat').read_text())
        except Exception as e:
            self.reason = str(e)
            self.failed.set()
            for child in list(self.children):
                try:
                    self.send(child, signal.SIGKILL)
                except Exception:
                    pass

    def pincheck(self):
        for rel, expected in self.m['sourcePins'].items():
            if digest(HERE / rel) != expected:
                raise RuntimeError('SOURCE_PIN_CHANGED:' + rel)
        for path, expected in self.m['authorityPins'].items():
            if digest(path) != expected:
                raise RuntimeError('AUTHORITY_PIN_CHANGED')
        for path, expected in self.m['runtimePins'].items():
            if digest(path) != expected:
                raise RuntimeError('RUNTIME_PIN_CHANGED')
        if tree(HERE / 'node_modules') != self.m['dependencyPins']:
            raise RuntimeError('DEPENDENCY_TREE_CHANGED')

    def resolve_argv(self, template):
        bindings = {'{node}': self.m['executables']['node'], '{stage}': str(self.out / 'stage')}
        result = []
        for arg in template:
            for token, value in bindings.items():
                arg = arg.replace(token, value)
            if '{' in arg or '}' in arg:
                raise RuntimeError('UNRESOLVED_ARGV')
            result.append(arg)
        return result

    def stagecheck(self):
        for rel in self.m['stageFiles']:
            if digest(self.out / 'stage' / rel) != self.m['sourcePins'][rel]:
                raise RuntimeError('STAGED_SOURCE_CHANGED')
        if tree(self.out / 'stage/node_modules') != self.m['dependencyPins']:
            raise RuntimeError('STAGED_DEPS_CHANGED')
        if tree(self.out / 'stage/dist') != json.loads((self.out / 'compiled-pins.json').read_text()):
            raise RuntimeError('COMPILED_APP_CHANGED')

    def identity(self, pid):
        stat = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return {'pid': pid, 'starttime': stat[19], 'session': int(stat[3]),
                'cgroup': Path(f'/proc/{pid}/cgroup').read_text().strip()}

    def send(self, child, sig):
        if child['p'].poll() is not None:
            return False
        current = self.identity(child['p'].pid)
        if current != child['identity'] or current['session'] != child['p'].pid or current['cgroup'] != self.cgroup_text:
            raise RuntimeError('CHILD_OWNERSHIP_LOST')
        os.killpg(child['p'].pid, sig)
        self.event('signal', identity=current, signal=signal.Signals(sig).name)
        return True

    def spawn(self, argv, label):
        self.check()
        err = (self.out / f'logs/{label}.stderr').open('xb')
        # Only explicitly constructed environment, never inherited tokens/proxies.
        p = subprocess.Popen(argv, cwd=self.out / 'stage', env=self.env,
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=err, start_new_session=True)
        child = {'p': p, 'identity': self.identity(p.pid), 'err': err, 'label': label}
        self.children.append(child)
        self.event('spawn', argv=argv, cwd=str(self.out / 'stage'), identity=child['identity'])
        return child

    def build(self):
        self.pincheck()
        for rel in self.m['stageFiles']:
            dest = self.out / 'stage' / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(HERE / rel, dest)
        shutil.copytree(HERE / 'node_modules', self.out / 'stage/node_modules', symlinks=False)
        if tree(self.out / 'stage/node_modules') != self.m['dependencyPins']:
            raise RuntimeError('STAGED_DEPS_CHANGED')
        for rel in self.m['stageFiles']:
            if digest(self.out / 'stage' / rel) != self.m['sourcePins'][rel]:
                raise RuntimeError('STAGED_SOURCE_CHANGED')
        for i, template in enumerate(self.m['prepareArgv']):
            child = self.spawn(self.resolve_argv(template), f'build-{i}')
            log = self.out / f'logs/build-{i}.stdout'
            def drain(c=child, path=log):
                with path.open('xb') as f:
                    for block in iter(lambda: c['p'].stdout.read(65536), b''):
                        f.write(block)
            reader = threading.Thread(target=drain, daemon=True)
            reader.start()
            until = min(self.deadline, time.monotonic() + self.m['limits']['buildStepSeconds'])
            while child['p'].poll() is None:
                self.check()
                if time.monotonic() >= until:
                    self.send(child, signal.SIGKILL)
                    raise RuntimeError('BUILD_TIMEOUT')
                time.sleep(0.1)
            reader.join(timeout=2)
            child['err'].close()
            if child['p'].returncode != 0 or reader.is_alive():
                raise RuntimeError('PREPARE_FAILED')
        self.pincheck()
        write(self.out / 'compiled-pins.json', tree(self.out / 'stage/dist'))
        # Generate a private fixture, never read access.scrypt/password from outside.
        self.password = secrets.token_urlsafe(32)
        salt = secrets.token_hex(16)
        key = hashlib.scrypt(self.password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64)
        (self.out / 'data/access.scrypt').write_text(f'scrypt:{salt}:{key.hex()}\n')

    def start_app(self, epoch):
        self.pincheck()
        self.stagecheck()
        child = self.spawn(self.resolve_argv(self.m['runtimeArgv']), f'app-{epoch}')
        ready_q = queue.Queue()
        def drain():
            with (self.out / f'logs/app-{epoch}.stdout').open('xb') as f:
                for line in iter(child['p'].stdout.readline, b''):
                    if len(line) > 65536:
                        self.reason = 'CHILD_LINE_CAP'
                        self.failed.set()
                        break
                    f.write(line)
                    f.flush()
                    try:
                        v = json.loads(line)
                        if v.get('kind') == 'ready':
                            ready_q.put(v)
                    except (ValueError, AttributeError):
                        pass
        threading.Thread(target=drain, daemon=True).start()
        until = min(self.deadline, time.monotonic() + self.m['limits']['startupSeconds'])
        while time.monotonic() < until:
            self.check()
            if child['p'].poll() is not None:
                raise RuntimeError('APP_START_FAILED')
            try:
                ready = ready_q.get(timeout=0.2)
                break
            except queue.Empty:
                continue
        else:
            raise RuntimeError('APP_START_TIMEOUT')
        if ready.get('pid') != child['p'].pid or not isinstance(ready.get('port'), int) or not 1 <= ready['port'] <= 65535 or ready.get('origin') != f"http://127.0.0.1:{ready['port']}" or ready.get('cgroup') != self.cgroup_text:
            raise RuntimeError('READY_IDENTITY')
        self.port = ready['port']
        self.origin = ready['origin']
        self.event('app-ready', epoch=epoch, ready=ready)
        return child, ready

    def request(self, method, path, payload=None, cookie=None, slow=False, unread=False):
        self.check()
        if not path.startswith('/api/') or '://' in path:
            raise RuntimeError('LOCAL_PATH_ONLY')
        conn = http.client.HTTPConnection('127.0.0.1', self.port,
                                          timeout=min(10, max(0.1, self.deadline - time.monotonic())))
        headers = {'Origin': self.origin, 'Content-Type': 'application/json', 'Connection': 'close'}
        if cookie:
            headers['Cookie'] = cookie
        try:
            conn.request(method, path, body=canon(payload).encode() if payload is not None else None, headers=headers)
            if method == 'POST' and path == '/api/gesture':
                self.event('http-request-sent', requestId=payload['id'], responseWillBeRead=not unread)
            if unread:
                # Send real HTTP and deliberately do not receive/interpret an ACK.
                time.sleep(0.5)
                return None, None, None
            r = conn.getresponse()
            raw = bytearray()
            while True:
                part = r.read(4096 if slow else 65536)
                if not part:
                    break
                raw.extend(part)
                if len(raw) > MAX_RESPONSE:
                    raise RuntimeError('HTTP_RESPONSE_CAP')
                if slow:
                    self.check()
                    time.sleep(0.005)
            return r.status, bytes(raw), r.getheader('Set-Cookie')
        finally:
            conn.close()

    def login(self):
        status, raw, cookie = self.request('POST', '/api/login', {'password': self.password})
        if status != 200 or json.loads(raw) != {'ok': True} or not cookie or not re.match(r'^carta_session=[A-Za-z0-9_-]{43};', cookie):
            raise RuntimeError('SYNTHETIC_LOGIN_FAILED')
        # One real session shared by twelve independent logical clients avoids
        # violating the real 6 logins/60s loopback limit. Tokens never enter logs.
        self.cookie = cookie.split(';', 1)[0]
        self.event('authentication', logicalClients=12, sessions=1, credential='GENERATED_PRIVATE')

    def receipt(self, client, seq, gesture, status, raw, retry=False):
        value = json.loads(raw) if raw else None
        if status != 200 or not isinstance(value, dict) or value.get('id') != gesture['id'] or type(value.get('accepted')) is not bool or type(value.get('tick')) is not int or type(value.get('order')) is not int or not isinstance(value.get('message'), str):
            raise RuntimeError('NO_VALID_GESTURE_RESULT')
        self.event('http-result', client=client, sequence=seq, requestId=gesture['id'],
                   gesture=gesture, status=status, body=raw.decode(), responseHash=hashlib.sha256(raw).hexdigest(),
                   retry=retry, acknowledgement='HTTP_RESPONSE_RECEIVED_NOT_FSYNC')
        # Result and fingerprint from inputs, in one read transaction independent
        # of Store and of the App in-memory view. HTTP 200 alone never counts.
        db = sqlite3.connect((self.out / 'data/world.sqlite').as_uri() + '?mode=ro', uri=True, timeout=1)
        try:
            db.execute('PRAGMA query_only=ON')
            db.execute('BEGIN')
            row = db.execute('SELECT fingerprint,tick,ordinal,body,result FROM inputs WHERE id=?', (gesture['id'],)).fetchone()
            fp = hashlib.sha256(json.dumps([gesture['kind'], gesture['x'], gesture['y'], None,
                                            gesture['agentId'], gesture['order']], separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
            if not row or row[0] != fp or row[1:3] != (value['tick'], value['order']) or json.loads(row[3]) != gesture or json.loads(row[4]) != value:
                raise RuntimeError('CONFIRMED_RESULT_MISSING_OR_CHANGED')
        finally:
            db.rollback()
            db.close()
        with self.ack_lock:
            prior = self.acks.get(gesture['id'])
            if prior and prior['result'] != value:
                raise RuntimeError('RETRY_RESULT_CHANGED')
            self.acks[gesture['id']] = {'gesture': gesture, 'result': value, 'client': client, 'sequence': seq}
            self.inflight.pop(gesture['id'], None)
        self.event('durable-result', requestId=gesture['id'], accepted=value['accepted'],
                   tick=value['tick'], order=value['order'], resultHash=hashed(value))
        if gesture['agentId'] == 'c21-missing-agent' and value['accepted']:
            raise RuntimeError('KNOWN_REJECT_ACCEPTED')

    def observe(self, client, camera, view, people):
        if view['instanceId'] != self.instance_id:
            raise RuntimeError('SHARED_WORLD_DIVERGENCE')
        key = (view['instanceId'], view.get('version'), view['tick'])
        tiles = {(p['x'], p['y']): p for p in view.get('tiles', [])}
        persons = {p['id']: p for p in people}
        with self.ack_lock:
            prior = self.common_cuts.setdefault(key, [])
            for other in prior:
                if other['client'] == client:
                    continue
                overlaps = 0
                for a, b in ((tiles, other['tiles']), (persons, other['people'])):
                    for ident in a.keys() & b.keys():
                        overlaps += 1
                        if a[ident] != b[ident]:
                            self.event('common-tick-difference', tick=view['tick'],
                                       clients=[client, other['client']], entity=str(ident),
                                       observed=a[ident], previous=b[ident])
                            raise RuntimeError('SHARED_WORLD_DIVERGENCE')
                if overlaps:
                    self.common_comparisons += 1
                    self.event('common-tick-comparison', tick=view['tick'],
                               clients=[client, other['client']], cameras=[camera, other['camera']],
                               comparedEntities=overlaps, exact=True)
            prior[:] = [p for p in prior if p['client'] != client]
            prior.append({'client': client, 'camera': camera, 'tiles': tiles, 'people': persons})
            # This bounded observer never treats evicted/missing cuts as equality.
            while len(self.common_cuts) > 128:
                self.common_cuts.popitem(last=False)

    def lane(self, client, end):
        seq = self.requests[client]
        first = True
        self.event('client-window-open', client=client, closingPlanned=end)
        while time.monotonic() < end and not self.failed.is_set():
            if not first:
                time.sleep(min(self.m['clients'][client]['intervalSeconds'],
                               max(0, end - time.monotonic())))
            first = False
            if time.monotonic() >= end:
                break
            seq += 1
            self.requests[client] += 1
            camera = 0 if seq % 2 else client % 2
            path = ['/api/world?x=0&y=0&width=32&height=32',
                    '/api/world?x=16&y=0&width=32&height=32'][camera]
            profile = self.m['clients'][client]['profile']
            try:
                status, raw, _ = self.request('GET', path, cookie=self.cookie,
                                             slow=profile == 'slow', unread=profile == 'nonreader' and seq % 3 == 0)
                if raw is None:
                    self.event('nonreader', client=client, sequence=seq, camera=camera)
                    continue
                view = json.loads(raw)
                if status != 200 or not view.get('instanceId') or type(view.get('tick')) is not int:
                    raise RuntimeError('WORLD_VIEW_INVALID')
                # Keep material projection fields and IDs; omit names/memories.
                stocks = {key: view.get(key) for key in ('tiles', 'structures', 'blueprints', 'animals')}
                people = [{k: p.get(k) for k in ('id', 'x', 'y', 'energy', 'hunger', 'thirst', 'materials', 'controlMode', 'genome')}
                          for p in view.get('people', [])]
                self.event('client-view', client=client, sequence=seq, camera=camera,
                           instanceId=view['instanceId'], tick=view['tick'], version=view.get('version'),
                           projectionHash=hashed(stocks), people=people,
                           tileHashes=[[p['x'], p['y'], hashed(p)] for p in view.get('tiles', [])])
                self.observations[client] += 1
                self.observe(client, camera, view, people)
                neighbors = [p for p in view.get('people', []) if p.get('role') == 'neighbor']
                if not neighbors:
                    self.event('opportunity-missing', client=client, sequence=seq, reason='NO_NEIGHBOR_IN_CAMERA')
                    continue
                person = neighbors[client % len(neighbors)]
                gesture = {'id': f"{self.a['runId']}-c{client:02d}-s{seq:06d}", 'kind': 'command',
                           'x': person['x'], 'y': person['y'],
                           'agentId': 'c21-missing-agent' if seq % 5 == 0 else person['id'], 'order': 'auto'}
                with self.ack_lock:
                    self.inflight[gesture['id']] = {'gesture': gesture, 'client': client, 'sequence': seq}
                self.event('request-intent', client=client, sequence=seq, gesture=gesture)
                status, raw, _ = self.request('POST', '/api/gesture', gesture, self.cookie,
                                             unread=profile == 'nonreader' and seq % 7 == 0)
                if raw is not None:
                    self.receipt(client, seq, gesture, status, raw)
                else:
                    self.event('unreceived-result', client=client, sequence=seq, requestId=gesture['id'],
                               acknowledgement='NOT_OBSERVED', commitPhase='UNKNOWN')
            except Exception as e:
                self.errors.append({'client': client, 'sequence': seq, 'reason': str(e)})
                self.event('client-error', client=client, sequence=seq, reason=str(e))
                self.reason = str(e)
                self.failed.set()
                return
        self.event('client-window-close', client=client, completedSequences=seq)

    def stop(self, child, sig):
        self.send(child, sig)
        try:
            child['p'].wait(timeout=min(15, max(0.1, self.deadline - time.monotonic())))
        except subprocess.TimeoutExpired:
            self.send(child, signal.SIGKILL)
            child['p'].wait(timeout=5)
            raise RuntimeError('GRACEFUL_TIMEOUT')
        child['err'].close()
        self.event('child-exit', label=child['label'], returncode=child['p'].returncode,
                   pidAbsent=not Path(f"/proc/{child['p'].pid}").exists())

    def capture(self, label):
        result = cut(self.out / 'data/world.sqlite', self.m['limits']['oracleEncodedBytes'],
                     min(self.deadline, time.monotonic() + 15))
        write(self.out / f'evidence/{label}.json', {'logical': result, 'physical': physical(self.out / 'data')})
        return result

    def verify_all(self):
        db = sqlite3.connect((self.out / 'data/world.sqlite').as_uri() + '?mode=ro', uri=True, timeout=1)
        try:
            db.execute('BEGIN')
            for ident, receipt in self.acks.items():
                row = db.execute('SELECT body,result FROM inputs WHERE id=?', (ident,)).fetchone()
                if not row or json.loads(row[0]) != receipt['gesture'] or json.loads(row[1]) != receipt['result']:
                    raise RuntimeError('ACK_LOST_AFTER_RECOVERY')
        finally:
            db.rollback()
            db.close()

    def restart(self, child, epoch, forced):
        if forced:
            # Externally observed after HTTP receipt, NOT a Store transaction phase.
            # STOP prevents further commits while comparing two independent cuts.
            self.send(child, signal.SIGSTOP)
            until = min(self.deadline, time.monotonic() + 5)
            while time.monotonic() < until:
                state = Path(f"/proc/{child['p'].pid}/stat").read_text().rsplit(')', 1)[1].split()[0]
                if state in ('T', 't'):
                    break
                time.sleep(0.02)
            else:
                raise RuntimeError('STOP_UNOBSERVED')
            before = self.capture(f'epoch-{epoch}-stopped')
            self.verify_all()
            self.stop(child, signal.SIGKILL)
            if child['p'].returncode != -signal.SIGKILL:
                raise RuntimeError('FORCED_EXIT_NOT_SIGKILL')
            closed = self.capture(f'epoch-{epoch}-closed')
            if before['sha256'] != closed['sha256']:
                raise RuntimeError('FULL_DURABLE_CUT_CHANGED_AFTER_KILL')
        else:
            self.stop(child, signal.SIGTERM)
            if child['p'].returncode != 0:
                raise RuntimeError('GRACEFUL_EXIT_FAILED')
            closed = self.capture(f'epoch-{epoch}-closed')
        self.verify_all()
        unacked = {}
        db = sqlite3.connect((self.out / 'data/world.sqlite').as_uri() + '?mode=ro', uri=True, timeout=1)
        try:
            db.execute('BEGIN')
            for ident, request in self.inflight.items():
                row = db.execute('SELECT body,result FROM inputs WHERE id=?', (ident,)).fetchone()
                if row:
                    if json.loads(row[0]) != request['gesture']:
                        raise RuntimeError('UNACKED_BODY_CHANGED')
                    unacked[ident] = json.loads(row[1])
                self.event('closed-unacked-observation', requestId=ident, resultPresent=row is not None,
                           resultHash=hashed(json.loads(row[1])) if row else None, acknowledgement='NOT_OBSERVED')
        finally:
            db.rollback()
            db.close()
        restarted, ready = self.start_app(epoch + 1)
        if ready['loadedSlot'] != 0 or ready['loadedTick'] != closed['tick'] or ready['instanceId'] != closed['instanceId']:
            raise RuntimeError('RECOVERY_RESET_OR_REWIND')
        self.login()
        self.common_cuts.clear()
        # Retry ALL actually received results and uncertain submissions with SAME IDs.
        with self.ack_lock:
            pending = {**self.acks, **self.inflight}
        for r in pending.values():
            self.check()
            status, raw, _ = self.request('POST', '/api/gesture', r['gesture'], self.cookie)
            if r['gesture']['id'] in unacked and json.loads(raw) != unacked[r['gesture']['id']]:
                raise RuntimeError('UNACKED_RETRY_RESULT_CHANGED')
            self.receipt(r['client'], r['sequence'], r['gesture'], status, raw, retry=True)
        self.verify_all()
        self.event('restart-observed', epoch=epoch, forced=forced, loadedTick=ready['loadedTick'],
                   closedCutHash=closed['sha256'], retryCount=len(pending),
                   frontier='AFTER_HTTP_AND_READONLY_CUT' if forced else 'GRACEFUL_STABLE',
                   materialLedger='UNKNOWN', historySemantics='UNKNOWN')
        return restarted

    def campaign(self):
        self.build()
        app, ready = self.start_app(0)
        if ready['loadedTick'] is not None or ready['tick'] != 0:
            raise RuntimeError('FIXTURE_NOT_FRESH')
        self.login()
        self.instance_id = ready['instanceId']
        started = time.monotonic()
        # Runtime client windows are (opening, closing]; source protocol unchanged.
        # Three windows total 3600s in campaign, 60s in diagnostic; pauses/recovery
        # are measured separately and never counted as twelve-client exposure.
        for epoch in range(3):
            opening = time.monotonic()
            end = opening + self.duration / 3
            self.event('window-open', epoch=epoch, clients=12, endMonotonic=end)
            with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
                futures = [pool.submit(self.lane, client, end) for client in range(12)]
                for f in futures:
                    f.result()
            self.check()
            self.exposure.append({'epoch': epoch, 'openingMonotonic': opening,
                                  'closingMonotonic': time.monotonic(),
                                  'plannedClosingMonotonic': end,
                                  'plannedClients': 12})
            self.event('window-close', epoch=epoch, clients=12)
            if epoch < 2:
                app = self.restart(app, epoch, forced=epoch == 0)
        self.stop(app, signal.SIGTERM)
        self.capture('final-closed')
        self.verify_all()
        if not self.acks or not any(r['result']['accepted'] for r in self.acks.values()):
            raise RuntimeError('ACCEPTED_ORDER_OPPORTUNITY_MISSING')
        if not any(not r['result']['accepted'] for r in self.acks.values()):
            raise RuntimeError('REJECTED_ORDER_OPPORTUNITY_MISSING')
        self.pincheck()
        self.stagecheck()
        return {'runtimeElapsedSeconds': time.monotonic() - started, 'plannedClientWindowSeconds': self.duration,
                'requestsByClient': self.requests, 'observationsByClient': self.observations,
                'receivedResults': len(self.acks), 'acceptedResults': sum(r['result']['accepted'] for r in self.acks.values()),
                'rejectedResults': sum(not r['result']['accepted'] for r in self.acks.values()),
                'uncertainRequests': len(self.inflight), 'errors': self.errors,
                'clientWindows': self.exposure, 'observedCommonTickComparisons': self.common_comparisons,
                'unobservedCuts': 'UNKNOWN_NOT_ZERO', 'sessions': 1,
                'fixtureMaterialLedger': 'UNKNOWN'}

    def close(self):
        cleanup = []
        for child in self.children:
            try:
                if child['p'].poll() is None:
                    self.send(child, signal.SIGKILL)
                    child['p'].wait(timeout=5)
                cleanup.append({'pid': child['p'].pid, 'returncode': child['p'].returncode,
                                'pidAbsent': not Path(f"/proc/{child['p'].pid}").exists()})
                child['err'].close()
            except Exception as e:
                cleanup.append({'pid': child['p'].pid, 'error': str(e)})
        self.finished.set()
        self.monitor.join(timeout=2)
        self.event('cleanup', children=cleanup, externalUnitTeardown='NATIVE_EXECUTOR_REQUIRED')
        self.event_file.close()
        return cleanup


def main():
    os.umask(0o077)
    p = argparse.ArgumentParser()
    p.add_argument('--manifest', type=Path, required=True)
    p.add_argument('--admission', type=Path, required=True)
    p.add_argument('--mode', choices=['diagnostic', 'campaign'], required=True)
    p.add_argument('--duration', type=int, required=True)
    args = p.parse_args()
    if args.manifest.resolve() != OWN / 'MANIFEST.json':
        raise RuntimeError('CANONICAL_MANIFEST_REQUIRED')
    if not ((args.mode == 'campaign' and args.duration == 3600) or
            (args.mode == 'diagnostic' and 15 <= args.duration <= 300)):
        raise RuntimeError('DURATION_SCOPE')
    m = json.loads(args.manifest.read_text())
    admission = json.loads(args.admission.read_text())
    capsule = Capsule(m, admission, digest(args.manifest), args.mode, args.duration)
    result = {'schema': 'c21-app-result/v1', 'mode': args.mode, 'c21': 'UNKNOWN',
              'scientificAcceptance': False, 'globalCampaignAcceptance': False,
              'status': 'UNKNOWN', 'scope': 'APP_HTTP_PROCESS_CRASH_NOT_POWER_LOSS'}
    try:
        result['observed'] = capsule.campaign()
        result['status'] = 'PARTIAL' if args.mode == 'diagnostic' else 'TECHNICAL_OBSERVATIONS_ONLY'
    except Exception as e:
        result['reason'] = str(e)
        result['status'] = 'FAIL' if any(s in str(e) for s in
            ('CONFIRMED_RESULT', 'ACK_LOST', 'RETRY_RESULT_CHANGED', 'FULL_DURABLE_CUT_CHANGED',
             'RECOVERY_RESET', 'KNOWN_REJECT_ACCEPTED', 'SHARED_WORLD_DIVERGENCE')) else 'UNKNOWN'
    finally:
        result['cleanup'] = capsule.close()
        result['completedAt'] = utc()
        result['missingCoverage'] = m['missingCoverage']
        result['plannedCases'] = json.loads((HERE / 'scripts/lab/c21-app-v1/case-plan.json').read_text())['cases']
        write(capsule.out / 'result.json', result)
    raise SystemExit(0 if result['status'] in ('PARTIAL', 'TECHNICAL_OBSERVATIONS_ONLY') else 2)


if __name__ == '__main__':
    main()
