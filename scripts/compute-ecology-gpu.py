#!/usr/bin/env python3
"""Private benchmark worker. Binary stdio; no environment or process inventory.

Uses only the NVIDIA driver, an explicitly supplied NVRTC library and numpy.
Two GPUs receive identical complete old states, then return disjoint partitions.
All duplicated upload traffic and final assembly are measured, never hidden.
"""
import argparse
import concurrent.futures
import ctypes as C
import json
import pathlib
import struct
import sys
import time
import numpy as np

clock = time.perf_counter

def bind(lib, name, args):
    fn = getattr(lib, name)
    fn.argtypes = args
    fn.restype = C.c_int
    return fn

def checked(value):
    if value != 0:
        raise RuntimeError('CUDA/NVRTC result ' + str(value))

class Device:
    def __init__(self, index, nvrtc, source):
        started = clock()
        self.driver = C.CDLL('libcuda.so.1')
        p, i, u, z, d = C.c_void_p, C.c_int, C.c_uint, C.c_size_t, C.c_uint64
        self.init = bind(self.driver, 'cuInit', [u])
        self.create = bind(self.driver, 'cuCtxCreate_v2', [C.POINTER(p), u, i])
        self.current = bind(self.driver, 'cuCtxSetCurrent', [p])
        self.destroy = bind(self.driver, 'cuCtxDestroy_v2', [p])
        self.alloc = bind(self.driver, 'cuMemAlloc_v2', [C.POINTER(d), z])
        self.free = bind(self.driver, 'cuMemFree_v2', [d])
        self.upload = bind(self.driver, 'cuMemcpyHtoD_v2', [d, p, z])
        self.download = bind(self.driver, 'cuMemcpyDtoH_v2', [p, d, z])
        self.sync = bind(self.driver, 'cuCtxSynchronize', [])
        self.load = bind(self.driver, 'cuModuleLoadData', [C.POINTER(p), p])
        self.function = bind(self.driver, 'cuModuleGetFunction', [C.POINTER(p), p, C.c_char_p])
        self.launch = bind(self.driver, 'cuLaunchKernel', [p,u,u,u,u,u,u,u,p,C.POINTER(p),p])
        self.event_create = bind(self.driver, 'cuEventCreate', [C.POINTER(p),u])
        self.event_record = bind(self.driver, 'cuEventRecord', [p,p])
        self.event_elapsed = bind(self.driver, 'cuEventElapsedTime', [C.POINTER(C.c_float),p,p])
        self.event_destroy = bind(self.driver, 'cuEventDestroy_v2', [p])
        self.attribute = bind(self.driver, 'cuDeviceGetAttribute', [C.POINTER(i), i, i])
        checked(self.init(0))
        major, minor = i(), i()
        checked(self.attribute(C.byref(major), 75, index)); checked(self.attribute(C.byref(minor), 76, index))
        self.arch = f'compute_{major.value}{minor.value}'
        self.context = p(); checked(self.create(C.byref(self.context), 0, index))
        self.start_event=p();self.end_event=p()
        checked(self.event_create(C.byref(self.start_event),0));checked(self.event_create(C.byref(self.end_event),0))
        self.context_ms = (clock() - started) * 1000
        compile_start = clock()
        lib = C.CDLL(nvrtc, mode=C.RTLD_GLOBAL)
        make = bind(lib, 'nvrtcCreateProgram', [C.POINTER(p),C.c_char_p,C.c_char_p,i,p,p])
        compile_program = bind(lib, 'nvrtcCompileProgram', [p,i,C.POINTER(C.c_char_p)])
        size = bind(lib, 'nvrtcGetPTXSize', [p,C.POINTER(z)])
        get = bind(lib, 'nvrtcGetPTX', [p,p])
        destroy_program = bind(lib, 'nvrtcDestroyProgram', [C.POINTER(p)])
        program = p(); checked(make(C.byref(program), source.encode(), b'ecology.cu', 0, None, None))
        options = [f'--gpu-architecture={self.arch}'.encode(), b'--fmad=false', b'--std=c++11']
        status = compile_program(program, len(options), (C.c_char_p*len(options))(*options))
        if status:
            log_size = bind(lib,'nvrtcGetProgramLogSize',[p,C.POINTER(z)])
            get_log = bind(lib,'nvrtcGetProgramLog',[p,p])
            length=z(); log_size(program,C.byref(length)); log=C.create_string_buffer(length.value)
            get_log(program,log); raise RuntimeError(log.value.decode())
        length=z(); checked(size(program,C.byref(length))); ptx=C.create_string_buffer(length.value)
        checked(get(program,ptx)); checked(destroy_program(C.byref(program)))
        self.compile_ms=(clock()-compile_start)*1000
        load_start=clock(); self.module=p(); checked(self.load(C.byref(self.module),ptx))
        self.kernel=p(); checked(self.function(C.byref(self.kernel),self.module,b'ecology'))
        self.load_ms=(clock()-load_start)*1000
        self.index=index; self.pointers=[]; self.n=0

    def setup(self,n,neighbors,begin,end):
        checked(self.current(self.context))
        for pointer in self.pointers: checked(self.free(pointer))
        self.pointers=[]; self.n=n; self.begin=begin; self.end=end
        started=clock()
        for amount in [n*15*8,(end-begin)*15*8,n*8*4]:
            pointer=C.c_uint64(); checked(self.alloc(C.byref(pointer),amount)); self.pointers.append(pointer)
        self.result=np.empty((15,end-begin),dtype=np.float64)
        checked(self.upload(self.pointers[2],neighbors.ctypes.data,neighbors.nbytes))
        return {'index':self.index,'allocationAndTopologyUploadMs':(clock()-started)*1000,'residentBytes':n*15*8+(end-begin)*15*8+n*8*4}

    def step(self,data,tick,rain,light):
        checked(self.current(self.context))
        started=clock(); checked(self.upload(self.pointers[0],data.ctypes.data,data.nbytes))
        upload_end=clock()
        values=[self.pointers[0],self.pointers[1],self.pointers[2],C.c_int(self.n),C.c_int(tick),C.c_int(rain),C.c_double(light),C.c_int(self.begin),C.c_int(self.end)]
        args=(C.c_void_p*len(values))(*(C.cast(C.byref(value),C.c_void_p) for value in values))
        checked(self.event_record(self.start_event,None))
        checked(self.launch(self.kernel,(self.end-self.begin+255)//256,1,1,256,1,1,0,None,args,None))
        checked(self.event_record(self.end_event,None))
        checked(self.sync()); kernel_end=clock()
        checked(self.download(self.result.ctypes.data,self.pointers[1],self.result.nbytes)); end=clock()
        event_ms=C.c_float();checked(self.event_elapsed(C.byref(event_ms),self.start_event,self.end_event))
        return {'index':self.index,'uploadMs':(upload_end-started)*1000,'eventKernelMs':event_ms.value,'launchAndKernelSyncMs':(kernel_end-upload_end)*1000,'downloadMs':(end-kernel_end)*1000,'driverRoundTripMs':(end-started)*1000,'uploadedBytes':data.nbytes,'downloadedBytes':self.result.nbytes}

    def close(self):
        checked(self.current(self.context))
        for pointer in self.pointers: checked(self.free(pointer))
        checked(self.event_destroy(self.start_event));checked(self.event_destroy(self.end_event))
        checked(self.destroy(self.context))

def read_exact(n):
    result=bytearray(n); view=memoryview(result); offset=0
    while offset<n:
        count=sys.stdin.buffer.readinto(view[offset:])
        if not count: raise EOFError()
        offset+=count
    return result

def emit(header,body=None):
    header={**header,'bytes':0 if body is None else body.nbytes}
    raw=json.dumps(header,separators=(',',':')).encode()
    sys.stdout.buffer.write(struct.pack('<I',len(raw))); sys.stdout.buffer.write(raw)
    if body is not None: sys.stdout.buffer.write(memoryview(body).cast('B'))
    sys.stdout.buffer.flush()

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--devices',required=True); parser.add_argument('--nvrtc',required=True)
    args=parser.parse_args(); indices=[int(x) for x in args.devices.split(',')]
    if indices not in [[0],[1],[0,1]]: raise ValueError('Unsupported device selection')
    source=pathlib.Path(__file__).with_name('compute-ecology.cu').read_text()
    devices=[]
    try:
        for index in indices: devices.append(Device(index,args.nvrtc,source))
        emit({'ready':True,'devices':[{'index':d.index,'architecture':d.arch,'contextMs':d.context_ms,'compileMs':d.compile_ms,'moduleLoadMs':d.load_ms} for d in devices],'precision':'Float64','fmad':False})
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(devices)) as executor:
            while True:
                length=struct.unpack('<I',read_exact(4))[0]
                if length>65536: raise ValueError('Oversized header')
                request=json.loads(read_exact(length)); amount=request.get('bytes',0)
                if amount<0 or amount>120_000_000: raise ValueError('Oversized body')
                data=read_exact(amount)
                if request['kind']=='close': break
                if request['kind']=='setup':
                    n=request['n']
                    if not isinstance(n,int) or n<1 or n>1_000_000 or amount!=n*8*4: raise ValueError('Invalid topology')
                    neighbors=np.frombuffer(data,dtype=np.int32)
                    if np.any(neighbors < -1) or np.any(neighbors >= n): raise ValueError('Invalid neighbor index')
                    started=clock(); parts=[]
                    for j,d in enumerate(devices): parts.append(d.setup(n,neighbors,n*j//len(devices),n*(j+1)//len(devices)))
                    output=np.empty((15,n),dtype=np.float64)
                    emit({'setupMs':(clock()-started)*1000,'devices':parts})
                elif request['kind']=='step':
                    if not devices[0].n or amount!=devices[0].n*15*8: raise ValueError('Invalid input shape')
                    input_state=np.frombuffer(data,dtype=np.float64)
                    started=clock()
                    futures=[executor.submit(d.step,input_state,request['tick'],int(request['rain']),request['light']) for d in devices]
                    phases=[future.result() for future in futures]
                    assembly=clock()
                    for d in devices: output[:,d.begin:d.end]=d.result
                    emit({'gpuAndAssemblyMs':(clock()-started)*1000,'assemblyMs':(clock()-assembly)*1000,'devices':phases},output)
                else: raise ValueError('Unknown operation')
    finally:
        for device in devices: device.close()

if __name__=='__main__':
    try: main()
    except EOFError: pass
    except Exception as error:
        emit({'error':str(error)}); sys.exit(1)
