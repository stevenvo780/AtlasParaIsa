#!/usr/bin/python3.14
"""Native-only capsule; authoring may parse this file but must not invoke it.

Runs real App/HTTP. Every safety failure aborts; C21/global acceptance stays UNKNOWN.
No shell, network installation, public credentials or external service management.
"""
from pins import closure
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
OWN = HERE / '.orchestration/c21-app-v2'
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
        if admission['schema'] != 'c21-app-native-admission/v2' or admission['manifestSha256'] != manifest_hash:
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
        from evidence import Archive
        self.archive = Archive(self.out / 'evidence', manifest['limits']['outputBytes'])
        self.env = {key: value.replace('{output}', str(self.out))
                    for key, value in manifest['childEnvTemplate'].items()}
        if any('{' in v or '}' in v for v in self.env.values()):
            raise RuntimeError('UNRESOLVED_ENV')
        write(self.out / 'admission.json', admission)
        write(self.out / 'run-manifest.json', {'manifestSha256': manifest_hash, 'mode': mode,
              'durationSeconds': duration, 'environment': self.env, 'startedAt': utc(),
              'deadlineMonotonic': self.deadline, 'limits': manifest['limits'],
              'scope': 'APP_HTTP_WS_PROCESS_CRASH_ONLY', 'scientificAcceptance': False})
        self.monitor = threading.Thread(target=self.watch, daemon=True)
        self.monitor.start()

    def event(self, kind, **payload):
        with self.events_lock:
            return self.archive.append({'kind': kind, 'utc': utc(), 'monotonic': time.monotonic(), **payload})

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
                        dependency_root = self.out / 'stage/node_modules'
                        if not p.is_relative_to(dependency_root):
                            raise RuntimeError('OUTPUT_SYMLINK_OUTSIDE_TYPED_DEPS')
                        rel = p.relative_to(dependency_root).as_posix()
                        expected = self.m['dependencyClosure'].get(rel)
                        if not expected or expected['kind'] != 'symlink' or os.readlink(p) != expected['chain'][0]['text'] or not p.resolve(strict=True).is_relative_to(dependency_root):
                            raise RuntimeError('OUTPUT_TYPED_SYMLINK_DRIFT')
                        size += p.lstat().st_size
                        continue
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
        if closure(HERE / 'node_modules') != self.m['dependencyClosure']:
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
        if closure(self.out / 'stage/node_modules') != self.m['dependencyClosure']:
            raise RuntimeError('STAGED_DEPS_CHANGED')
        if tree(self.out / 'stage/dist') != json.loads((self.out / 'compiled-pins.json').read_text()):
            raise RuntimeError('COMPILED_APP_CHANGED')

    def identity(self, pid):
        stat = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return {'pid': pid, 'starttime': stat[19], 'session': int(stat[3]), 'pgrp': int(stat[2]),
                'cgroup': Path(f'/proc/{pid}/cgroup').read_text().strip()}

    def send(self, child, sig):
        if child['p'].poll() is not None:
            return False
        current = self.identity(child['p'].pid)
        if current != child['identity'] or current['pgrp'] != child['p'].pid or current['session'] != child['p'].pid or current['cgroup'] != self.cgroup_text:
            raise RuntimeError('CHILD_OWNERSHIP_LOST')
        os.kill(child['p'].pid, sig)
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
        shutil.copytree(HERE / 'node_modules', self.out / 'stage/node_modules', symlinks=True)
        if closure(self.out / 'stage/node_modules') != self.m['dependencyClosure']:
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

    def request(self, method, path, payload=None, cookie=None, slow=False):
        self.check()
        if not path.startswith('/api/') or '://' in path:
            raise RuntimeError('LOCAL_PATH_ONLY')
        conn = http.client.HTTPConnection('127.0.0.1', self.port,
                                          timeout=min(self.m['limits']['requestSeconds'], max(0.1, self.deadline - time.monotonic())))
        headers = {'Origin': self.origin, 'Content-Type': 'application/json', 'Connection': 'close'}
        if cookie:
            headers['Cookie'] = cookie
        try:
            conn.request(method, path, body=canon(payload).encode() if payload is not None else None, headers=headers)
            if method == 'POST' and path == '/api/gesture':
                self.event('http-request-sent', requestId=payload['id'], responseWillBeRead=True)
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
        self.archive.close()
        return cleanup

