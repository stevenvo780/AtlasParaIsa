#!/usr/bin/env python3
"""Persistent policy FP64 worker. Framed binary stdio, NVRTC --fmad=false.

No reductions across agents: each thread evaluates exactly one 12/8/12 network.
Equal contiguous index shards depend only on count and configured device order.
All CUDA storage, contexts, compiled modules and executor threads are reused.
"""
import argparse
import concurrent.futures
import ctypes as C
import json
import struct
import sys

SOURCE = r'''
__device__ double soft_sign(double x) {
    return __ddiv_rn(x, __dadd_rn(1.0, fabs(x)));
}
extern "C" __global__ void policy(const double* obs, const double* weights,
    const double* biases, double* out, unsigned long long count, int has_bias) {
    unsigned long long i = (unsigned long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= count) return;
    const double* w = weights + i * 212;
    const double* o = obs + i * 12;
    double hidden[8];
    for (int h = 0; h < 8; h++) {
        double z = w[96 + h];
        for (int j = 0; j < 12; j++) z = __dadd_rn(z, __dmul_rn(o[j], w[h * 12 + j]));
        hidden[h] = soft_sign(z);
    }
    for (int a = 0; a < 12; a++) {
        double z = w[200 + a];
        for (int h = 0; h < 8; h++) z = __dadd_rn(z, __dmul_rn(hidden[h], w[104 + a * 8 + h]));
        out[i * 12 + a] = soft_sign(__dadd_rn(z, has_bias ? biases[i * 12 + a] : 0.0));
    }
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


class Device:
    def __init__(self, index, nvrtc):
        self.context = None
        self.module = None
        self.ptrs = []
        self.capacity = 0
        driver = C.CDLL('libcuda.so.1')
        p, i, u, z, d = C.c_void_p, C.c_int, C.c_uint, C.c_size_t, C.c_uint64
        self.create = bind(driver, 'cuCtxCreate_v2', [C.POINTER(p), u, i])
        self.current = bind(driver, 'cuCtxSetCurrent', [p])
        self.destroy = bind(driver, 'cuCtxDestroy_v2', [p])
        self.alloc = bind(driver, 'cuMemAlloc_v2', [C.POINTER(d), z])
        self.free = bind(driver, 'cuMemFree_v2', [d])
        self.upload = bind(driver, 'cuMemcpyHtoD_v2', [d, p, z])
        self.download = bind(driver, 'cuMemcpyDtoH_v2', [p, d, z])
        self.synchronize = bind(driver, 'cuCtxSynchronize', [])
        self.launch = bind(driver, 'cuLaunchKernel', [p, u, u, u, u, u, u, u, p, C.POINTER(p), p])
        self.unload = bind(driver, 'cuModuleUnload', [p])
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
            self.kernel = p()
            checked(bind(driver, 'cuModuleGetFunction', [C.POINTER(p), p, C.c_char_p])(
                C.byref(self.kernel), self.module, b'policy'))
        except BaseException:
            self.close()
            raise

    def evaluate(self, body, output, count, begin, end, has_bias):
        n = end - begin
        if n == 0:
            return
        checked(self.current(self.context))
        if n > self.capacity:
            for ptr in self.ptrs:
                checked(self.free(ptr))
            self.ptrs = []
            self.capacity = 0
            for width in (12, 212, 12, 12):
                ptr = C.c_uint64()
                checked(self.alloc(C.byref(ptr), n * width * 8))
                self.ptrs.append(ptr)
            self.capacity = n
        # Data layout is observation rows, weight rows, optional lifetime bias rows.
        base = C.addressof((C.c_ubyte * len(body)).from_buffer(body))
        for slot, offset, width in ((0, begin * 12 * 8, 12),
                                   (1, (count * 12 + begin * 212) * 8, 212)):
            checked(self.upload(self.ptrs[slot], C.c_void_p(base + offset), n * width * 8))
        if has_bias:
            checked(self.upload(self.ptrs[2], C.c_void_p(base + (count * 224 + begin * 12) * 8), n * 12 * 8))
        values = self.ptrs + [C.c_uint64(n), C.c_int(has_bias)]
        args = (C.c_void_p * len(values))(*(C.cast(C.byref(v), C.c_void_p) for v in values))
        checked(self.launch(self.kernel, (n + 127) // 128, 1, 1, 128, 1, 1, 0, None, args, None))
        checked(self.synchronize())
        dest = C.addressof((C.c_ubyte * len(output)).from_buffer(output)) + begin * 12 * 8
        checked(self.download(C.c_void_p(dest), self.ptrs[3], n * 12 * 8))

    def close(self):
        if self.context and self.context.value:
            self.current(self.context)
            for ptr in self.ptrs:
                self.free(ptr)
            self.ptrs = []
            if self.module and self.module.value:
                self.unload(self.module)
                self.module = None
            self.destroy(self.context)
            self.context = None


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
    sys.stdout.buffer.write(struct.pack('<I', len(raw)))
    sys.stdout.buffer.write(raw)
    sys.stdout.buffer.write(body)
    sys.stdout.buffer.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--nvrtc', required=True)
    parser.add_argument('--devices', required=True)
    args = parser.parse_args()
    indices = [int(x) for x in args.devices.split(',')]
    if not indices or min(indices) < 0 or len(set(indices)) != len(indices):
        raise ValueError('Invalid policy devices')
    if sys.byteorder != 'little':
        raise RuntimeError('Policy protocol requires little endian FP64')
    devices = []
    try:
        for index in indices:
            devices.append(Device(index, args.nvrtc))
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(devices)) as pool:
            send({'ready': True, 'devices': indices, 'arch': [d.arch for d in devices]})
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
                if header.get('kind') == 'close':
                    break
                if header.get('kind') != 'evaluate':
                    raise ValueError('Unknown policy command')
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
    finally:
        for device in reversed(devices):
            device.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        send({'error': str(error)})
        sys.exit(1)
