"""Real loopback RFC6455 connections; plain frames (deflate is not negotiated)."""
import base64
import hashlib
import json
import secrets
import socket
import struct
import threading
import time

MAX_FRAME = 8 * 1024 * 1024
MAX_STATE = 16 * 1024 * 1024


class Peer:
    def __init__(self, capsule, client, camera, profile):
        self.c = capsule
        self.client = client
        self.camera = camera
        self.profile = profile
        self.sock = None
        self.buffer = bytearray()
        self.fragments = bytearray()
        self.fragment_opcode = None
        self.parts = None
        self.parts_bytes = 0
        self.sequence = None
        self.outstanding = None
        self.states = 0
        self.acks = 0
        self.gaps = 0
        self.last_view = None
        self.last_receive = None
        self.connected_at = None
        self.closed_at = None
        self.stopping = threading.Event()
        self.lock = threading.Lock()
        self.error = None
        self.expect_disconnect = False

    def open(self):
        self.sock = socket.create_connection(('127.0.0.1', self.c.port), timeout=10)
        self.sock.settimeout(1)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        x = 16 * self.camera
        path = f'/ws?ack=1&x={x}&y=0&width=32&height=32'
        request = (f'GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{self.c.port}\r\n'
                   f'Origin: {self.c.origin}\r\nCookie: {self.c.cookie}\r\n'
                   'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n'
                   f'Sec-WebSocket-Key: {key}\r\n\r\n')
        self.sock.sendall(request.encode())
        deadline = time.monotonic() + 10
        while b'\r\n\r\n' not in self.buffer:
            self.c.check()
            if time.monotonic() >= deadline or len(self.buffer) > 16384:
                raise RuntimeError('WS_UPGRADE_TIMEOUT_OR_CAP')
            self.buffer.extend(self.sock.recv(4096))
        header, rest = self.buffer.split(b'\r\n\r\n', 1)
        self.buffer = bytearray(rest)
        lines = header.decode('ascii').split('\r\n')
        headers = {}
        for line in lines[1:]:
            name, value = line.split(':', 1)
            lower = name.lower()
            if lower in headers:
                raise RuntimeError('WS_DUPLICATE_UPGRADE_HEADER')
            headers[lower] = value.strip()
        accept = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
        if lines[0] != 'HTTP/1.1 101 Switching Protocols' or headers.get('sec-websocket-accept') != accept or headers.get('upgrade', '').lower() != 'websocket' or 'upgrade' not in headers.get('connection', '').lower() or 'sec-websocket-extensions' in headers:
            raise RuntimeError('WS_UPGRADE_INVALID')
        self.connected_at = time.monotonic()
        self.local_port = self.sock.getsockname()[1]
        self.c.event('ws-open', client=self.client, camera=self.camera, localPort=self.local_port,
                     profile=self.profile, monotonicOpen=self.connected_at, transport='RFC6455_REAL_TCP', deflate=False)
        self.send({'type': 'suscripcion', 'intervaloMs': 1000 if self.profile == 'fast' else 3000})
        self.thread = threading.Thread(target=self.receive, daemon=True)
        self.thread.start()
        return self

    def send_frame(self, opcode, payload):
        if len(payload) > MAX_FRAME:
            raise RuntimeError('WS_SEND_CAP')
        mask = secrets.token_bytes(4)  # Required transport masking, never World RNG.
        header = bytes([0x80 | opcode])
        length = len(payload)
        if length < 126:
            header += bytes([0x80 | length])
        elif length <= 65535:
            header += bytes([0xfe]) + struct.pack('!H', length)
        else:
            header += bytes([0xff]) + struct.pack('!Q', length)
        masked = bytes(value ^ mask[i % 4] for i, value in enumerate(payload))
        with self.lock:
            self.sock.sendall(header + mask + masked)

    def send(self, value):
        self.send_frame(1, json.dumps(value, separators=(',', ':')).encode())

    def read_exact(self, count):
        while len(self.buffer) < count:
            self.c.check()
            if self.stopping.is_set():
                raise RuntimeError('WS_STOPPED')
            try:
                part = self.sock.recv(min(65536, count - len(self.buffer)))
            except socket.timeout:
                continue
            if not part:
                raise RuntimeError('WS_EOF')
            self.buffer.extend(part)
        result = bytes(self.buffer[:count])
        del self.buffer[:count]
        return result

    def frame(self):
        first, second = self.read_exact(2)
        fin = bool(first & 128)
        opcode = first & 15
        if first & 0x70 or second & 128:
            raise RuntimeError('WS_RESERVED_OR_MASKED_SERVER_FRAME')
        size = second & 127
        if size == 126:
            size = struct.unpack('!H', self.read_exact(2))[0]
            if size < 126:
                raise RuntimeError('WS_NONMINIMAL_LENGTH')
        elif size == 127:
            size = struct.unpack('!Q', self.read_exact(8))[0]
            if size <= 65535 or size >= 2 ** 63:
                raise RuntimeError('WS_INVALID_LENGTH')
        if size > MAX_FRAME or (opcode >= 8 and (not fin or size > 125)):
            raise RuntimeError('WS_FRAME_CAP_OR_CONTROL')
        return fin, opcode, self.read_exact(size)

    def text(self, payload):
        text = payload.decode('utf8', errors='strict')
        if self.parts is not None:
            self.parts['received'].append(text)
            self.parts_bytes += len(payload)
            if self.parts_bytes > MAX_STATE:
                raise RuntimeError('WS_TROZOS_CAP')
            if len(self.parts['received']) < self.parts['total']:
                return
            text = ''.join(self.parts['received'])
            self.parts = None
        message = json.loads(text)
        kind = message.get('type')
        if kind == 'trozos':
            if type(message.get('partes')) is not int or not 1 <= message['partes'] <= 4096 or self.outstanding is not None:
                raise RuntimeError('WS_TROZOS_CONTRACT')
            self.parts = {'total': message['partes'], 'received': []}
            self.parts_bytes = 0
            return
        if kind == 'latido':
            return
        if kind != 'state':
            raise RuntimeError('WS_UNEXPECTED_MESSAGE:' + str(kind))
        view = message['world']
        sequence = view.get('sequence')
        if type(sequence) is not int or sequence < 0 or self.outstanding is not None:
            raise RuntimeError('WS_OUTSTANDING_CONTRACT')
        if self.sequence is not None and sequence < self.sequence:
            raise RuntimeError('WS_SEQUENCE_REGRESSION')
        if self.sequence is not None and sequence > self.sequence + 1:
            self.gaps += 1  # Projection feed coalesces states; never invent missing history.
        self.sequence = sequence
        self.outstanding = sequence
        self.states += 1
        self.last_view = view
        self.last_receive = time.monotonic()
        self.c.event('ws-state', client=self.client, camera=self.camera, stateOrdinal=self.states,
                     sequence=sequence, rawProjection=view, payloadBytes=len(text.encode()),
                     acknowledgement='PROJECTION_ONLY_NOT_GESTURE_DURABILITY')
        self.c.observe_full(self.client, self.camera, view)
        if self.profile == 'slow':
            self.stopping.wait(2)
        elif self.profile == 'nonreader':
            self.c.event('ws-nonreader-open', client=self.client, heldSequence=sequence, durationPlanned=10)
            self.stopping.wait(10)  # Real socket unread; does not fabricate ACKs or phase evidence.
            self.c.event('ws-nonreader-close', client=self.client, heldSequence=sequence)
        if not self.stopping.is_set():
            self.send({'type': 'ack', 'sequence': sequence})
            self.acks += 1
            self.outstanding = None
            self.c.event('ws-projection-ack-sent', client=self.client, sequence=sequence, stateOrdinal=self.states)

    def receive(self):
        try:
            while not self.stopping.is_set():
                fin, opcode, payload = self.frame()
                if opcode == 9:
                    self.send_frame(10, payload)
                    continue
                if opcode == 10:
                    continue
                if opcode == 8:
                    raise RuntimeError('WS_SERVER_CLOSE')
                if opcode in (1, 2):
                    if self.fragment_opcode is not None or opcode == 2:
                        raise RuntimeError('WS_FRAGMENT_OR_BINARY_CONTRACT')
                    if fin:
                        self.text(payload)
                    else:
                        self.fragment_opcode = opcode
                        self.fragments.extend(payload)
                elif opcode == 0 and self.fragment_opcode == 1:
                    self.fragments.extend(payload)
                    if len(self.fragments) > MAX_STATE:
                        raise RuntimeError('WS_FRAGMENT_CAP')
                    if fin:
                        self.text(bytes(self.fragments))
                        self.fragments.clear()
                        self.fragment_opcode = None
                else:
                    raise RuntimeError('WS_OPCODE_CONTRACT')
        except Exception as error:
            if self.expect_disconnect:
                self.c.event('ws-server-death-visible', client=self.client, reason=str(error))
            elif not self.stopping.is_set():
                self.error = str(error)
                self.c.reason = self.error
                self.c.failed.set()
                self.c.event('ws-error', client=self.client, reason=self.error)
        finally:
            self.closed_at = time.monotonic()

    def close(self):
        self.stopping.set()
        if self.sock:
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.sock.close()
            self.sock = None
        if hasattr(self, 'thread'):
            self.thread.join(timeout=3)
            if self.thread.is_alive():
                raise RuntimeError('WS_THREAD_NOT_CLOSED')
        self.closed_at = self.closed_at or time.monotonic()
        self.c.event('ws-closed', client=self.client, openMonotonic=self.connected_at,
                     closeMonotonic=self.closed_at, receivedStates=self.states, sentProjectionAcks=self.acks,
                     skippedProjectionSequences=self.gaps, error=self.error)
