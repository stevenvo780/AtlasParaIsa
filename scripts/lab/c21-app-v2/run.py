#!/usr/bin/python3.14
"""Native capsule entrypoint. Authoring may AST-parse; never execute runtime here."""
import sys
sys.dont_write_bytecode = True
from pathlib import Path
# -I intentionally suppresses ambient paths. Only this owned, real directory is added.
LOCAL = Path(__file__).resolve().parent
if LOCAL.is_symlink():
    raise RuntimeError('LOCAL_MODULE_ROUTE')
sys.path.insert(0, str(LOCAL))
import argparse
import concurrent.futures
import hashlib
import json
import os
import queue
import secrets
import select
import signal
import socket
import sqlite3
import subprocess
import threading
import time
from capsule import Capsule, HERE, OWN, canon, digest, hashed, physical, utc, write
from evidence import retain_cut, verify_archive
from pins import verify_pins
from ws import Peer

IPC_KINDS = {'ready', 'armed', 'barrier', 'flow', 'pending', 'stepped', 'cut-armed',
             'projection-cut', 'cut-unavailable', 'recovery-cut', 'recovery-loaded'}
HOOKS = {'B01-F': 'WRITE_BEFORE_BEGIN', 'B02-F': 'WRITE_BEFORE_FLUSH',
         'B10-F': 'WRITE_BEFORE_COMMIT', 'A01-F': 'WRITE_AFTER_COMMIT'}


class HeaderProbe:
    """A real HTTP client receiving bytes; zero headers is observed, never assumed."""
    def __init__(self, capsule, gesture):
        self.sock = socket.create_connection(('127.0.0.1', capsule.port), timeout=10)
        self.sock.setblocking(False)
        body = canon(gesture).encode()
        header = (f'POST /api/gesture HTTP/1.1\r\nHost: 127.0.0.1:{capsule.port}\r\n'
                  f'Origin: {capsule.origin}\r\nCookie: {capsule.cookie}\r\n'
                  f'Content-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n').encode()
        self.sock.setblocking(True)
        self.sock.sendall(header + body)
        self.sock.setblocking(False)
        self.received = bytearray()
        self.eof = False
        self.sent_at = time.monotonic()
        self.operation_id = gesture['id']
        capsule.event('http-probe-sent', requestId=gesture['id'], requestBody=gesture,
                      requestBodySha256=hashlib.sha256(body).hexdigest(), monotonicSent=self.sent_at)

    def sample(self):
        if self.eof:
            return
        ready, _, _ = select.select([self.sock], [], [], 0)
        if ready:
            part = self.sock.recv(65536)
            if part:
                self.received.extend(part)
                if len(self.received) > 8 * 1024 * 1024:
                    raise RuntimeError('HEADER_PROBE_CAP')
            else:
                self.eof = True

    def close(self):
        self.sample()
        self.sock.close()


class AppCapsule(Capsule):
    def __init__(self, *args):
        self.peers = []
        self.matrix = {}
        self.login_times = []
        self.actual_session_hashes = set()
        self.cut_ordinal = 0
        self.worker_ordinal = 0
        self.worker = None
        super().__init__(*args)
        self.plan = json.loads((LOCAL / 'case-plan.json').read_text())
        self.matrix = {c['caseId']: {**c, 'classification': 'UNKNOWN', 'attempted': False,
                                   'runtimeEvidence': None} for c in self.plan['cases']}

    def pincheck(self):
        super().pincheck()
        verify_pins(HERE, self.m['authorPins'])
        for path, expected in self.m['rootBindings'].items():
            if digest(path) != expected:
                raise RuntimeError('ROOT_BINDING_CHANGED:' + path)

    def worker_spawn(self, manual=False, recovery=False):
        self.pincheck()
        self.stagecheck()
        self.check()
        ordinal = self.worker_ordinal
        self.worker_ordinal += 1
        label = f'app-{ordinal}'
        cookie = secrets.token_hex(32)
        event_read, event_write = os.pipe()
        release_read, release_write = os.pipe()
        environment = dict(self.env, C21_IPC_COOKIE=cookie, C21_EVENT_FD=str(event_write),
                           C21_RELEASE_FD=str(release_read), C21_MANUAL='1' if manual else '0',
                           C21_RECOVERY_HOLD='1' if recovery else '0')
        err = (self.out / f'logs/{label}.stderr').open('xb')
        try:
            process = subprocess.Popen(self.resolve_argv(self.m['runtimeArgv']), cwd=self.out / 'stage',
                                       env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=err, start_new_session=True, pass_fds=(event_write, release_read))
        except BaseException:
            for fd in (event_read, event_write, release_read, release_write):
                os.close(fd)
            err.close()
            raise
        os.close(event_write)
        os.close(release_read)
        child = {'p': process, 'identity': self.identity(process.pid), 'err': err, 'label': label,
                 'cookie': cookie, 'release': release_write, 'ipc': queue.Queue(maxsize=128), 'manual': manual}
        self.children.append(child)
        self.worker = child
        self.event('spawn', argv=self.resolve_argv(self.m['runtimeArgv']), identity=child['identity'],
                   manualScheduler=manual, privateHooksOptIn=True)

        def receive():
            try:
                with os.fdopen(event_read, 'rb') as stream:
                    while line := stream.readline(65537):
                        if len(line) > 65536 or not line.endswith(b'\n'):
                            raise RuntimeError('IPC_LINE_CAP')
                        message = json.loads(line)
                        if message.get('cookie') != cookie or message.get('kind') not in IPC_KINDS or message.get('identity') != child['identity']:
                            raise RuntimeError('IPC_COOKIE_IDENTITY_OR_WHITELIST')
                        # Cookie authenticates the private pipe but never enters artifacts.
                        del message['cookie']
                        self.event('worker-ipc', **{'message': message})
                        child['ipc'].put(message, timeout=1)
            except Exception as error:
                self.reason = str(error)
                self.failed.set()

        def stdout():
            with (self.out / f'logs/{label}.stdout').open('xb') as stream:
                for block in iter(lambda: process.stdout.read(65536), b''):
                    stream.write(block)

        child['reader'] = threading.Thread(target=receive, daemon=True)
        child['stdout'] = threading.Thread(target=stdout, daemon=True)
        child['reader'].start()
        child['stdout'].start()
        return child

    def wait_ipc(self, child, kinds, timeout=60):
        until = min(self.deadline, time.monotonic() + timeout)
        while time.monotonic() < until:
            self.check()
            if child['p'].poll() is not None:
                raise RuntimeError('WORKER_EXIT_BEFORE_WITNESS')
            try:
                message = child['ipc'].get(timeout=0.1)
            except queue.Empty:
                continue
            if message['kind'] not in kinds:
                raise RuntimeError('UNEXPECTED_IPC:' + message['kind'])
            if self.identity(child['p'].pid) != child['identity']:
                raise RuntimeError('IPC_LIVE_IDENTITY_CHANGED')
            return message
        raise RuntimeError('MISSING_REAL_BARRIER_OR_IPC_TIMEOUT')

    def control(self, child, kind, **fields):
        if kind not in {'arm', 'flow', 'pending', 'step', 'hold-cut', 'recovery-hold'}:
            raise RuntimeError('PARENT_CONTROL_WHITELIST')
        if self.identity(child['p'].pid) != child['identity']:
            raise RuntimeError('CONTROL_OWNERSHIP')
        child['p'].stdin.write((canon({'kind': kind, 'cookie': child['cookie'], **fields}) + '\n').encode())
        child['p'].stdin.flush()

    def release(self, child):
        if self.identity(child['p'].pid) != child['identity']:
            raise RuntimeError('RELEASE_OWNERSHIP')
        os.write(child['release'], b'C')

    def ready(self, child):
        value = self.wait_ipc(child, {'ready'}, self.m['limits']['startupSeconds'])
        if type(value.get('port')) is not int or not 1 <= value['port'] <= 65535 or value['origin'] != f"http://127.0.0.1:{value['port']}" or value['dbfile'] != str(self.out / 'data/world.sqlite'):
            raise RuntimeError('READY_ENDPOINT_OR_DB')
        self.port = value['port']
        self.origin = value['origin']
        self.instance_id = value['instanceId']
        return value

    def login(self):
        # One synthetic session is intentionally shared; 12 TCP peers are not 12 identities.
        now = time.monotonic()
        self.login_times = [t for t in self.login_times if now - t < 60]
        if len(self.login_times) >= 5:
            until = self.login_times[0] + 61
            while time.monotonic() < until:
                self.check()
                time.sleep(min(0.2, until - time.monotonic()))
        self.login_times.append(time.monotonic())
        super().login()
        self.actual_session_hashes.add(hashlib.sha256(self.cookie.encode()).hexdigest())
        self.event('session-counts', logicalHttpClients=12, realWebsocketConnections=len(self.peers),
                   simultaneousSessions=1, distinctSyntheticSessionsCreated=len(self.actual_session_hashes), identities=1)

    def retain(self, label):
        self.cut_ordinal += 1
        label = f'{self.cut_ordinal:06d}-{label}'
        result = retain_cut(self.out / 'data/world.sqlite', self.event, label,
                            self.m['limits']['oracleEncodedBytes'], min(self.deadline, time.monotonic() + 30))
        result['physical'] = physical(self.out / 'data')
        return result

    def observe_full(self, client, camera, view):
        if view.get('instanceId') != self.instance_id or view.get('sequence') != view.get('tick'):
            raise RuntimeError('SHARED_WORLD_DIVERGENCE')
        key = (view['instanceId'], view['version'], view['tick'])
        with self.ack_lock:
            previous = self.common_cuts.setdefault(key, [])
            for other in previous:
                if other['client'] == client:
                    continue
                compared = 0
                for field in ('tiles', 'people', 'animals', 'structures', 'blueprints', 'places'):
                    def entities(value):
                        rows = value[field]
                        values = {(p['x'], p['y']) if field == 'tiles' else p['id']: p for p in rows}
                        if len(values) != len(rows):
                            raise RuntimeError('DUPLICATE_CLIENT_ENTITY')
                        return values
                    left, right = entities(view), entities(other['view'])
                    for ident in left.keys() & right.keys():
                        if left[ident] != right[ident]:
                            self.event('common-cut-difference', tick=view['tick'], field=field,
                                       clients=[client, other['client']], observed=left[ident], previous=right[ident])
                            raise RuntimeError('SHARED_WORLD_DIVERGENCE')
                        compared += 1
                if camera == other['camera']:
                    # Every projection field except live process performance; full raw payload is retained.
                    left = {k: v for k, v in view.items() if k != 'performance'}
                    right = {k: v for k, v in other['view'].items() if k != 'performance'}
                    if left != right:
                        raise RuntimeError('COMPLETE_CLIENT_PROJECTION_DIVERGENCE')
                if compared:
                    self.common_comparisons += 1
                    self.event('common-cut-comparison', instanceId=view['instanceId'], tick=view['tick'],
                               clients=[client, other['client']], comparedEntities=compared, exact=True,
                               rawProjectionRetained=True, completeSameCamera=camera == other['camera'])
            previous[:] = [v for v in previous if v['client'] != client]
            previous.append({'client': client, 'camera': camera, 'view': view})
            while len(self.common_cuts) > 128:
                self.common_cuts.popitem(last=False)
                # Raw projections survive in the archive; eviction is not evidence of equality.

    def same_cut_projection(self, child, camera):
        token = secrets.token_hex(16)
        self.control(child, 'hold-cut', token=token)
        self.wait_ipc(child, {'cut-armed'})
        viewport = {'x': 16 * camera, 'y': 0, 'width': 32, 'height': 32}
        path = f"/api/world?x={viewport['x']}&y=0&width=32&height=32"
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.request, 'GET', path, cookie=self.cookie)
            witness = self.wait_ipc(child, {'projection-cut', 'cut-unavailable'}, 15)
            held = witness['kind'] == 'projection-cut'
            try:
                if not held:
                    status, payload, _ = future.result(timeout=10)
                    self.event('projection-sqlite-comparison', classification='UNKNOWN', reason='NO_ACTUAL_COMMON_DURABLE_TICK',
                               rawClientResponse=payload.decode(), status=status)
                    return False
                actual_cut = self.retain('projection-same-cut')
                if actual_cut['tick'] != witness['tick'] or actual_cut['snapshotDigest'] != witness['snapshotDigest']:
                    raise RuntimeError('SAME_CUT_BINDING_CHANGED')
                # DB writer remains synchronously held. Independent RO connection, no in-memory App.
                argv = [self.m['executables']['node'], str(self.out / 'stage/scripts/lab/c21-app-v2/projection.mjs'),
                        str(self.out / 'data/world.sqlite'), canon(viewport)]
                projection = self.spawn(argv, f'projection-{self.cut_ordinal}')
                stream = projection['p'].stdout
                blocks = []
                def drain():
                    total = 0
                    while block := stream.read(65536):
                        total += len(block)
                        if total > self.m['limits']['oracleEncodedBytes']:
                            self.send(projection, signal.SIGKILL)
                            raise RuntimeError('PROJECTION_ORACLE_CAP')
                        blocks.append(block)
                reader = threading.Thread(target=drain)
                reader.start()
                projection['p'].wait(timeout=min(30, max(0.1, self.deadline - time.monotonic())))
                reader.join(timeout=3)
                if projection['p'].returncode or reader.is_alive():
                    raise RuntimeError('READONLY_PROJECTION_FAILED')
                expected = json.loads(b''.join(blocks))
                self.event('sqlite-derived-complete-projection', rawProjection=expected, cut=actual_cut)
            finally:
                if held:
                    self.release(child)
            status, payload, _ = future.result(timeout=10)
        if status != 200 or hashlib.sha256(payload).hexdigest() != witness['responseSha256']:
            raise RuntimeError('PROJECTION_HTTP_PAYLOAD_BINDING')
        actual = json.loads(payload)
        self.event('http-complete-projection', rawProjection=actual, camera=camera, responseSha256=witness['responseSha256'])
        # performance is the complete live operational block, not stored world state.
        if 'performance' not in actual or set(actual) - {'performance'} != set(expected['projected']):
            raise RuntimeError('COMPLETE_PROJECTION_FIELD_COVERAGE')
        if {k: v for k, v in actual.items() if k != 'performance'} != expected['projected'] or expected['snapshotDigest'] != actual_cut['snapshotDigest']:
            raise RuntimeError('COMPLETE_SQLITE_CLIENT_PROJECTION_DIVERGENCE')
        self.event('projection-sqlite-comparison', classification='TECHNICAL_EQUAL', tick=actual_cut['tick'],
                   actualReadTransaction=True, completeWorldProjection=True, dynamicOperationalBlockRetained='performance',
                   independentIntegrity='PYTHON_ALL_TABLES_RAW_ROWS', projectionCodec='PRODUCTION_READER_UNDER_TEST_NOT_MANUAL_ORACLE')
        return True

    def open_peers(self):
        self.peers = []
        try:
            for client in range(12):
                profile = 'fast' if client < 4 else 'slow' if client < 8 else 'nonreader'
                self.peers.append(Peer(self, client, client % 2, profile).open())
        except BaseException:
            self.close_peers()
            raise

    def close_peers(self):
        errors = []
        peers = self.peers
        self.peers = []
        for peer in peers:
            try:
                peer.close()
            except Exception as error:
                errors.append(str(error))
        if errors:
            raise RuntimeError('WS_CLEANUP:' + repr(errors))

    def flow(self, child):
        self.control(child, 'flow')
        message = self.wait_ipc(child, {'flow'}, 15)
        flows = message['flow']
        wanted = {p.local_port for p in self.peers}
        actual = {f['remotePort'] for f in flows}
        if len(flows) != 12 or len(wanted) != 12 or wanted != actual or not all(f['acuse'] for f in flows):
            raise RuntimeError('TWELVE_REAL_WS_NOT_SERVER_CONFIRMED')
        for peer in self.peers:
            row = next(f for f in flows if f['remotePort'] == peer.local_port)
            if row['acuses'] > peer.acks or row['enviados'] < peer.states or row['enviados'] - row['acuses'] > 1:
                raise RuntimeError('WS_SERVER_CLIENT_ACK_CONTRACT')
        self.event('twelve-ws-server-confirmed', flow=flows, clients=12, identities=1, sessions=1)
        return flows

    def gesture_from(self, view, client, label, rejected=False):
        people = [p for p in view['people'] if p['role'] == 'neighbor']
        if not people:
            raise RuntimeError('ACCEPTED_ORDER_OPPORTUNITY_MISSING')
        person = people[client % len(people)]
        self.requests[client] += 1
        return {'id': f"{self.a['runId']}-c{client:02d}-{label}-{self.requests[client]:06d}",
                'kind': 'command', 'x': person['x'], 'y': person['y'],
                'agentId': 'c21-missing-agent' if rejected else person['id'], 'order': 'rest'}

    def submit_all(self):
        tasks = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            for peer in self.peers:
                if peer.last_view is None:
                    raise RuntimeError('WS_NO_ACTUAL_STATE')
                gesture = self.gesture_from(peer.last_view, peer.client, 'live', rejected=self.requests[peer.client] % 5 == 4)
                self.inflight[gesture['id']] = {'gesture': gesture, 'client': peer.client, 'sequence': self.requests[peer.client]}
                tasks.append((peer.client, gesture, pool.submit(self.request, 'POST', '/api/gesture', gesture, self.cookie)))
            for client, gesture, future in tasks:
                status, payload, _ = future.result(timeout=15)
                self.receipt(client, self.requests[client], gesture, status, payload)

    def exposure_campaign(self, duration):
        child = self.worker_spawn(manual=False)
        ready = self.ready(child)
        if ready['loadedTick'] is not None or ready['tick'] != 0:
            raise RuntimeError('FRESH_SYNTHETIC_FIXTURE_REQUIRED')
        self.login()
        self.open_peers()
        try:
            until = time.monotonic() + 30
            while not all(peer.states > 0 for peer in self.peers):
                self.check()
                if time.monotonic() >= until:
                    raise RuntimeError('TWELVE_WS_STATES_MISSING')
                time.sleep(0.05)
            self.flow(child)
            opening = time.monotonic()
            deadline = opening + duration
            next_submit = opening
            next_flow = opening + 2
            next_pins = opening + 300
            samecuts = 0
            self.event('twelve-ws-exposure-open', openingMonotonic=opening, plannedClosingMonotonic=deadline)
            while time.monotonic() < deadline:
                self.check()
                if any(peer.error or peer.closed_at is not None for peer in self.peers):
                    raise RuntimeError('WS_EXPOSURE_INTERRUPTED')
                now = time.monotonic()
                if now >= next_submit:
                    self.submit_all()
                    next_submit = now + (10 if self.mode == 'diagnostic' else 300)
                    samecuts += int(self.same_cut_projection(child, int(now - opening) % 2))
                if now >= next_pins:
                    self.pincheck()
                    self.stagecheck()
                    next_pins = time.monotonic() + 300
                if now >= next_flow:
                    self.flow(child)
                    next_flow = time.monotonic() + 2
                time.sleep(min(0.1, max(0, deadline - time.monotonic())))
            self.flow(child)
            closing = time.monotonic()
            elapsed = closing - opening
            if elapsed < duration or (self.mode == 'campaign' and elapsed < 3600):
                raise RuntimeError('MONOTONIC_EXPOSURE_SHORT')
            self.event('twelve-ws-exposure-close', openingMonotonic=opening, closingMonotonic=closing,
                       actualSeconds=elapsed, expectedSeconds=duration, wallClockUsedForExposure=False)
            result = {'actualTwelveWsSeconds': elapsed, 'durationRequested': duration,
                      'realWsConnections': 12, 'simultaneousSyntheticSessions': 1, 'syntheticIdentities': 1,
                      'serverConfirmedAtStartAndEnd': True, 'fullSqliteProjectionCommonCuts': samecuts,
                      'commonClientComparisons': self.common_comparisons,
                      'statesByClient': [p.states for p in self.peers], 'projectionAcksByClient': [p.acks for p in self.peers]}
        finally:
            self.close_peers()
        self.stop(child, signal.SIGTERM)
        self.verify_all()
        self.retain('exposure-closed')
        return result

    def wait_pending(self, child):
        until = time.monotonic() + 15
        while time.monotonic() < until:
            self.control(child, 'pending')
            message = self.wait_ipc(child, {'pending'}, 5)
            if message['count'] == 1:
                return
            if message['count'] != 0:
                raise RuntimeError('FAULT_OPERATION_NOT_EXCLUSIVE')
            time.sleep(0.05)
        raise RuntimeError('REAL_HTTP_REQUEST_NOT_QUEUED')

    def reconcile_recovery(self, closed):
        child = self.worker_spawn(manual=True, recovery=True)
        loaded = self.wait_ipc(child, {'recovery-loaded'}, 60)
        recovered = self.retain('recovery-before-app-startup-write')
        if recovered['logicalSha256'] != closed['logicalSha256'] or loaded['loadedSlot'] != 0 or loaded['loadedTick'] != closed['tick'] or loaded['instanceId'] != closed['instanceId']:
            raise RuntimeError('RECOVERY_RESET_REWIND_OR_FULL_CUT_CHANGED')
        self.release(child)
        self.ready(child)
        # Existing session is durable across restart; no burst of new logins.
        status, raw, _ = self.request('GET', '/api/session', cookie=self.cookie)
        if status != 200 or json.loads(raw) != {'authenticated': True}:
            raise RuntimeError('DURABLE_SYNTHETIC_SESSION_LOST')
        self.common_cuts.clear()
        self.verify_all()
        return child

    def reconnect_camera(self, child):
        prior = self.peers[0]
        until = time.monotonic() + 15
        while prior.last_view is None:
            self.check()
            if time.monotonic() >= until:
                raise RuntimeError('RECONNECT_PRIOR_STATE_MISSING')
            time.sleep(0.05)
        prior_sequence = prior.sequence
        prior.close()
        until = time.monotonic() + 15
        while True:
            self.control(child, 'flow')
            flows = self.wait_ipc(child, {'flow'}, 5)['flow']
            if len(flows) == 11 and prior.local_port not in {f['remotePort'] for f in flows}:
                break
            self.check()
            if time.monotonic() >= until:
                raise RuntimeError('REAL_WS_DISCONNECT_NOT_SERVER_OBSERVED')
            time.sleep(0.05)
        peer = Peer(self, 0, 1, 'slow').open()
        self.peers[0] = peer
        until = time.monotonic() + 15
        while peer.last_view is None:
            self.check()
            if time.monotonic() >= until:
                raise RuntimeError('REAL_WS_RECONNECT_STATE_MISSING')
            time.sleep(0.05)
        if peer.sequence < prior_sequence or peer.last_view['instanceId'] != self.instance_id:
            raise RuntimeError('RECONNECT_INSTANCE_OR_SEQUENCE_DIVERGENCE')
        self.flow(child)
        self.verify_all()
        self.event('client-reconnect-camera', client=0, oldCamera=0, newCamera=1,
                   oldSequence=prior_sequence, newSequence=peer.sequence, oldRemotePort=prior.local_port,
                   newRemotePort=peer.local_port, priorResultIdsReconciled=True,
                   missingProjectionHistory='UNKNOWN_COALESCED_STATES_NOT_RECONSTRUCTED')
        self.matrix['S02']['attempted'] = True
        self.matrix['S02']['runtimeEvidence'] = {'realDisconnectReconnect': True, 'cameraChanged': True,
                                                'oldSequence': prior_sequence, 'newSequence': peer.sequence}

    def fault_case(self, case_id):
        row = self.matrix[case_id]
        row['attempted'] = True
        child = self.worker_spawn(manual=True)
        self.ready(child)
        if not hasattr(self, 'cookie'):
            self.login()
        else:
            status, raw, _ = self.request('GET', '/api/session', cookie=self.cookie)
            if status != 200 or json.loads(raw) != {'authenticated': True}:
                self.login()
        self.open_peers()
        status, raw, _ = self.request('GET', '/api/world?x=0&y=0&width=32&height=32', cookie=self.cookie)
        if status != 200:
            raise RuntimeError('FAULT_VIEW_UNAVAILABLE')
        gesture = self.gesture_from(json.loads(raw), 0, case_id.replace('-', '_'))
        hook = HOOKS[case_id]
        self.control(child, 'arm', hook=hook, operationId=gesture['id'])
        armed = self.wait_ipc(child, {'armed'})
        if armed['operationId'] != gesture['id'] or armed['hook'] != hook:
            raise RuntimeError('ARM_BINDING')
        probe = HeaderProbe(self, gesture)
        try:
            self.wait_pending(child)
            self.control(child, 'step')
            witness = self.wait_ipc(child, {'barrier'}, 30)
            observed_at = time.monotonic()
            if witness['hook'] != hook or witness['operationId'] != gesture['id'] or witness['operationBinding'] != 'STORE_SAVE_ARGUMENTS_REAL_GESTURE_ID' or gesture['id'] not in witness['inputIds'] or witness['dbfile'] != str(self.out / 'data/world.sqlite'):
                raise RuntimeError('UNKNOWN_OPERATION_BINDING')
            candidate = [v for v in witness.get('candidateBindings', []) if v['gesture']['id'] == gesture['id']]
            if len(candidate) != 1 or candidate[0]['gesture'] != gesture or candidate[0]['result']['id'] != gesture['id'] or candidate[0]['result']['tick'] != witness['candidateTick']:
                raise RuntimeError('UNKNOWN_OPERATION_BINDING')
            expected_fingerprint = hashlib.sha256(json.dumps([gesture['kind'], gesture['x'], gesture['y'], None, gesture['agentId'], gesture['order']], separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
            if candidate[0]['fingerprint'] != expected_fingerprint:
                raise RuntimeError('UNKNOWN_OPERATION_BINDING')
            if hook == 'WRITE_BEFORE_BEGIN' and (witness['writeBeginSeen'] or witness['inTransaction']):
                raise RuntimeError('INVALID_BEFORE_BEGIN_PHASE')
            if hook in {'WRITE_BEFORE_FLUSH', 'WRITE_BEFORE_COMMIT'} and (not witness['writeBeginSeen'] or not witness['inTransaction']):
                raise RuntimeError('INVALID_ACTIVE_WRITE_PHASE')
            committed = hook == 'WRITE_AFTER_COMMIT'
            if witness['commitReturned'] != committed or (committed and (witness['inTransaction'] or not witness['writeBeginSeen'] or witness['changesDelta'] <= 0)):
                raise RuntimeError('NOOP_OR_UNBOUND_REAL_COMMIT')
            if hook in {'WRITE_BEFORE_COMMIT', 'WRITE_AFTER_COMMIT'} and not any(r['id'] == gesture['id'] for r in witness['rows']):
                raise RuntimeError('UNKNOWN_OPERATION_BINDING')
            before = self.retain('barrier-visible-durable-cut')
            db = sqlite3.connect((self.out / 'data/world.sqlite').as_uri() + '?mode=ro', uri=True)
            try:
                result_row = db.execute('SELECT body,result FROM inputs WHERE id=?', (gesture['id'],)).fetchone()
                if bool(result_row) != committed:
                    raise RuntimeError('COMMIT_ROLLBACK_VISIBILITY_WRONG')
                expected_result = json.loads(result_row[1]) if result_row else None
            finally:
                db.close()
            # Ten seconds is an explicit observation hold budget, NOT ten source phases or replicas.
            until = observed_at + self.m['faultPlan']['barrierObservationHoldSeconds']
            while time.monotonic() < until:
                self.check()
                probe.sample()
                if probe.received:
                    raise RuntimeError('UNILATERAL_ACK_OR_CLIENT_HEADERS_BEFORE_BARRIER_KILL')
                time.sleep(0.05)
            for peer in self.peers:
                peer.expect_disconnect = True
            self.stop(child, signal.SIGKILL)
            kill_at = time.monotonic()
            until = min(self.deadline, time.monotonic() + 5)
            while not probe.eof and time.monotonic() < until:
                probe.sample()
                time.sleep(0.01)
            if probe.received or not probe.eof:
                raise RuntimeError('NO_CLIENT_HEADERS_NOT_PROVEN')
            self.event('fault-http-delivery-witness', requestId=gesture['id'], headerBytesActuallyReceived=0,
                       upstreamComplete200='NOT_USED_SQL_BARRIER_BEFORE_PROMISE_RESOLUTION', eofObserved=True,
                       barrierMonotonic=observed_at, killCompletedMonotonic=kill_at, hook=hook, txId=witness['txId'])
        finally:
            probe.close()
            self.close_peers()
        closed = self.retain('fault-closed')
        if closed['logicalSha256'] != before['logicalSha256']:
            raise RuntimeError('FULL_DURABLE_CUT_CHANGED_ON_KILL')
        child = self.reconcile_recovery(closed)
        self.open_peers()
        try:
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(self.request, 'POST', '/api/gesture', gesture, self.cookie)
                if not committed:
                    self.wait_pending(child)
                    self.control(child, 'step')
                    self.wait_ipc(child, {'stepped'})
                status, payload, _ = future.result(timeout=15)
            value = json.loads(payload)
            if committed and value != expected_result:
                raise RuntimeError('RETRY_RESULT_CHANGED_AFTER_REAL_COMMIT')
            self.receipt(0, self.requests[0], gesture, status, payload, retry=True)
            # Same ID with another body must conflict; it never becomes another operation.
            conflict = dict(gesture, order='auto')
            status_conflict, body_conflict, _ = self.request('POST', '/api/gesture', conflict, self.cookie)
            self.event('same-id-different-body', requestId=gesture['id'], status=status_conflict, rawResponse=body_conflict.decode())
            if status_conflict != 409:
                raise RuntimeError('SAME_ID_DIFFERENT_BODY_NOT_REJECTED')
            self.same_cut_projection(child, 0)
            self.reconnect_camera(child)
            self.flow(child)
        finally:
            self.close_peers()
        self.stop(child, signal.SIGTERM)
        self.verify_all()
        row['runtimeEvidence'] = {'hook': hook, 'txId': witness['txId'], 'operationId': gesture['id'],
                                  'realWriteCommitReturned': committed, 'clientHeaderBytes': 0,
                                  'barrierHoldObservedSeconds': kill_at - observed_at,
                                  'fullRawClosedCut': closed, 'sameIdRetryReconciled': True}
        # Mechanism observations cannot satisfy the handwritten material ledger/v3 bundle.
        row['classification'] = 'UNKNOWN'
        row['reason'] = 'TECHNICAL_MECHANISM_OBSERVED; F21-B/C manual ledger and frozen-v3 conformance not supplied'
        row['technicalMechanism'] = 'OBSERVED'
        return row['runtimeEvidence']

    def campaign(self):
        self.build()
        exposure = self.exposure_campaign(self.duration)
        for case_id in ('S01', 'S04', 'D01'):
            self.matrix[case_id]['attempted'] = True
            self.matrix[case_id]['runtimeEvidence'] = {'exposureRef': exposure, 'scope': 'TECHNICAL_PARTIAL_NOT_MANUAL_LEDGER'}
        faults = []
        for case_id in self.m['faultPlan']['diagnosticCases' if self.mode == 'diagnostic' else 'campaignCases']:
            faults.append(self.fault_case(case_id))
        self.matrix['S03']['attempted'] = True
        self.matrix['S03']['runtimeEvidence'] = {'beforeAfterCases': [f['operationId'] for f in faults], 'reconnectedRealPeers': True}
        self.pincheck()
        self.stagecheck()
        return {'exposure': exposure, 'faults': faults, 'receivedResults': len(self.acks),
                'acceptedResults': sum(r['result']['accepted'] for r in self.acks.values()),
                'rejectedResults': sum(not r['result']['accepted'] for r in self.acks.values()),
                'distinctSyntheticSessionsCreated': len(self.actual_session_hashes), 'syntheticIdentities': 1,
                'fullCaseDenominator': 115, 'casePasses': 0, 'semanticLedger': 'UNKNOWN', 'powerLoss': 'UNKNOWN'}

    def close(self):
        cleanup_errors = []
        try:
            self.close_peers()
        except Exception as error:
            cleanup_errors.append(str(error))
        # Drain every IPC/stdout producer before sealing the retained archive.
        for child in self.children:
            try:
                if child['p'].poll() is None:
                    self.send(child, signal.SIGKILL)
                    child['p'].wait(timeout=5)
                if 'release' in child:
                    os.close(child['release'])
                    child['p'].stdin.close()
                    child['reader'].join(timeout=2)
                    child['stdout'].join(timeout=2)
                    if child['reader'].is_alive() or child['stdout'].is_alive():
                        raise RuntimeError('WORKER_READERS_NOT_CLOSED')
            except Exception as error:
                cleanup_errors.append(str(error))
        result = super().close()
        if cleanup_errors or any(not child.get('pidAbsent') for child in result):
            raise RuntimeError('OWN_CHILD_CLEANUP_INCOMPLETE:' + repr(cleanup_errors))
        return result


def validate_admission(manifest, admission, args):
    if not sys.flags.isolated or Path(sys.executable).resolve() != Path(manifest['executables']['python']).resolve() or digest(sys.executable) != manifest['runtimePins'][manifest['executables']['python']]:
        raise RuntimeError('EXACT_PYTHON_PIN_REQUIRED')
    if admission.get('argv') != manifest['nativeArgv'][args.mode]:
        raise RuntimeError('EXACT_ROOT_ARGV_REQUIRED')
    if admission.get('newRootGo') is not True or admission.get('authorExecution') is not False:
        raise RuntimeError('NEW_ROOT_NATIVE_GO_REQUIRED')
    if admission.get('deadlineSeconds') != manifest['limits']['absoluteSeconds'][args.mode]:
        raise RuntimeError('ROOT_DEADLINE_SCOPE')
    # Supplied by Root; never query DBus, change units or manufacture CPU admission.
    component = admission.get('nativeCpuLongComponent', {})
    if not component.get('path') or digest(component['path']) != component.get('sha256') or component.get('suppliedBy') != 'root':
        raise RuntimeError('ROOT_NATIVE_CPU_COMPONENT_MANIFEST_REQUIRED')
    component_body = json.loads(Path(component['path']).read_text())
    if component_body.get('schema') != 'c21-root-native-component/v2' or component_body.get('runId') != admission['runId'] or component_body.get('manifestSha256') != digest(args.manifest) or component_body.get('argv') != manifest['nativeArgv'][args.mode] or component_body.get('deadlineSeconds') != admission['deadlineSeconds'] or component_body.get('cgroupPath') != admission['cgroupPath'] or component_body.get('globalGuards') != manifest['globalGuards']:
        raise RuntimeError('ROOT_NATIVE_COMPONENT_CONTENT_BINDING')
    if component_body.get('cpuCount') != 4 or component_body.get('memoryBytes') != manifest['limits']['memoryBytes'] or component_body.get('outputBytesTotal') != manifest['limits']['outputBytes'] or component_body.get('logBytesTotal') != manifest['limits']['logBytes'] or component_body.get('accountsOwnHomeTmpCacheStageDbAndWrapper') is not True:
        raise RuntimeError('ROOT_COMPONENT_COMPLETE_RESOURCE_ACCOUNTING')
    if admission.get('globalGuards') != manifest['globalGuards']:
        raise RuntimeError('GLOBAL_GUARDS_BINDING')
    if args.mode == 'campaign':
        prereg = admission.get('reviewedPreregistration', {})
        if prereg.get('approvedBy') != 'root' or not prereg.get('path') or digest(prereg['path']) != prereg.get('sha256'):
            raise RuntimeError('ROOT_REVIEWED_PREREGISTRATION_REQUIRED')
        manual = admission.get('independentManualComponentExpected', {})
        if not manual.get('path') or digest(manual['path']) != manual.get('sha256') or not manual.get('reviewer') or manual.get('reviewer') == 'author':
            raise RuntimeError('INDEPENDENT_MANUAL_COMPONENT_EXPECTED_REQUIRED')
        review = admission.get('finReview', {})
        if review.get('decision') != 'GO_LONG' or not review.get('path') or digest(review['path']) != review.get('sha256'):
            raise RuntimeError('FIN_REVIEW_BEFORE_FULL_REQUIRED')
        diagnostic = admission.get('diagnosticResult', {})
        path = Path(diagnostic.get('path', '/missing')).resolve(strict=True)
        if not path.is_relative_to(OWN / 'runs') or digest(path) != diagnostic.get('sha256'):
            raise RuntimeError('NEW_V2_DIAGNOSTIC_RESULT_REQUIRED')
        result = json.loads(path.read_text())
        if result.get('mode') != 'diagnostic' or result.get('manifestSha256') != digest(args.manifest) or result.get('status') != 'PARTIAL' or result['observed']['exposure']['actualTwelveWsSeconds'] < 60:
            raise RuntimeError('V2_DIAGNOSTIC_NOT_PASSED_FOR_MECHANISMS')
        if set(manifest['faultPlan']['diagnosticCases']) - {entry['caseId'] for entry in result['cases'] if entry.get('technicalMechanism') == 'OBSERVED'}:
            raise RuntimeError('DIAGNOSTIC_PHASE_MECHANISMS_INCOMPLETE')
        if result['observed']['exposure']['fullSqliteProjectionCommonCuts'] < 1:
            raise RuntimeError('DIAGNOSTIC_FULL_SQLITE_PROJECTION_CUT_MISSING')
        if not result.get('cleanup') or any(not entry.get('pidAbsent') for entry in result.get('cleanup', [])):
            raise RuntimeError('DIAGNOSTIC_CHILDREN_NOT_CLOSED')


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--admission', type=Path, required=True)
    parser.add_argument('--mode', choices=['diagnostic', 'campaign'], required=True)
    parser.add_argument('--duration', type=int, required=True)
    args = parser.parse_args()
    if args.manifest.resolve() != OWN / 'MANIFEST.json' or args.admission.resolve() != OWN / 'root-go' / f'{args.mode}-go.json':
        raise RuntimeError('CANONICAL_NEW_V2_ROOT_BINDINGS_REQUIRED')
    if args.duration != {'diagnostic': 60, 'campaign': 3600}[args.mode]:
        raise RuntimeError('REAL_DURATION_SCOPE_NO_EXTRAPOLATION')
    manifest = json.loads(args.manifest.read_text())
    admission = json.loads(args.admission.read_text())
    validate_admission(manifest, admission, args)
    capsule = AppCapsule(manifest, admission, digest(args.manifest), args.mode, args.duration)
    result = {'schema': 'c21-app-result/v2', 'manifestSha256': digest(args.manifest), 'mode': args.mode,
              'status': 'UNKNOWN', 'c21': 'UNKNOWN', 'scientificAcceptance': False,
              'globalCampaignAcceptance': False, 'scope': 'REAL_APP_HTTP_WS_PROCESS_DEATH_NOT_POWER_LOSS'}
    try:
        result['observed'] = capsule.campaign()
        capsule.check()
        result['status'] = 'PARTIAL' if args.mode == 'diagnostic' else 'TECHNICAL_OBSERVATIONS_ONLY'
    except Exception as error:
        result['reason'] = str(error)
        result['status'] = 'FAIL' if any(word in str(error) for word in
                                      ('DIVERGENCE', 'ACK_LOST', 'RESULT_CHANGED', 'RECOVERY_RESET',
                                       'FULL_DURABLE_CUT_CHANGED', 'CLIENT_HEADERS', 'NOOP')) else 'UNKNOWN'
    finally:
        try:
            result['cleanup'] = capsule.close()
            result['retainedReadback'] = verify_archive(capsule.out / 'evidence', manifest['limits']['outputBytes'])
            if capsule.failed.is_set():
                result['status'] = 'UNKNOWN'
                result['stopReason'] = capsule.reason or 'FAIL_CLOSED_FLAG'
        except Exception as error:
            result['status'] = 'UNKNOWN'
            result['cleanupOrReadbackError'] = str(error)
        result['cases'] = list(capsule.matrix.values())
        result['caseCounts'] = {'denominator': 115, 'PASS': 0,
                                'UNKNOWN': sum(c['classification'] == 'UNKNOWN' for c in capsule.matrix.values()),
                                'attempted': sum(c['attempted'] for c in capsule.matrix.values())}
        result['completedAt'] = utc()
        result['missingCoverage'] = manifest['missingCoverage']
        write(capsule.out / 'result.json', result)
    raise SystemExit(0 if result['status'] in ('PARTIAL', 'TECHNICAL_OBSERVATIONS_ONLY') else 2)


if __name__ == '__main__':
    main()
