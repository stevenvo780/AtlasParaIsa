#!/usr/bin/env python3
"""Persistent resident GPU worker for T122. Binary stdio, FP64, --fmad=false.

Buffers stay in VRAM between steps. Node uploads either a full topology+front
sync or only dirty pages, launches ecology_pass1/ecology_pass2, and downloads
back pages for the ranges each device computed. No 1M-cell / 120MB caps:
MAX_CELLS is the antic-corruption bound from the task.
"""
import argparse, concurrent.futures, ctypes as C, json, pathlib, struct, sys, time
import numpy as np
clock = time.perf_counter
MAX_CELLS = 33_554_432
FIELDS = [('moisture',8),('vegetation',8),('food',8),('wood',8),('growth',8),('fertility',8),('cultivation',8),('traffic',8),('drinkingWater',8),('terrain',1),('biome',1),('feature',1),('life',8)]

def bind(lib, name, args):
    fn = getattr(lib, name); fn.argtypes = args; fn.restype = C.c_int; return fn
def checked(v):
    if v != 0: raise RuntimeError('CUDA/NVRTC result ' + str(v))

class Device:
    def __init__(self, index, nvrtc, source):
        started = clock()
        self.driver = C.CDLL('libcuda.so.1')
        p,i,u,z,d = C.c_void_p, C.c_int, C.c_uint, C.c_size_t, C.c_uint64
        self._p,self._d = p,d
        self.init = bind(self.driver,'cuInit',[u]); self.create = bind(self.driver,'cuCtxCreate_v2',[C.POINTER(p),u,i])
        self.current = bind(self.driver,'cuCtxSetCurrent',[p]); self.destroy = bind(self.driver,'cuCtxDestroy_v2',[p])
        self.alloc = bind(self.driver,'cuMemAlloc_v2',[C.POINTER(d),z]); self.free = bind(self.driver,'cuMemFree_v2',[d])
        self.upload_fn = bind(self.driver,'cuMemcpyHtoD_v2',[d,p,z]); self.download_fn = bind(self.driver,'cuMemcpyDtoH_v2',[p,d,z])
        self.sync_fn = bind(self.driver,'cuCtxSynchronize',[]); self.load = bind(self.driver,'cuModuleLoadData',[C.POINTER(p),p])
        self.function = bind(self.driver,'cuModuleGetFunction',[C.POINTER(p),p,C.c_char_p])
        self.launch = bind(self.driver,'cuLaunchKernel',[p,u,u,u,u,u,u,u,p,C.POINTER(p),p])
        self.attribute = bind(self.driver,'cuDeviceGetAttribute',[C.POINTER(i),i,i])
        checked(self.init(0))
        major,minor = i(),i(); checked(self.attribute(C.byref(major),75,index)); checked(self.attribute(C.byref(minor),76,index))
        self.arch = f'compute_{major.value}{minor.value}'
        self.context = p(); checked(self.create(C.byref(self.context),0,index))
        self.context_ms = (clock()-started)*1000
        cs = clock(); lib = C.CDLL(nvrtc, mode=C.RTLD_GLOBAL)
        make = bind(lib,'nvrtcCreateProgram',[C.POINTER(p),C.c_char_p,C.c_char_p,i,p,p]); comp = bind(lib,'nvrtcCompileProgram',[p,i,C.POINTER(C.c_char_p)])
        size = bind(lib,'nvrtcGetPTXSize',[p,C.POINTER(z)]); get = bind(lib,'nvrtcGetPTX',[p,p]); dest = bind(lib,'nvrtcDestroyProgram',[C.POINTER(p)])
        prog = p(); checked(make(C.byref(prog), source.encode(), b'compute-ecology-resident.cu', 0, None, None))
        opts = [f'--gpu-architecture={self.arch}'.encode(), b'--fmad=false', b'--std=c++11']
        st = comp(prog, len(opts), (C.c_char_p*len(opts))(*opts))
        if st:
            lsz = bind(lib,'nvrtcGetProgramLogSize',[p,C.POINTER(z)]); glog = bind(lib,'nvrtcGetProgramLog',[p,p])
            ln=z(); lsz(prog,C.byref(ln)); log=C.create_string_buffer(ln.value); glog(prog,log); raise RuntimeError(log.value.decode())
        ln=z(); checked(size(prog,C.byref(ln))); ptx=C.create_string_buffer(ln.value); checked(get(prog,ptx)); checked(dest(C.byref(prog)))
        self.compile_ms=(clock()-cs)*1000
        self.module=p(); checked(self.load(C.byref(self.module),ptx))
        self.k1=p(); checked(self.function(C.byref(self.k1),self.module,b'ecology_pass1'))
        self.k2=p(); checked(self.function(C.byref(self.k2),self.module,b'ecology_pass2'))
        self.kcopy=p(); checked(self.function(C.byref(self.kcopy),self.module,b'copy_front_to_back'))
        self.index=index; self.ptrs={}; self.capacity=0; self.slots=0; self.total=0; self.cells=None
    def _alloc(self, name, nbytes):
        ptr=C.c_uint64(); checked(self.alloc(C.byref(ptr), max(1,int(nbytes)))); self.ptrs[name]=ptr
    def _up(self, ptr, host_addr, nbytes, offset=0):
        if nbytes: checked(self.upload_fn(C.c_uint64(ptr.value+offset), C.c_void_p(host_addr), int(nbytes)))
    def _down(self, host_addr, ptr, nbytes, offset=0):
        if nbytes: checked(self.download_fn(C.c_void_p(host_addr), C.c_uint64(ptr.value+offset), int(nbytes)))
    def sync(self, arrays, capacity, slots, total):
        checked(self.current(self.context)); started=clock()
        for ptr in self.ptrs.values(): checked(self.free(ptr))
        self.ptrs={}; self.capacity=capacity; self.slots=slots; self.total=total; self.cells=arrays['cells']
        # topology
        self._alloc('cells', total*4); self._alloc('stamps', capacity*4); self._alloc('around', slots*9*4)
        self._alloc('pageX', slots*4); self._alloc('pageY', slots*4); self._alloc('woodAdded', slots)
        uploaded=0
        for name,key,dt in [('cells','cells',np.int32),('stamps','stamps',np.uint32),('around','around',np.int32),('pageX','pageX',np.int32),('pageY','pageY',np.int32)]:
            a=arrays[key]; self._up(self.ptrs[name], a.ctypes.data, a.nbytes); uploaded+=a.nbytes
        for fname,esz in FIELDS:
            self._alloc(fname+'F', capacity*esz); self._alloc(fname+'B', capacity*esz)
            a=arrays[fname]; self._up(self.ptrs[fname+'F'], a.ctypes.data, a.nbytes); uploaded+=a.nbytes
        resident = sum(int(v.value and capacity) for v in []) # placeholder no-op
        resident_bytes = capacity*sum(e for _,e in FIELDS)*2 + total*4 + capacity*4 + slots*9*4 + slots*9
        return {'index':self.index,'uploadedBytes':uploaded,'syncMs':(clock()-started)*1000,'residentBytes':resident_bytes}
    def step(self, req, body_addr, dirty, ranges_by_device, halo=None):
        checked(self.current(self.context)); started=clock(); uploaded=0
        # dirty upload: body layout slot-major, field-minor chunks of 256 cells
        offset=0
        for slot in dirty:
            for fname,esz in FIELDS:
                nbytes=256*esz; self._up(self.ptrs[fname+'F'], body_addr+offset, nbytes, slot*256*esz); offset+=nbytes; uploaded+=nbytes
        if req['pass']==2:
            wood_arr = req.pop('_wood_arr')
            self._up(self.ptrs['woodAdded'], wood_arr.ctypes.data, wood_arr.nbytes); uploaded+=wood_arr.nbytes; offset+=wood_arr.nbytes
        if halo:
            halo_slots, halo_field, halo_offset = halo
            esz = dict(FIELDS)[halo_field]
            for j,slot in enumerate(halo_slots):
                nbytes=256*esz; self._up(self.ptrs[halo_field+'F'], body_addr+halo_offset+j*nbytes, nbytes, slot*256*esz); uploaded+=nbytes
        begin,end = ranges_by_device
        p = req['params']
        # Build kernel args
        front=[self.ptrs[f+'F'] for f,_ in FIELDS]; back=[self.ptrs[f+'B'] for f,_ in FIELDS]
        topo=[self.ptrs['cells'],self.ptrs['stamps'],self.ptrs['around']]
        vals=[]
        if req['pass']==1:
            vals = topo + front + back + [C.c_int(begin),C.c_int(end),C.c_uint(p['version']),C.c_int(p['rain']),C.c_double(p['light']),C.c_double(p['capacidadBosque']),C.c_double(p['capacidadPastizal']),C.c_double(p['capacidadOtros']),C.c_double(p['velocidadRegeneracion']),C.c_double(p['decaimientoComida'])]
            kern=self.k1
        else:
            vals = topo + [self.ptrs['pageX'],self.ptrs['pageY'],self.ptrs['woodAdded']] + front + back + [C.c_int(begin),C.c_int(end),C.c_int(p['tick']),C.c_uint(p['version']),C.c_int(p['rain']),C.c_double(p['light']),C.c_double(p['decaimientoFertilidad']),C.c_uint(p['seed']),C.c_double(p['cuencas'])]
            kern=self.k2
        args=(C.c_void_p*len(vals))(*(C.cast(C.byref(v),C.c_void_p) for v in vals))
        count=max(0,end-begin); grid=(count+255)//256
        ks=clock()
        checked(self.launch(kern,grid,1,1,256,1,1,0,None,args,None)); checked(self.sync_fn()); kernel_ms=(clock()-ks)*1000
        # download slots for this range
        if count:
            cells_slice=self.cells[begin:end]; slots_sorted=sorted(set((cells_slice>>8).tolist()))
        else: slots_sorted=[]
        total_dl=sum(256*esz for _,esz in FIELDS)*len(slots_sorted)
        staging=np.empty(total_dl,dtype=np.uint8); downloaded=0; off=0
        for slot in slots_sorted:
            for fname,esz in FIELDS:
                nbytes=256*esz; self._down(staging.ctypes.data+off, self.ptrs[fname+'B'], nbytes, slot*256*esz); off+=nbytes; downloaded+=nbytes
        # Logical front becomes the back just computed, matching TileStore.commitParallel parity swap.
        for fname,_ in FIELDS:
            self.ptrs[fname+'F'],self.ptrs[fname+'B'] = self.ptrs[fname+'B'],self.ptrs[fname+'F']
        wood_slots=[]
        if req['pass']==2:
            wa=np.empty(self.slots,dtype=np.uint8); self._down(wa.ctypes.data, self.ptrs['woodAdded'], wa.nbytes); downloaded+=wa.nbytes
            wood_slots=[int(s) for s in np.nonzero(wa)[0].tolist()]
        return {'index':self.index,'begin':begin,'end':end,'uploadedBytes':uploaded,'downloadedBytes':downloaded,'kernelMs':kernel_ms,'stepMs':(clock()-started)*1000,'downloadSlots':slots_sorted,'woodAddedSlots':wood_slots,'staging':staging}
    def close(self):
        try:
            checked(self.current(self.context))
            for ptr in self.ptrs.values(): checked(self.free(ptr))
            checked(self.destroy(self.context))
        except Exception: pass

def read_exact(n):
    b=bytearray(n); v=memoryview(b); o=0
    while o<n:
        c=sys.stdin.buffer.readinto(v[o:])
        if not c: raise EOFError()
        o+=c
    return bytes(b)
def emit(header, body=None):
    if body is not None and not isinstance(body,(bytes,bytearray,np.ndarray)): body=bytes(body)
    n = 0 if body is None else (body.nbytes if isinstance(body,np.ndarray) else len(body))
    header={**header,'bytes':n}; raw=json.dumps(header,separators=(',',':')).encode()
    sys.stdout.buffer.write(struct.pack('<I',len(raw))); sys.stdout.buffer.write(raw)
    if body is not None: sys.stdout.buffer.write(body if isinstance(body,(bytes,bytearray)) else body.tobytes())
    sys.stdout.buffer.flush()

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--devices',required=True); ap.add_argument('--nvrtc',required=True); a=ap.parse_args()
    indices=[int(x) for x in a.devices.split(',') if x!='']
    if not indices or any(x<0 for x in indices) or len(set(indices))!=len(indices): raise ValueError('Invalid devices')
    source=pathlib.Path(__file__).with_name('compute-ecology-resident.cu').read_text()
    devices=[]
    try:
        for idx in indices: devices.append(Device(idx,a.nvrtc,source))
        emit({'ready':True,'devices':[{'index':d.index,'architecture':d.arch,'contextMs':d.context_ms,'compileMs':d.compile_ms} for d in devices],'precision':'Float64','fmad':False,'kernels':['ecology_pass1','ecology_pass2'],'maxCells':MAX_CELLS})
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(devices)) as ex:
            while True:
                ln=struct.unpack('<I',read_exact(4))[0]
                if ln>1_000_000: raise ValueError('Oversized header')
                req=json.loads(read_exact(ln)); amount=req.get('bytes',0)
                if amount<0 or amount>4_000_000_000: raise ValueError('Oversized body')
                body=read_exact(amount) if amount else b''
                if req['kind']=='close': break
                if req['kind']=='sync':
                    cap=req['capacityCells']; slots=req['slots']; total=req['totalCells']
                    if cap<1 or cap>MAX_CELLS or total<0 or total>cap: raise ValueError('Invalid capacity')
                    off=0; arrays={}
                    def take(dt,count):
                        nonlocal off; nbytes=int(np.dtype(dt).itemsize*count); arr=np.frombuffer(body,dtype=dt,count=count,offset=off).copy(); off+=nbytes; return arr
                    arrays['cells']=take(np.int32,total); arrays['stamps']=take(np.uint32,cap); arrays['around']=take(np.int32,slots*9); arrays['pageX']=take(np.int32,slots); arrays['pageY']=take(np.int32,slots)
                    for fname,esz in FIELDS: arrays[fname]=take(np.float64 if esz==8 else np.uint8,cap)
                    futs=[ex.submit(d.sync,arrays,cap,slots,total) for d in devices]; parts=[f.result() for f in futs]
                    emit({'ok':True,'uploadedBytes':sum(p['uploadedBytes'] for p in parts),'devices':parts})
                elif req['kind']=='step':
                    dirty=req.get('dirtySlots',[]); ranges=req['ranges']
                    # split body: dirty chunks then optional woodAdded tail
                    dirty_bytes=len(dirty)*sum(256*e for _,e in FIELDS)
                    wood_arr=None
                    if req['pass']==2:
                        wood_arr=np.frombuffer(body,dtype=np.uint8,count=devices[0].slots,offset=dirty_bytes).copy()
                    body_np=np.frombuffer(body,dtype=np.uint8).copy(); body_addr=body_np.ctypes.data
                    halo_per=req.get('haloSlotsPerDevice',[]); halo_field=req.get('haloField')
                    halo_offsets=[]; hoff=dirty_bytes + (devices[0].slots if req['pass']==2 else 0)
                    if halo_field:
                        esz=dict(FIELDS)[halo_field]
                        for lst in halo_per: halo_offsets.append(hoff); hoff+=len(lst)*256*esz
                    parts=[]
                    for di,d in enumerate(devices):
                        r=dict(req); r['_wood_arr']=wood_arr
                        halo=(halo_per[di], halo_field, halo_offsets[di]) if halo_field and di < len(halo_per) else None
                        parts.append(d.step(r,body_addr,dirty,tuple(ranges[di]),halo))
                    out=np.concatenate([p['staging'] for p in parts]) if any(p['staging'].size for p in parts) else np.empty(0,dtype=np.uint8)
                    wood_slots=sorted(set(s for p in parts for s in p['woodAddedSlots']))
                    emit({'ok':True,'uploadedBytes':sum(p['uploadedBytes'] for p in parts),'downloadedBytes':sum(p['downloadedBytes'] for p in parts),'woodAddedSlots':wood_slots,'downloadSlotsPerDevice':[p['downloadSlots'] for p in parts],'devices':[{k:v for k,v in p.items() if k!='staging'} for p in parts]}, out)
                else: raise ValueError('Unknown operation')
    finally:
        for d in devices: d.close()
if __name__=='__main__':
    try: main()
    except EOFError: pass
    except Exception as e:
        try: emit({'error':str(e)})
        except Exception: pass
        sys.exit(1)
