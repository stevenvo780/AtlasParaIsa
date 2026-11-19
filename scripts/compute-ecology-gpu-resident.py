#!/usr/bin/env python3
"""Persistent resident GPU worker for T122. Binary stdio, FP64, --fmad=false.

Buffers stay in VRAM between steps. Node uploads either a full topology+front
sync or only dirty pages, launches ecology_pass1/ecology_pass2, and downloads
back pages for the ranges each device computed. No 1M-cell / 120MB caps:
MAX_CELLS is the antic-corruption bound from the task.
"""
import argparse, concurrent.futures, ctypes as C, json, mmap, os, pathlib, struct, sys, tempfile, time
import numpy as np
clock = time.perf_counter
MAX_CELLS = 33_554_432
FIELDS = [('moisture',8),('vegetation',8),('food',8),('wood',8),('growth',8),('fertility',8),('cultivation',8),('traffic',8),('drinkingWater',8),('terrain',1),('biome',1),('feature',1),('life',8)]
# Descarga selectiva por pasada (solo lo que el kernel modifica; el resto lo copia el worker JS front->back en RAM).
DOWNLOAD_FIELDS = {1: [('moisture',8),('vegetation',8),('food',8)],
                   2: [(f,e) for f,e in FIELDS if f not in ('food','terrain','biome')]}

def runs_of(slots_sorted):
    """Agrupa una lista ordenada de slots en tramos contiguos [(start_slot, count_slots), ...]."""
    runs = []
    for s in slots_sorted:
        if runs and s == runs[-1][0] + runs[-1][1]:
            runs[-1] = (runs[-1][0], runs[-1][1] + 1)
        else:
            runs.append((int(s), 1))
    return runs

class ShmChannel:
    """Payload grande por /dev/shm (mmap); stdin/stdout solo llevan encabezados JSON < 4 KB."""
    def __init__(self):
        base = '/dev/shm' if os.path.isdir('/dev/shm') else tempfile.gettempdir()
        self.path = os.path.join(base, f'atlas-gpu-resident-{os.getpid()}.shm')
        self._fd = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        self.capacity = 0
        self.mm = None
        self.ensure(1 << 20)
    def ensure(self, nbytes):
        if nbytes <= self.capacity:
            return
        cap = max(nbytes, self.capacity * 2, 1 << 20)
        if self.mm is not None:
            self.mm.close()
        os.ftruncate(self._fd, cap)
        self.mm = mmap.mmap(self._fd, cap)
        self.capacity = cap
    def write(self, data):
        n = data.nbytes if isinstance(data, np.ndarray) else len(data)
        self.ensure(n)
        if isinstance(data, np.ndarray) and data.dtype == np.uint8:
            np.frombuffer(self.mm, dtype=np.uint8, count=n)[:] = data.ravel()
        elif isinstance(data, np.ndarray):
            self.mm[:n] = data.tobytes()
        else:
            self.mm[:n] = data
        return n
    def view(self, nbytes):
        self.ensure(nbytes)
        return memoryview(self.mm)[:nbytes]
    def close(self):
        try:
            if self.mm is not None:
                self.mm.close()
        except Exception:
            pass
        try:
            os.close(self._fd)
        except Exception:
            pass
        try:
            os.unlink(self.path)
        except Exception:
            pass

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
    def step(self, req, body_addr, dirty, ranges_by_device, halo=None, staging_out=None):
        checked(self.current(self.context)); started=clock(); uploaded=0
        # Subida sucia coalescida: el body viene por campo y por tramo contiguo (ver puente.ts);
        # una sola llamada DMA por campo y tramo copia count*256*esz bytes seguidos.
        offset=0
        dirty_sorted = sorted(int(s) for s in dirty)
        dirty_runs = runs_of(dirty_sorted)
        for fname,esz in FIELDS:
            for start_slot,count in dirty_runs:
                nbytes=count*256*esz; self._up(self.ptrs[fname+'F'], body_addr+offset, nbytes, start_slot*256*esz); offset+=nbytes; uploaded+=nbytes
        if req['pass']==2:
            wood_arr = req.pop('_wood_arr')
            self._up(self.ptrs['woodAdded'], wood_arr.ctypes.data, wood_arr.nbytes); uploaded+=wood_arr.nbytes; offset+=wood_arr.nbytes
        if halo:
            halo_slots, halo_field, halo_offset = halo
            esz = dict(FIELDS)[halo_field]
            rel=0
            for start_slot,count in runs_of(sorted(int(s) for s in halo_slots)):
                nbytes=count*256*esz; self._up(self.ptrs[halo_field+'F'], body_addr+halo_offset+rel, nbytes, start_slot*256*esz); uploaded+=nbytes; rel+=nbytes
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
        dl_started=clock()
        # Bajada selectiva y coalescida: solo los campos que la pasada modifica (3 en pass1, 10 en
        # pass2), una llamada DMA por campo y por tramo contiguo de páginas.
        if count:
            # unique ordenado en C (sin materializar millones de enteros Python por pasada).
            slots_sorted=np.unique(self.cells[begin:end]>>8).tolist()
        else: slots_sorted=[]
        dl_fields = DOWNLOAD_FIELDS[req['pass']]
        dl_runs = runs_of(slots_sorted)
        total_dl=sum(256*esz for _,esz in dl_fields)*len(slots_sorted)
        if staging_out is not None and staging_out.nbytes == total_dl:
            staging = staging_out
        elif staging_out is not None:
            raise ValueError('staging shm de tamaño inesperado')
        else:
            staging=np.empty(total_dl,dtype=np.uint8)
        downloaded=0; off=0
        for fname,esz in dl_fields:
            for start_slot,run_count in dl_runs:
                nbytes=run_count*256*esz; self._down(staging.ctypes.data+off, self.ptrs[fname+'B'], nbytes, start_slot*256*esz); off+=nbytes; downloaded+=nbytes
        # Logical front becomes the back just computed, matching TileStore.commitParallel parity swap.
        for fname,_ in FIELDS:
            self.ptrs[fname+'F'],self.ptrs[fname+'B'] = self.ptrs[fname+'B'],self.ptrs[fname+'F']
        wood_slots=[]
        if req['pass']==2:
            wa=np.empty(self.slots,dtype=np.uint8); self._down(wa.ctypes.data, self.ptrs['woodAdded'], wa.nbytes); downloaded+=wa.nbytes
            wood_slots=[int(s) for s in np.nonzero(wa)[0].tolist()]
        result={'index':self.index,'begin':begin,'end':end,'uploadedBytes':uploaded,'downloadedBytes':downloaded,'kernelMs':kernel_ms,'stepMs':(clock()-started)*1000,'downloadSlots':slots_sorted,'woodAddedSlots':wood_slots,'staging':staging}
        timing_path=os.environ.get('ATLAS_GPU_TIMING')
        if timing_path:
            try:
                with open(timing_path,'a') as fh: fh.write(json.dumps({'pass':req['pass'],'device':self.index,'stepMs':result['stepMs'],'kernelMs':kernel_ms,'downloadMs':(clock()-dl_started)*1000,'preKernelMs':(ks-started)*1000,'bytes':downloaded})+'\n')
            except Exception: pass
        return result
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
SHM = None
def emit(header, body=None):
    # El payload viaja por /dev/shm; por stdout solo va el encabezado JSON (con shmBytes).
    if body is not None and not isinstance(body,(bytes,bytearray,np.ndarray)): body=bytes(body)
    n = 0 if body is None else (body.nbytes if isinstance(body,np.ndarray) else len(body))
    shm_bytes = 0
    if body is not None and n and SHM is not None:
        shm_bytes = SHM.write(body)
        header={**header,'bytes':0,'shmBytes':shm_bytes}
    else:
        header={**header,'bytes':n,'shmBytes':0}
    raw=json.dumps(header,separators=(',',':')).encode()
    sys.stdout.buffer.write(struct.pack('<I',len(raw))); sys.stdout.buffer.write(raw)
    if body is not None and not shm_bytes and n:
        sys.stdout.buffer.write(body if isinstance(body,(bytes,bytearray)) else body.tobytes())
    sys.stdout.buffer.flush()
def emit_shm(header, nbytes):
    """Respuesta cuyo payload ya está en /dev/shm (DMA directa al mmap): solo va el encabezado."""
    header={**header,'bytes':0,'shmBytes':int(nbytes)}; raw=json.dumps(header,separators=(',',':')).encode()
    sys.stdout.buffer.write(struct.pack('<I',len(raw))); sys.stdout.buffer.write(raw)
    sys.stdout.buffer.flush()

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--devices',required=True); ap.add_argument('--nvrtc',required=True); a=ap.parse_args()
    indices=[int(x) for x in a.devices.split(',') if x!='']
    if not indices or any(x<0 for x in indices) or len(set(indices))!=len(indices): raise ValueError('Invalid devices')
    source=pathlib.Path(__file__).with_name('compute-ecology-resident.cu').read_text()
    devices=[]
    global SHM
    try:
        SHM = ShmChannel()
    except Exception:
        SHM = None
    try:
        for idx in indices: devices.append(Device(idx,a.nvrtc,source))
        emit({'ready':True,'devices':[{'index':d.index,'architecture':d.arch,'contextMs':d.context_ms,'compileMs':d.compile_ms} for d in devices],'precision':'Float64','fmad':False,'kernels':['ecology_pass1','ecology_pass2'],'maxCells':MAX_CELLS,'shmPath':(SHM.path if SHM else None),'shmCapacity':(SHM.capacity if SHM else 0)})
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(devices)) as ex:
            while True:
                ln=struct.unpack('<I',read_exact(4))[0]
                if ln>1_000_000: raise ValueError('Oversized header')
                req=json.loads(read_exact(ln)); amount=req.get('bytes',0); shm_amount=req.get('shmBytes',0) or 0
                if amount<0 or amount>4_000_000_000 or shm_amount<0 or shm_amount>4_000_000_000: raise ValueError('Oversized body')
                if shm_amount:
                    if SHM is None: raise ValueError('shmBytes sin canal /dev/shm')
                    body=SHM.view(int(shm_amount))
                else:
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
                    # DMA directa al mmap /dev/shm: cada dispositivo descarga en su tramo del
                    # buffer compartido y la respuesta no vuelve a copiarse staging->shm.
                    dl_fields_main = DOWNLOAD_FIELDS[req['pass']]
                    per_device_bytes = []
                    staging_slices = None
                    if SHM is not None and devices[0].cells is not None:
                        cells_all = devices[0].cells
                        sizes = []
                        for (b,e) in ranges:
                            nslots = int(np.unique(cells_all[b:e]>>8).size) if e > b else 0
                            sizes.append(nslots * sum(256*esz for _,esz in dl_fields_main))
                        total_dl_all = sum(sizes)
                        if total_dl_all:
                            SHM.ensure(total_dl_all)
                            base = np.frombuffer(SHM.mm, dtype=np.uint8, count=total_dl_all)
                            staging_slices = []; soff = 0
                            for sz in sizes: staging_slices.append(base[soff:soff+sz]); soff += sz
                            per_device_bytes = sizes
                    # Multi-GPU: cada dispositivo en su hilo (contexto propio); nunca secuencial.
                    def run_one(di_d):
                        di,d = di_d
                        r=dict(req); r['_wood_arr']=wood_arr
                        halo=(halo_per[di], halo_field, halo_offsets[di]) if halo_field and di < len(halo_per) else None
                        return d.step(r,body_addr,dirty,tuple(ranges[di]),halo, staging_slices[di] if staging_slices is not None else None)
                    futs=[ex.submit(run_one,(di,d)) for di,d in enumerate(devices)]
                    parts=[f.result() for f in futs]
                    wood_slots=sorted(set(s for p in parts for s in p['woodAddedSlots']))
                    reply_header={'ok':True,'uploadedBytes':sum(p['uploadedBytes'] for p in parts),'downloadedBytes':sum(p['downloadedBytes'] for p in parts),'woodAddedSlots':wood_slots,'downloadSlotsPerDevice':[p['downloadSlots'] for p in parts],'devices':[{k:v for k,v in p.items() if k!='staging'} for p in parts]}
                    if staging_slices is not None:
                        emit_shm(reply_header, sum(per_device_bytes))
                    else:
                        out=parts[0]['staging'] if len(parts)==1 else (np.concatenate([p['staging'] for p in parts]) if any(p['staging'].size for p in parts) else np.empty(0,dtype=np.uint8))
                        emit(reply_header, out)
                else: raise ValueError('Unknown operation')
    finally:
        for d in devices: d.close()
        if SHM is not None: SHM.close()
if __name__=='__main__':
    try: main()
    except EOFError: pass
    except Exception as e:
        try: emit({'error':str(e)})
        except Exception: pass
        sys.exit(1)
