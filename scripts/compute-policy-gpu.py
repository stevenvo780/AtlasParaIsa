#!/usr/bin/env python3
"""Persistent policy FP64 worker. Framed binary stdio, NVRTC --fmad=false.

No reductions across agents: each thread evaluates exactly one 12/8/12 network.
Legacy `evaluate` shards are equal and contiguous; `evaluate_resident` uses the
given shares or, by default, shares that follow each device's measured
throughput. Results never depend on the shard (one thread = one actor).
All CUDA storage, contexts, compiled modules and executor threads are reused.

Commands (4-byte little-endian header length + JSON header [+ body]):
  evaluate           legacy: obs + weights [+ biases] rows over the pipe.
  sync_weights       uploads (slots: uint32[k] padded to 8 B, rows: float64[k*212])
                     into the resident VRAM weight table of EVERY device (each
                     device holds the full slot-indexed table, so any subset of
                     deciding actors shards over all devices with zero weight
                     traffic). Geometric capacity growth; reset=true re-creates
                     the table (compaction).
  evaluate_resident  (slots: uint32[count] padded to 8 B, obs: float64[count*12]
                     [, biases: float64[count*12]]): ZERO weight bytes.
Bodies of the resident commands travel over the pipe or, with shm=true, through
the shared file given by --shm (written by Node at offset 0; the reply is placed
at a 64-byte aligned offset after the input and DMA'd straight into the mapping).
"""
import argparse
import concurrent.futures
import ctypes as C
import json
import mmap
import os
import struct
import sys
import time

try:
    import numpy as np
except ImportError:  # pragma: no cover - numpy is optional (validation only)
    np = None

W = 212
ROW = 12

SOURCE = r'''
__device__ double soft_sign(double x) {
    return __ddiv_rn(x, __dadd_rn(1.0, fabs(x)));
}
// Exact FP64 order of politica.ts evaluateRow: bias first, then left-to-right
// products, then lifetime bias. No FMA (--fmad=false and explicit _rn).
__device__ __forceinline__ void forward(const double* o, const double* w,
    const double* b, int has_bias, double* out) {
    double hidden[8];
    for (int h = 0; h < 8; h++) {
        double z = w[96 + h];
        for (int j = 0; j < 12; j++) z = __dadd_rn(z, __dmul_rn(o[j], w[h * 12 + j]));
        hidden[h] = soft_sign(z);
    }
    for (int a = 0; a < 12; a++) {
        double z = w[200 + a];
        for (int h = 0; h < 8; h++) z = __dadd_rn(z, __dmul_rn(hidden[h], w[104 + a * 8 + h]));
        out[a] = soft_sign(__dadd_rn(z, has_bias ? b[a] : 0.0));
    }
}
extern "C" __global__ void policy(const double* obs, const double* weights,
    const double* biases, double* out, unsigned long long count, int has_bias) {
    unsigned long long i = (unsigned long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= count) return;
    forward(obs + i * 12, weights + i * 212, biases + i * 12, has_bias, out + i * 12);
}
extern "C" __global__ void policy_resident(const unsigned int* slots, const double* obs,
    const double* table, const double* biases, double* out, unsigned long long count,
    int has_bias, unsigned long long capacity) {
    unsigned long long i = (unsigned long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= count) return;
    unsigned long long s = slots[i];
    if (s >= capacity) {  // memory guard only: the host validates every slot first
        for (int a = 0; a < 12; a++) out[i * 12 + a] = __longlong_as_double(0x7ff8000000000bad);
        return;
    }
    forward(obs + i * 12, table + s * 212, biases + i * 12, has_bias, out + i * 12);
}
extern "C" __global__ void scatter_rows(const unsigned int* slots, const double* rows,
    double* table, unsigned long long k, unsigned long long capacity) {
    unsigned long long t = (unsigned long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (t >= k * 212) return;
    unsigned long long r = t / 212, e = t - r * 212;
    unsigned long long s = slots[r];
    if (s < capacity) table[s * 212 + e] = rows[t];
}
'''


def bind(lib, name, args):
    fn = getattr(lib, name)
    fn.argtypes = args
    fn.restype = C.c_int
    return fn


def checked(status):
    if status:
        raise RuntimeError('Policy CUDA/NVRTC result ' + str(status))


def align(n, a):
    return (n + a - 1) // a * a


def compile_source(path, arch):
    lib = C.CDLL(path, mode=C.RTLD_GLOBAL)
    p, i, z = C.c_void_p, C.c_int, C.c_size_t
    create = bind(lib, 'nvrtcCreateProgram', [C.POINTER(p), C.c_char_p, C.c_char_p, i, p, p])
    compile_program = bind(lib, 'nvrtcCompileProgram', [p, i, C.POINTER(C.c_char_p)])
    destroy = bind(lib, 'nvrtcDestroyProgram', [C.POINTER(p)])
    program = p()
    checked(create(C.byref(program), SOURCE.encode(), b'policy.cu', 0, None, None))
    options = [f'--gpu-architecture={arch}'.encode(), b'--std=c++11', b'--fmad=false',
               b'--prec-div=true', b'--ftz=false']
    try:
        status = compile_program(program, len(options), (C.c_char_p * len(options))(*options))
        length = z()
        if status:
            checked(bind(lib, 'nvrtcGetProgramLogSize', [p, C.POINTER(z)])(program, C.byref(length)))
            log = C.create_string_buffer(length.value)
            checked(bind(lib, 'nvrtcGetProgramLog', [p, p])(program, log))
            raise RuntimeError(log.value.decode())
        checked(bind(lib, 'nvrtcGetPTXSize', [p, C.POINTER(z)])(program, C.byref(length)))
        ptx = C.create_string_buffer(length.value)
        checked(bind(lib, 'nvrtcGetPTX', [p, p])(program, ptx))
        return ptx
    finally:
        checked(destroy(C.byref(program)))


def address_of(buffer):
    """Host address of a writable bytearray / mmap (kept alive by the caller)."""
    return C.addressof((C.c_ubyte * len(buffer)).from_buffer(buffer))


class Device:
    def __init__(self, index, nvrtc):
        self.index = index
        self.context = None
        self.module = None
        self.ptrs = []
        self.capacity = 0
        self.scratch = {}
        self.table = None
        self.table_rows = 0
        driver = C.CDLL('libcuda.so.1')
        p, i, u, z, d = C.c_void_p, C.c_int, C.c_uint, C.c_size_t, C.c_uint64
        self.create = bind(driver, 'cuCtxCreate_v2', [C.POINTER(p), u, i])
        self.current = bind(driver, 'cuCtxSetCurrent', [p])
        self.destroy = bind(driver, 'cuCtxDestroy_v2', [p])
        self.alloc = bind(driver, 'cuMemAlloc_v2', [C.POINTER(d), z])
        self.free = bind(driver, 'cuMemFree_v2', [d])
        self.upload = bind(driver, 'cuMemcpyHtoD_v2', [d, p, z])
        self.download = bind(driver, 'cuMemcpyDtoH_v2', [p, d, z])
        self.copy = bind(driver, 'cuMemcpyDtoD_v2', [d, d, z])
        self.synchronize = bind(driver, 'cuCtxSynchronize', [])
        self.launch = bind(driver, 'cuLaunchKernel', [p, u, u, u, u, u, u, u, p, C.POINTER(p), p])
        self.unload = bind(driver, 'cuModuleUnload', [p])
        self.host_register = bind(driver, 'cuMemHostRegister_v2', [p, z, u])
        self.host_unregister = bind(driver, 'cuMemHostUnregister', [p])
        checked(bind(driver, 'cuInit', [u])(0))
        attribute = bind(driver, 'cuDeviceGetAttribute', [C.POINTER(i), i, i])
        major, minor = i(), i()
        checked(attribute(C.byref(major), 75, index))
        checked(attribute(C.byref(minor), 76, index))
        self.arch = f'compute_{major.value}{minor.value}'
        try:
            self.context = p()
            checked(self.create(C.byref(self.context), 0, index))
            ptx = compile_source(nvrtc, self.arch)
            self.module = p()
            checked(bind(driver, 'cuModuleLoadData', [C.POINTER(p), p])(C.byref(self.module), ptx))
            get = bind(driver, 'cuModuleGetFunction', [C.POINTER(p), p, C.c_char_p])
            self.kernel, self.kernel_resident, self.kernel_scatter = p(), p(), p()
            checked(get(C.byref(self.kernel), self.module, b'policy'))
            checked(get(C.byref(self.kernel_resident), self.module, b'policy_resident'))
            checked(get(C.byref(self.kernel_scatter), self.module, b'scatter_rows'))
        except BaseException:
            self.close()
            raise

    def _launch(self, kernel, threads, values):
        args = (C.c_void_p * len(values))(*(C.cast(C.byref(v), C.c_void_p) for v in values))
        checked(self.launch(kernel, (threads + 127) // 128, 1, 1, 128, 1, 1, 0, None, args, None))

    def _scratch(self, name, nbytes):
        """Reusable device buffer with geometric growth (never shrinks)."""
        ptr, cap = self.scratch.get(name, (None, 0))
        if nbytes <= cap:
            return ptr
        new_cap = max(nbytes, cap * 2, 1 << 16)
        if ptr is not None:
            checked(self.free(ptr))
            del self.scratch[name]
        ptr = C.c_uint64()
        checked(self.alloc(C.byref(ptr), new_cap))
        self.scratch[name] = (ptr, new_cap)
        return ptr

    def evaluate(self, body, output, count, begin, end, has_bias):
        n = end - begin
        if n == 0:
            return
        checked(self.current(self.context))
        if n > self.capacity:
            new_cap = max(n, self.capacity * 2, 64)
            for ptr in self.ptrs:
                checked(self.free(ptr))
            self.ptrs = []
            self.capacity = 0
            for width in (12, 212, 12, 12):
                ptr = C.c_uint64()
                checked(self.alloc(C.byref(ptr), new_cap * width * 8))
                self.ptrs.append(ptr)
            self.capacity = new_cap
        # Data layout is observation rows, weight rows, optional lifetime bias rows.
        base = address_of(body)
        for slot, offset, width in ((0, begin * 12 * 8, 12),
                                   (1, (count * 12 + begin * 212) * 8, 212)):
            checked(self.upload(self.ptrs[slot], C.c_void_p(base + offset), n * width * 8))
        if has_bias:
            checked(self.upload(self.ptrs[2], C.c_void_p(base + (count * 224 + begin * 12) * 8), n * 12 * 8))
        self._launch(self.kernel, n, self.ptrs + [C.c_uint64(n), C.c_int(has_bias)])
        checked(self.synchronize())
        dest = address_of(output) + begin * 12 * 8
        checked(self.download(C.c_void_p(dest), self.ptrs[3], n * 12 * 8))

    def ensure_table(self, rows, reset):
        """Resident slot-indexed weight table. reset re-creates it with exactly
        `rows` rows (compaction); growth is geometric and preserves contents."""
        if reset:
            if self.table is not None:
                checked(self.free(self.table))
            self.table, self.table_rows = None, 0
            ptr = C.c_uint64()
            checked(self.alloc(C.byref(ptr), max(rows, 1) * W * 8))
            self.table, self.table_rows = ptr, max(rows, 1)
            return
        if rows <= self.table_rows:
            return
        new_rows = max(rows, self.table_rows * 2, 1024)
        ptr = C.c_uint64()
        checked(self.alloc(C.byref(ptr), new_rows * W * 8))
        if self.table is not None:
            checked(self.copy(ptr, self.table, self.table_rows * W * 8))
            checked(self.free(self.table))
        self.table, self.table_rows = ptr, new_rows

    def sync(self, base, k, rows, reset):
        checked(self.current(self.context))
        self.ensure_table(rows, reset)
        if k:
            slot_bytes = align(k * 4, 8)
            d_slots = self._scratch('sync_slots', k * 4)
            d_rows = self._scratch('sync_rows', k * W * 8)
            checked(self.upload(d_slots, C.c_void_p(base), k * 4))
            checked(self.upload(d_rows, C.c_void_p(base + slot_bytes), k * W * 8))
            self._launch(self.kernel_scatter, k * W,
                         [d_slots, d_rows, self.table, C.c_uint64(k), C.c_uint64(self.table_rows)])
        checked(self.synchronize())
        return self.table_rows

    def evaluate_resident(self, base, count, begin, end, has_bias, out_base):
        started = time.perf_counter()
        n = end - begin
        if n == 0:
            return 0.0
        checked(self.current(self.context))
        slot_bytes = align(count * 4, 8)
        d_slots = self._scratch('slots', n * 4)
        d_obs = self._scratch('obs', n * ROW * 8)
        d_bias = self._scratch('bias', n * ROW * 8)
        d_out = self._scratch('out', n * ROW * 8)
        checked(self.upload(d_slots, C.c_void_p(base + begin * 4), n * 4))
        checked(self.upload(d_obs, C.c_void_p(base + slot_bytes + begin * ROW * 8), n * ROW * 8))
        if has_bias:
            checked(self.upload(d_bias, C.c_void_p(base + slot_bytes + (count + begin) * ROW * 8), n * ROW * 8))
        self._launch(self.kernel_resident, n,
                     [d_slots, d_obs, self.table, d_bias, d_out, C.c_uint64(n),
                      C.c_int(has_bias), C.c_uint64(self.table_rows)])
        checked(self.synchronize())
        checked(self.download(C.c_void_p(out_base + begin * ROW * 8), d_out, n * ROW * 8))
        return (time.perf_counter() - started) * 1000

    def close(self):
        if self.context and self.context.value:
            self.current(self.context)
            for ptr in self.ptrs:
                self.free(ptr)
            self.ptrs = []
            for ptr, _ in self.scratch.values():
                self.free(ptr)
            self.scratch = {}
            if self.table is not None:
                self.free(self.table)
                self.table = None
            if self.module and self.module.value:
                self.unload(self.module)
                self.module = None
            self.destroy(self.context)
            self.context = None


class SharedFile:
    """Frame exchange through a file the Node host created (normally on /dev/shm).
    Node writes inputs with pwrite at offset 0; this process maps the file and DMAs
    straight from/to the mapping, so the resident payload is never re-copied here."""

    def __init__(self, path, pin=None):
        # pin: (context, register, unregister) of the first device. The mapping is
        # page-locked as PORTABLE (visible to every context), so each device DMAs
        # straight from/to it; if the driver refuses, transfers stay pageable.
        self.pin = pin
        self.pinned = False
        self.fd = os.open(path, os.O_RDWR)
        self.mm = None
        self.anchor = None
        self.capacity = 0
        self.ensure(1 << 20)

    def ensure(self, nbytes):
        if nbytes <= self.capacity and self.mm is not None:
            return
        cap = max(nbytes, self.capacity * 2, 1 << 20, os.fstat(self.fd).st_size)
        cap = align(cap, mmap.PAGESIZE)
        self.release()
        os.ftruncate(self.fd, cap)
        self.mm = mmap.mmap(self.fd, cap)
        self.anchor = (C.c_ubyte * cap).from_buffer(self.mm)
        self.capacity = cap
        if self.pin is not None:
            context, register, _ = self.pin
            checked(context())
            self.pinned = register(C.c_void_p(self.address), cap, 1) == 0  # CU_MEMHOSTREGISTER_PORTABLE

    @property
    def address(self):
        return C.addressof(self.anchor)

    def release(self):
        if self.pinned and self.anchor is not None:
            context, _, unregister = self.pin
            context()
            unregister(C.c_void_p(self.address))
        self.pinned = False
        self.anchor = None
        if self.mm is not None:
            self.mm.close()
            self.mm = None

    def close(self):
        try:
            self.release()
        finally:
            os.close(self.fd)


def read_exact(n):
    result = bytearray(n)
    view = memoryview(result)
    offset = 0
    while offset < n:
        got = sys.stdin.buffer.readinto(view[offset:])
        if not got:
            raise EOFError('Truncated policy frame')
        offset += got
    return result


def send(header, body=b''):
    raw = json.dumps(header, separators=(',', ':')).encode()
    out = sys.stdout.buffer
    out.write(struct.pack('<I', len(raw)) + raw)
    if len(body):
        out.write(body)
    out.flush()


def bounds(count, n_devices, shares):
    if shares is None:
        return [(count * i // n_devices, count * (i + 1) // n_devices) for i in range(n_devices)]
    if (type(shares) is not list or len(shares) != n_devices
            or any(type(s) not in (int, float) or not s > 0 or s == float('inf') for s in shares)):
        raise ValueError('Invalid policy shares')
    total, acc, begin, result = float(sum(shares)), 0.0, 0, []
    for i, share in enumerate(shares):
        acc += share
        end = count if i == n_devices - 1 else min(count, max(begin, int(round(count * acc / total))))
        result.append((begin, end))
        begin = end
    return result


class Balancer:
    """Adaptive contiguous shards for evaluate_resident when no shares are given:
    each device's share follows its measured throughput (rows/ms, EMA). Shards
    only move work between devices; results are identical whatever the split."""
    MIN_ROWS = 256

    def __init__(self, n):
        self.rates = [1.0] * n

    def shares(self):
        # Floor of 5 % of the fastest device, so a slower device keeps receiving
        # enough rows to be re-measured (and recover) on large batches.
        floor = 0.05 * max(self.rates)
        return [max(rate, floor) for rate in self.rates]

    def update(self, shards, device_ms):
        for i, ((begin, end), ms) in enumerate(zip(shards, device_ms)):
            if end - begin >= self.MIN_ROWS and ms > 0:
                rate = (end - begin) / ms
                self.rates[i] = rate if self.rates[i] == 1.0 else 0.7 * self.rates[i] + 0.3 * rate


class SlotTable:
    """Host bookkeeping of which resident rows were written (validation only)."""

    def __init__(self):
        self.rows = 0
        self.valid = np.zeros(0, dtype=bool) if np is not None else bytearray()

    def resize(self, rows, reset):
        if np is not None:
            if reset:
                self.valid = np.zeros(rows, dtype=bool)
            elif rows > len(self.valid):
                grown = np.zeros(rows, dtype=bool)
                grown[:len(self.valid)] = self.valid
                self.valid = grown
        else:
            if reset:
                self.valid = bytearray(rows)
            elif rows > len(self.valid):
                self.valid.extend(bytes(rows - len(self.valid)))
        self.rows = rows

    @staticmethod
    def validate(body, k, rows):
        """Before any device write: slots in range and unique (a duplicate would make
        the scatter order-dependent)."""
        if not k:
            return
        if np is not None:
            slots = np.frombuffer(body, dtype='<u4', count=k)
            if int(slots.max()) >= rows or np.unique(slots).size != k:
                raise ValueError('Invalid or duplicated resident slots')
        else:
            slots = memoryview(body)[:k * 4].cast('I')
            if max(slots) >= rows or len(set(slots)) != k:
                raise ValueError('Invalid or duplicated resident slots')

    def mark(self, body, k):
        if np is not None:
            self.valid[np.frombuffer(body, dtype='<u4', count=k)] = True
        else:
            for s in memoryview(body)[:k * 4].cast('I'):
                self.valid[s] = 1

    def check(self, body, count):
        if not count:
            return
        if np is not None:
            slots = np.frombuffer(body, dtype='<u4', count=count)
            if int(slots.max()) >= self.rows or not bool(self.valid[slots].all()):
                raise ValueError('Unsynchronised resident slot')
        else:
            slots = memoryview(body)[:count * 4].cast('I')
            if max(slots) >= self.rows or not all(self.valid[s] for s in slots):
                raise ValueError('Unsynchronised resident slot')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--nvrtc', required=True)
    parser.add_argument('--devices', required=True)
    parser.add_argument('--shm', default=None)
    args = parser.parse_args()
    indices = [int(x) for x in args.devices.split(',')]
    if not indices or min(indices) < 0 or len(set(indices)) != len(indices):
        raise ValueError('Invalid policy devices')
    if sys.byteorder != 'little':
        raise RuntimeError('Policy protocol requires little endian FP64')
    devices = []
    shared = None
    try:
        for index in indices:
            devices.append(Device(index, args.nvrtc))
        if args.shm:
            first = devices[0]
            pin = None if os.environ.get('ATLAS_POLICY_NO_PIN') else (
                lambda: first.current(first.context), first.host_register, first.host_unregister)
            shared = SharedFile(args.shm, pin)
        table = SlotTable()
        balancer = Balancer(len(devices))
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(devices)) as pool:
            send({'ready': True, 'devices': indices, 'arch': [d.arch for d in devices],
                  'protocol': 2, 'resident': True, 'shm': shared is not None,
                  'pinned': bool(shared and shared.pinned)})
            while True:
                prefix = sys.stdin.buffer.read(4)
                if not prefix:
                    break
                if len(prefix) != 4:
                    raise EOFError('Truncated policy prefix')
                size, = struct.unpack('<I', prefix)
                if size > 65536:
                    raise ValueError('Oversized policy header')
                header = json.loads(read_exact(size))
                kind = header.get('kind')
                if kind == 'close':
                    break
                if kind == 'evaluate':
                    count, has_bias = header['count'], header['biases']
                    if type(count) is not int or count < 0 or type(has_bias) is not bool:
                        raise ValueError('Invalid policy batch')
                    body = read_exact(count * (224 + (12 if has_bias else 0)) * 8)
                    output = bytearray(count * 12 * 8)
                    jobs = [pool.submit(device.evaluate, body, output, count,
                                        count * i // len(devices), count * (i + 1) // len(devices), has_bias)
                            for i, device in enumerate(devices)]
                    # Assemble at each original index, never in completion order.
                    for job in jobs:
                        job.result()
                    send({'bytes': len(output)}, output)
                    continue
                use_shm = header.get('shm', False)
                if type(use_shm) is not bool or (use_shm and shared is None):
                    raise ValueError('Invalid policy transport')
                if kind == 'sync_weights':
                    k, rows, reset = header['count'], header['capacity'], header.get('reset', False)
                    if (type(k) is not int or k < 0 or type(rows) is not int or rows < 1
                            or rows > 1 << 26 or type(reset) is not bool):
                        raise ValueError('Invalid policy sync')
                    nbytes = align(k * 4, 8) + k * W * 8
                    if use_shm:
                        shared.ensure(nbytes)
                        body, base = shared.mm, shared.address
                    else:
                        body = read_exact(nbytes)
                        base = address_of(body) if nbytes else 0
                    table.validate(body, k, rows)
                    jobs = [pool.submit(device.sync, base, k, rows, reset) for device in devices]
                    capacities = [job.result() for job in jobs]
                    table.resize(min(capacities), reset)
                    table.mark(body, k)
                    send({'ok': True, 'capacity': table.rows, 'uploadedBytes': nbytes * len(devices)})
                    continue
                if kind == 'evaluate_resident':
                    started = time.perf_counter()
                    count, has_bias = header['count'], header['biases']
                    if type(count) is not int or count < 0 or type(has_bias) is not bool:
                        raise ValueError('Invalid policy batch')
                    in_bytes = align(count * 4, 8) + count * (24 if has_bias else 12) * 8
                    out_bytes = count * ROW * 8
                    if use_shm:
                        out_offset = align(in_bytes, 64)
                        shared.ensure(out_offset + out_bytes)
                        body, base = shared.mm, shared.address
                        output, out_base = None, base + out_offset
                    else:
                        body = read_exact(in_bytes)
                        base = address_of(body) if in_bytes else 0
                        output = bytearray(out_bytes)
                        out_base = address_of(output) if out_bytes else 0
                    table.check(body, count)
                    fixed = header.get('shares')
                    shards = bounds(count, len(devices), fixed if fixed is not None else balancer.shares())
                    jobs = [pool.submit(device.evaluate_resident, base, count, begin, end, has_bias, out_base)
                            for device, (begin, end) in zip(devices, shards)]
                    device_ms = [job.result() for job in jobs]
                    if fixed is None:
                        balancer.update(shards, device_ms)
                    reply = {'shards': [end - begin for begin, end in shards], 'deviceMs': device_ms,
                             'serverMs': (time.perf_counter() - started) * 1000}
                    if use_shm:
                        send({**reply, 'bytes': 0, 'shmBytes': out_bytes, 'offset': out_offset})
                    else:
                        send({**reply, 'bytes': out_bytes}, output)
                    continue
                raise ValueError('Unknown policy command')
    finally:
        if shared is not None:
            shared.close()  # unregister the pinned mapping while the context still exists
        for device in reversed(devices):
            device.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        send({'error': str(error)})
        sys.exit(1)
