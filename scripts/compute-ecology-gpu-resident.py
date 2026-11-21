#!/usr/bin/env python3
"""Persistent resident GPU worker for T122. Binary stdio, FP64, --fmad=false.

Buffers stay in VRAM between steps. Node uploads a full topology+front sync
(first step, arena growth, VRAM-authoritative ticks), an incremental `delta`
when chunks enter/leave without resizing the arena (only new/changed pages,
touched page neighbourhoods and `cells` runs), or only dirty pages; launches
ecology_pass1/ecology_pass2 and downloads back the pages each device owns. No 1M-cell / 120MB caps:
MAX_CELLS is the antic-corruption bound from the task.
"""
import argparse, concurrent.futures, ctypes as C, gc, json, mmap, os, pathlib, struct, sys, tempfile, time
import numpy as np
clock = time.perf_counter
MAX_CELLS = 134_217_728
FIELDS = [('moisture',8),('vegetation',8),('food',8),('wood',8),('growth',8),('fertility',8),('cultivation',8),('traffic',8),('drinkingWater',8),('terrain',1),('biome',1),('feature',1),('life',8)]
# Descarga selectiva por pasada (solo lo que el kernel modifica; el resto lo copia el worker JS front->back en RAM).
DOWNLOAD_FIELDS = {1: [('moisture',8),('vegetation',8),('food',8)],
                   2: [(f,e) for f,e in FIELDS if f not in ('food','terrain','biome')],
                   '2_halo': [(f,e) for f,e in FIELDS if f not in ('terrain','biome')]}

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
            gc.collect()
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
        self.index=index; self.ptrs={}; self.slots=0; self.local_cap=0; self.cells_cap=0; self.n_cells=0
        self.g2l=np.empty(0,dtype=np.int32); self.l2g=np.empty(0,dtype=np.int32); self.identity=True
        self.owned=set(); self._owned_sorted=None; self._owned_runs_local=None; self.ready=False
    # Estado por dispositivo (sync incremental): cada GPU tiene su lista propia de celdas
    # (`cells`, ids LOCALES, se lanza sobre [0, n_cells)), sus páginas propias (`owned`, ids
    # globales) y un mapa global->local (`g2l`; identidad en modo replicado). La presencia
    # en VRAM se codifica 1 (presente) / 0 (ausente) y el kernel recibe version=1: así un
    # cambio de versión del anfitrión no reescribe ningún sello en VRAM.
    def _alloc(self, name, nbytes):
        ptr=C.c_uint64(); checked(self.alloc(C.byref(ptr), max(1,int(nbytes)))); self.ptrs[name]=ptr
    def _up(self, ptr, host_addr, nbytes, offset=0):
        if nbytes: checked(self.upload_fn(C.c_uint64(ptr.value+offset), C.c_void_p(host_addr), int(nbytes)))
    def _down(self, host_addr, ptr, nbytes, offset=0):
        if nbytes: checked(self.download_fn(C.c_void_p(host_addr), C.c_uint64(ptr.value+offset), int(nbytes)))
    def owned_sorted(self):
        if self._owned_sorted is None:
            self._owned_sorted = sorted(self.owned)
        return self._owned_sorted
    def map_slots_to_local_runs(self, global_slots_sorted):
        g2l = self.g2l
        return runs_of([int(g2l[s]) for s in global_slots_sorted])
    def map_indexed_dirty_runs(self, global_slots_sorted):
        """Devuelve [(src_idx, dst_local_slot, count), ...] coalescidos en origen y destino (omite no locales)."""
        runs = []
        g2l = self.g2l; n = g2l.size
        for idx, gs in enumerate(global_slots_sorted):
            gs = int(gs)
            ls = int(g2l[gs]) if 0 <= gs < n else -1
            if ls < 0: continue
            if runs and idx == runs[-1][0] + runs[-1][2] and ls == runs[-1][1] + runs[-1][2]:
                runs[-1] = (runs[-1][0], runs[-1][1], runs[-1][2] + 1)
            else:
                runs.append((idx, ls, 1))
        return runs
    def _indexed_local_runs(self, pairs):
        """[(local, idx), ...] -> [(idx0, local0, count)] coalescidos (mismo orden)."""
        runs = []
        for ls, idx in pairs:
            ls = int(ls); idx = int(idx)
            if runs and idx == runs[-1][0] + runs[-1][2] and ls == runs[-1][1] + runs[-1][2]:
                runs[-1] = (runs[-1][0], runs[-1][1], runs[-1][2] + 1)
            else:
                runs.append((idx, ls, 1))
        return runs
    def _invalidate(self):
        self._owned_sorted = None; self._owned_runs_local = None
    def sync(self, arrays, capacity, slots, version, spec, l2g_local, cells_local):
        """Sync completo: (re)aloja con la holgura que pide el puente y sube todo lo local."""
        checked(self.current(self.context)); started=clock()
        for ptr in self.ptrs.values(): checked(self.free(ptr))
        self.ptrs={}; self.slots=slots; uploaded=0
        identity = bool(spec['identity'])
        self.identity = identity
        local_cap = int(spec['localCap']); cells_cap = int(spec['cellsCap']); n_cells = int(spec['nCells'])
        self.local_cap = local_cap; self.cells_cap = cells_cap; self.n_cells = n_cells
        presence = (arrays['stamps'] == np.uint32(version)).astype(np.uint32)
        if identity:
            if local_cap != slots: raise ValueError('identity sync con localCap != slots')
            self.g2l = np.arange(slots, dtype=np.int32); self.l2g = np.arange(slots, dtype=np.int32)
            local_globals = None
        else:
            n_local = int(l2g_local.size)
            self.l2g = np.full(local_cap, -1, dtype=np.int32); self.l2g[:n_local] = l2g_local
            self.g2l = np.full(slots, -1, dtype=np.int32)
            if n_local: self.g2l[l2g_local] = np.arange(n_local, dtype=np.int32)
            local_globals = l2g_local
        self._alloc('cells', cells_cap*4); self._alloc('stamps', local_cap*256*4); self._alloc('around', local_cap*9*4)
        self._alloc('pageX', local_cap*4); self._alloc('pageY', local_cap*4); self._alloc('woodAdded', local_cap)
        for fname,esz in FIELDS:
            self._alloc(fname+'F', local_cap*256*esz); self._alloc(fname+'B', local_cap*256*esz)
        if cells_local.size:
            self._up(self.ptrs['cells'], cells_local.ctypes.data, cells_local.nbytes); uploaded += cells_local.nbytes
        if identity:
            for name, a in [('stamps', presence), ('around', arrays['around']), ('pageX', arrays['pageX']), ('pageY', arrays['pageY'])]:
                self._up(self.ptrs[name], a.ctypes.data, a.nbytes); uploaded += a.nbytes
            for fname,esz in FIELDS:
                a=arrays[fname]; self._up(self.ptrs[fname+'F'], a.ctypes.data, a.nbytes); uploaded+=a.nbytes
                if fname in ('terrain', 'life'): self._up(self.ptrs[fname+'B'], a.ctypes.data, a.nbytes)
        else:
            n_local = int(local_globals.size)
            loc_pres = np.zeros(local_cap*256, dtype=np.uint32)
            loc_around = np.full(local_cap*9, -1, dtype=np.int32)
            loc_px = np.zeros(local_cap, dtype=np.int32); loc_py = np.zeros(local_cap, dtype=np.int32)
            if n_local:
                loc_pres[:n_local*256] = presence.reshape(slots, 256)[local_globals].ravel()
                raw_ar = arrays['around'].reshape(slots, 9)[local_globals]
                loc_around[:n_local*9] = np.where(raw_ar >= 0, self.g2l[np.maximum(raw_ar, 0)], -1).astype(np.int32).ravel()
                loc_px[:n_local] = arrays['pageX'][local_globals]; loc_py[:n_local] = arrays['pageY'][local_globals]
            for name, a in [('stamps', loc_pres), ('around', loc_around), ('pageX', loc_px), ('pageY', loc_py)]:
                self._up(self.ptrs[name], a.ctypes.data, a.nbytes); uploaded += a.nbytes
            slot_runs = runs_of(local_globals.tolist())
            for fname, esz in FIELDS:
                f_addr = arrays[fname].ctypes.data
                l_off = 0
                for g_start, r_cnt in slot_runs:
                    nbytes = r_cnt * 256 * esz
                    self._up(self.ptrs[fname+'F'], f_addr + g_start * 256 * esz, nbytes, l_off * 256 * esz)
                    if fname in ('terrain', 'life'):
                        self._up(self.ptrs[fname+'B'], f_addr + g_start * 256 * esz, nbytes, l_off * 256 * esz)
                    l_off += r_cnt; uploaded += nbytes
        z_wood = np.zeros(max(1, local_cap), dtype=np.uint8)
        self._up(self.ptrs['woodAdded'], z_wood.ctypes.data, local_cap)
        if n_cells:
            self.owned = set(np.unique(self.l2g[cells_local >> 8]).tolist())
        else:
            self.owned = set()
        self._invalidate(); self.ready = True
        resident_bytes = local_cap*256*sum(e for _,e in FIELDS)*2 + cells_cap*4 + local_cap*256*4 + local_cap*9*4 + local_cap*9
        return {'index':self.index,'uploadedBytes':uploaded,'syncMs':(clock()-started)*1000,'residentBytes':resident_bytes,
                'sharded':not identity,'localSlots':int(np.count_nonzero(self.l2g >= 0)),'localCap':local_cap,'ownedSlots':len(self.owned)}
    def apply_delta(self, op, body_addr, pages, page_offsets):
        """Sync incremental: solo páginas nuevas/cambiadas, vecindades tocadas y tramos de `cells`."""
        checked(self.current(self.context)); started=clock(); uploaded=0
        for g in op.get('unmap', []):
            g = int(g); l = int(self.g2l[g])
            if l >= 0: self.l2g[l] = -1
            self.g2l[g] = -1
        for g, l in op.get('map', []):
            g = int(g); l = int(l)
            if l < 0 or l >= self.local_cap: raise ValueError('delta: ranura local fuera de capacidad')
            self.g2l[g] = l; self.l2g[l] = g
        for g in op.get('ownedRemove', []): self.owned.discard(int(g))
        for g in op.get('ownedAdd', []): self.owned.add(int(g))
        page_runs = self._indexed_local_runs(op.get('pageUploads', []))
        if page_runs:
            field_off = page_offsets['fields']
            for fname, esz in FIELDS:
                for src_idx, dst_slot, count in page_runs:
                    nbytes = count*256*esz
                    self._up(self.ptrs[fname+'F'], body_addr+field_off+src_idx*256*esz, nbytes, dst_slot*256*esz)
                    if fname in ('terrain', 'life'):
                        self._up(self.ptrs[fname+'B'], body_addr+field_off+src_idx*256*esz, nbytes, dst_slot*256*esz)
                    uploaded += nbytes
                field_off += pages*256*esz
            for src_idx, dst_slot, count in page_runs:
                self._up(self.ptrs['stamps'], body_addr+page_offsets['stamps']+src_idx*256*4, count*256*4, dst_slot*256*4)
                self._up(self.ptrs['pageX'], body_addr+page_offsets['pageX']+src_idx*4, count*4, dst_slot*4)
                self._up(self.ptrs['pageY'], body_addr+page_offsets['pageY']+src_idx*4, count*4, dst_slot*4)
                uploaded += count*(256*4 + 8)
        around_slots = op.get('aroundSlots', [])
        if around_slots:
            a_off = int(op['aroundOff'])
            for src_idx, dst_slot, count in self._indexed_local_runs([(l, i) for i, l in enumerate(around_slots)]):
                self._up(self.ptrs['around'], body_addr+a_off+src_idx*36, count*36, dst_slot*36); uploaded += count*36
        cell_runs = op.get('cellRuns', [])
        if cell_runs:
            c_off = int(op['cellsOff']); src = 0
            for pos, count in cell_runs:
                pos = int(pos); count = int(count)
                if pos < 0 or pos + count > self.cells_cap: raise ValueError('delta: tramo de cells fuera de capacidad')
                self._up(self.ptrs['cells'], body_addr+c_off+src*4, count*4, pos*4); src += count; uploaded += count*4
        n_cells = int(op.get('nCells', self.n_cells))
        if n_cells < 0 or n_cells > self.cells_cap: raise ValueError('delta: nCells fuera de capacidad')
        self.n_cells = n_cells
        self._invalidate()
        return {'index':self.index,'uploadedBytes':uploaded,'deltaMs':(clock()-started)*1000,'ownedSlots':len(self.owned)}
    def _owned_dl(self, req_dl_slots):
        if req_dl_slots is None:
            return self.owned_sorted()
        owned = self.owned
        return sorted(set(int(s) for s in req_dl_slots if int(s) in owned))
    def _wood_local(self, wood_arr):
        if self.identity:
            return wood_arr[:self.local_cap]
        w = np.zeros(self.local_cap, dtype=np.uint8)
        valid = self.l2g >= 0
        if valid.any(): w[valid] = wood_arr[self.l2g[valid]]
        return w
    def _wood_globals(self, wa):
        nz = np.nonzero(wa)[0]
        if self.identity: return [int(s) for s in nz.tolist()]
        return [int(self.l2g[s]) for s in nz.tolist() if int(self.l2g[s]) >= 0]
    def step(self, req, body_addr, dirty, halo=None, staging_out=None):
        checked(self.current(self.context)); started=clock(); uploaded=0
        # Subida sucia coalescida: el body viene por campo y por tramo contiguo (ver puente.ts);
        # una sola llamada DMA por campo y tramo copia count*256*esz bytes seguidos.
        dirty_sorted = sorted(int(s) for s in dirty)
        dirty_idx_runs = self.map_indexed_dirty_runs(dirty_sorted)
        field_off = 0
        for fname,esz in FIELDS:
            for src_idx, dst_slot, count in dirty_idx_runs:
                nbytes=count*256*esz
                self._up(self.ptrs[fname+'F'], body_addr+field_off+src_idx*256*esz, nbytes, dst_slot*256*esz)
                uploaded+=nbytes
            field_off += len(dirty_sorted)*256*esz
        if req['pass']==2:
            w_local = self._wood_local(req.pop('_wood_arr'))
            if w_local.nbytes:
                w_local = np.ascontiguousarray(w_local)
                self._up(self.ptrs['woodAdded'], w_local.ctypes.data, w_local.nbytes); uploaded+=w_local.nbytes
        if halo:
            halo_slots, halo_field, halo_offset = halo
            esz = dict(FIELDS)[halo_field]
            for src_idx, dst_slot, count in self.map_indexed_dirty_runs(sorted(int(s) for s in halo_slots)):
                nbytes=count*256*esz
                self._up(self.ptrs[halo_field+'F'], body_addr+halo_offset+src_idx*256*esz, nbytes, dst_slot*256*esz)
                uploaded+=nbytes
        k_begin, k_end = 0, self.n_cells
        p = req['params']
        # Build kernel args (presencia 1/0 en VRAM: version=1).
        front=[self.ptrs[f+'F'] for f,_ in FIELDS]; back=[self.ptrs[f+'B'] for f,_ in FIELDS]
        topo=[self.ptrs['cells'],self.ptrs['stamps'],self.ptrs['around']]
        vals=[]
        if req['pass']==1:
            vals = topo + front + back + [C.c_int(k_begin),C.c_int(k_end),C.c_uint(1),C.c_int(p['rain']),C.c_double(p['light']),C.c_double(p['capacidadBosque']),C.c_double(p['capacidadPastizal']),C.c_double(p['capacidadOtros']),C.c_double(p['velocidadRegeneracion']),C.c_double(p['decaimientoComida'])]
            kern=self.k1
        else:
            vals = topo + [self.ptrs['pageX'],self.ptrs['pageY'],self.ptrs['woodAdded']] + front + back + [C.c_int(k_begin),C.c_int(k_end),C.c_int(p['tick']),C.c_uint(1),C.c_int(p['rain']),C.c_double(p['light']),C.c_double(p['decaimientoFertilidad']),C.c_uint(p['seed']),C.c_double(p['cuencas'])]
            kern=self.k2
        args=(C.c_void_p*len(vals))(*(C.cast(C.byref(v),C.c_void_p) for v in vals))
        count=max(0,k_end-k_begin); grid=(count+255)//256
        ks=clock()
        if grid > 0:
            checked(self.launch(kern,grid,1,1,256,1,1,0,None,args,None)); checked(self.sync_fn())
        kernel_ms=(clock()-ks)*1000
        dl_started=clock()
        # Bajada selectiva y coalescida: solo los campos que la pasada modifica (3 en pass1, 10 en
        # pass2, o 11 en pass2 con halo activo), una llamada DMA por campo y por tramo contiguo.
        req_dl_slots = req.get('downloadSlots')
        slots_sorted = self._owned_dl(req_dl_slots)
        if req_dl_slots is not None:
            dl_fields = DOWNLOAD_FIELDS['2_halo' if req['pass']==2 else 1]
        else:
            dl_fields = DOWNLOAD_FIELDS[req['pass']]
        if req_dl_slots is None:
            if self._owned_runs_local is None: self._owned_runs_local = self.map_slots_to_local_runs(slots_sorted)
            dl_runs = self._owned_runs_local
        else:
            dl_runs = self.map_slots_to_local_runs(slots_sorted)
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
        if req['pass']==2 and self.local_cap > 0:
            wa=np.empty(self.local_cap,dtype=np.uint8); self._down(wa.ctypes.data, self.ptrs['woodAdded'], wa.nbytes); downloaded+=wa.nbytes
            wood_slots=self._wood_globals(wa)
        result={'index':self.index,'uploadedBytes':uploaded,'downloadedBytes':downloaded,'kernelMs':kernel_ms,'stepMs':(clock()-started)*1000,'downloadSlots':slots_sorted,'woodAddedSlots':wood_slots,'staging':None if staging_out is not None else staging}
        timing_path=os.environ.get('ATLAS_GPU_TIMING')
        if timing_path:
            try:
                with open(timing_path,'a') as fh: fh.write(json.dumps({'pass':req['pass'],'device':self.index,'stepMs':result['stepMs'],'kernelMs':kernel_ms,'downloadMs':(clock()-dl_started)*1000,'preKernelMs':(ks-started)*1000,'bytes':downloaded})+'\n')
            except Exception: pass
        return result
    def upload_dirty(self, body_addr, dirty_sorted, also_back=False):
        checked(self.current(self.context))
        idx_runs = self.map_indexed_dirty_runs(dirty_sorted)
        field_off = 0; uploaded = 0
        for fname, esz in FIELDS:
            for src_idx, dst_slot, count in idx_runs:
                nbytes = count * 256 * esz
                self._up(self.ptrs[fname + 'F'], body_addr + field_off + src_idx * 256 * esz, nbytes, dst_slot * 256 * esz)
                if also_back and fname in ('terrain', 'life'):
                    self._up(self.ptrs[fname + 'B'], body_addr + field_off + src_idx * 256 * esz, nbytes, dst_slot * 256 * esz)
                uploaded += nbytes
            field_off += len(dirty_sorted) * 256 * esz
        return uploaded
    def download_field_local_runs(self, fname, esz, buf_suffix, local_runs, total_bytes):
        checked(self.current(self.context))
        out = np.empty(total_bytes, dtype=np.uint8)
        off = 0
        for start_slot, count in local_runs:
            nbytes = count * 256 * esz
            self._down(out.ctypes.data + off, self.ptrs[fname + buf_suffix], nbytes, start_slot * 256 * esz)
            off += nbytes
        return out
    def upload_field_local_runs(self, fname, esz, buf_suffix, local_runs, arr):
        checked(self.current(self.context))
        off = 0
        for start_slot, count in local_runs:
            nbytes = count * 256 * esz
            self._up(self.ptrs[fname + buf_suffix], arr.ctypes.data + off, nbytes, start_slot * 256 * esz)
            off += nbytes
        return off
    def tick_kernels(self, p1, p2, req_dl_slots, uploaded_pre=0, staging_out=None):
        checked(self.current(self.context)); started = clock()
        k_begin, k_end = 0, self.n_cells
        count = max(0, k_end - k_begin); grid = (count + 255) // 256
        topo = [self.ptrs['cells'], self.ptrs['stamps'], self.ptrs['around']]
        if p2['tick'] % 100 == 0 and self.local_cap > 0:
            z_wood = np.zeros(self.local_cap, dtype=np.uint8)
            self._up(self.ptrs['woodAdded'], z_wood.ctypes.data, z_wood.nbytes)
        front1 = [self.ptrs[f + 'F'] for f, _ in FIELDS]; back1 = [self.ptrs[f + 'B'] for f, _ in FIELDS]
        vals1 = topo + front1 + back1 + [
            C.c_int(k_begin), C.c_int(k_end), C.c_uint(1), C.c_int(p1['rain']), C.c_double(p1['light']),
            C.c_double(p1['capacidadBosque']), C.c_double(p1['capacidadPastizal']), C.c_double(p1['capacidadOtros']),
            C.c_double(p1['velocidadRegeneracion']), C.c_double(p1['decaimientoComida']),
        ]
        args1 = (C.c_void_p * len(vals1))(*(C.cast(C.byref(v), C.c_void_p) for v in vals1))
        for fname, _ in FIELDS:
            self.ptrs[fname + 'F'], self.ptrs[fname + 'B'] = self.ptrs[fname + 'B'], self.ptrs[fname + 'F']
        front2 = [self.ptrs[f + 'F'] for f, _ in FIELDS]; back2 = [self.ptrs[f + 'B'] for f, _ in FIELDS]
        vals2 = topo + [self.ptrs['pageX'], self.ptrs['pageY'], self.ptrs['woodAdded']] + front2 + back2 + [
            C.c_int(k_begin), C.c_int(k_end), C.c_int(p2['tick']), C.c_uint(1), C.c_int(p2['rain']),
            C.c_double(p2['light']), C.c_double(p2['decaimientoFertilidad']), C.c_uint(p2['seed']), C.c_double(p2['cuencas']),
        ]
        args2 = (C.c_void_p * len(vals2))(*(C.cast(C.byref(v), C.c_void_p) for v in vals2))
        ks = clock()
        if grid > 0:
            checked(self.launch(self.k1, grid, 1, 1, 256, 1, 1, 0, None, args1, None))
            checked(self.launch(self.k2, grid, 1, 1, 256, 1, 1, 0, None, args2, None))
            checked(self.sync_fn())
        kernel_ms = (clock() - ks) * 1000
        for fname, _ in FIELDS:
            self.ptrs[fname + 'F'], self.ptrs[fname + 'B'] = self.ptrs[fname + 'B'], self.ptrs[fname + 'F']
        slots_sorted = self._owned_dl(req_dl_slots)
        dl_runs = self.map_slots_to_local_runs(slots_sorted)
        total_dl = sum(256 * esz for _, esz in FIELDS) * len(slots_sorted)
        staging = staging_out if (staging_out is not None and staging_out.nbytes == total_dl) else np.empty(total_dl, dtype=np.uint8)
        downloaded = 0; off = 0
        for fname, esz in FIELDS:
            for start_slot, run_count in dl_runs:
                nbytes = run_count * 256 * esz
                self._down(staging.ctypes.data + off, self.ptrs[fname + 'F'], nbytes, start_slot * 256 * esz)
                off += nbytes; downloaded += nbytes
        wood_slots = []
        if p2['tick'] % 100 == 0 and self.local_cap > 0:
            wa = np.empty(self.local_cap, dtype=np.uint8)
            self._down(wa.ctypes.data, self.ptrs['woodAdded'], wa.nbytes)
            downloaded += wa.nbytes
            wood_slots = self._wood_globals(wa)
        return {
            'index': self.index, 'uploadedBytes': uploaded_pre,
            'downloadedBytes': downloaded, 'kernelMs': kernel_ms, 'stepMs': (clock() - started) * 1000,
            'downloadSlots': slots_sorted, 'woodAddedSlots': wood_slots, 'staging': None if staging_out is not None else staging,
        }
    def flush(self, staging_out=None):
        checked(self.current(self.context))
        slots_sorted = self.owned_sorted()
        dl_runs = self.map_slots_to_local_runs(slots_sorted)
        total_dl = sum(256*esz for _,esz in FIELDS) * len(slots_sorted)
        staging = staging_out if (staging_out is not None and staging_out.nbytes == total_dl) else np.empty(total_dl, dtype=np.uint8)
        off = 0
        for fname, esz in FIELDS:
            for start_slot, run_count in dl_runs:
                nbytes = run_count * 256 * esz
                self._down(staging.ctypes.data + off, self.ptrs[fname + 'F'], nbytes, start_slot * 256 * esz)
                off += nbytes
        return {'index': self.index, 'downloadSlots': slots_sorted, 'downloadedBytes': off, 'staging': None if staging_out is not None else staging}
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
        cached_halo_per = None
        cached_halo_plan = None
        def release_body(b):
            if isinstance(b, memoryview):
                try: b.release()
                except Exception: pass
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(devices)) as ex:
            body = None
            while True:
                # Liberar cualquier vista/memoryview sobre SHM.mm ANTES de redimensionar (evita BufferError al crecer el mundo vivo).
                release_body(body); body = None
                ln=struct.unpack('<I',read_exact(4))[0]
                if ln>16_777_216: raise ValueError('Oversized header')
                req=json.loads(read_exact(ln)); amount=req.get('bytes',0); shm_amount=req.get('shmBytes',0) or 0
                if amount<0 or amount>16_000_000_000 or shm_amount<0 or shm_amount>16_000_000_000: raise ValueError('Oversized body')
                if shm_amount:
                    if SHM is None: raise ValueError('shmBytes sin canal /dev/shm')
                    body=SHM.view(int(shm_amount))
                else:
                    body=read_exact(amount) if amount else b''
                if req['kind']=='close':
                    release_body(body); body = None
                    break
                if req['kind']=='sync':
                    cap=req['capacityCells']; slots=req['slots']; version=int(req['version'])
                    specs=req['devices']
                    if cap<1 or cap>MAX_CELLS or cap!=slots*256: raise ValueError('Invalid capacity')
                    if len(specs)!=len(devices): raise ValueError('sync: especificación por dispositivo incompleta')
                    off=0; arrays={}
                    def take(dt,count,copy=False):
                        nonlocal off; nbytes=int(np.dtype(dt).itemsize*count); arr=np.frombuffer(body,dtype=dt,count=count,offset=off); off+=nbytes; return arr.copy() if copy else arr
                    arrays['stamps']=take(np.uint32,cap); arrays['around']=take(np.int32,slots*9); arrays['pageX']=take(np.int32,slots); arrays['pageY']=take(np.int32,slots)
                    for fname,esz in FIELDS: arrays[fname]=take(np.float64 if esz==8 else np.uint8,cap)
                    per_dev=[]
                    for spec in specs:
                        l2g_local = None if spec['identity'] else take(np.int32, int(spec['localSlots']), copy=True)
                        cells_local = take(np.int32, int(spec['nCells']), copy=True)
                        per_dev.append((spec, l2g_local, cells_local))
                    futs=[ex.submit(d.sync,arrays,cap,slots,version,per_dev[di][0],per_dev[di][1],per_dev[di][2]) for di,d in enumerate(devices)]
                    parts=[f.result() for f in futs]
                    futs = None; take = None; arrays = None; per_dev = None; release_body(body); body = None
                    cached_halo_plan = None
                    emit({'ok':True,'uploadedBytes':sum(p['uploadedBytes'] for p in parts),'devices':parts})
                    parts = None
                elif req['kind']=='delta':
                    if not all(d.ready for d in devices): raise ValueError('delta sin sync previo')
                    ops=req['devices']; pages=int(req.get('pages',0))
                    if len(ops)!=len(devices): raise ValueError('delta: operación por dispositivo incompleta')
                    body_np=np.frombuffer(body,dtype=np.uint8) if (amount or shm_amount) else np.zeros(1,dtype=np.uint8)
                    body_addr=body_np.ctypes.data
                    page_offsets={'fields':0}
                    o=pages*sum(256*e for _,e in FIELDS)
                    page_offsets['stamps']=o; o+=pages*256*4
                    page_offsets['pageX']=o; o+=pages*4
                    page_offsets['pageY']=o; o+=pages*4
                    futs=[ex.submit(d.apply_delta,ops[di],body_addr,pages,page_offsets) for di,d in enumerate(devices)]
                    parts=[f.result() for f in futs]
                    futs = None; body_np = None; release_body(body); body = None
                    cached_halo_plan = None
                    emit({'ok':True,'uploadedBytes':sum(p['uploadedBytes'] for p in parts),'devices':parts})
                    parts = None
                elif req['kind']=='step':
                    if not all(d.ready for d in devices): raise ValueError('step sin sync previo')
                    dirty=req.get('dirtySlots',[])
                    # split body: dirty chunks then optional woodAdded tail
                    dirty_bytes=len(dirty)*sum(256*e for _,e in FIELDS)
                    wood_arr=None
                    if req['pass']==2:
                        wood_arr=np.frombuffer(body,dtype=np.uint8,count=devices[0].slots,offset=dirty_bytes).copy()
                    body_np=np.frombuffer(body,dtype=np.uint8).copy() if (amount or shm_amount) else np.zeros(1,dtype=np.uint8)
                    body_addr=body_np.ctypes.data
                    release_body(body); body = None
                    halo_per=req.get('haloSlotsPerDevice',[]); halo_field=req.get('haloField')
                    halo_offsets=[]; hoff=dirty_bytes + (devices[0].slots if req['pass']==2 else 0)
                    if halo_field:
                        esz=dict(FIELDS)[halo_field]
                        for lst in halo_per: halo_offsets.append(hoff); hoff+=len(lst)*256*esz
                    # DMA directa al mmap /dev/shm: cada dispositivo descarga en su tramo del
                    # buffer compartido y la respuesta no vuelve a copiarse staging->shm.
                    req_dl_slots = req.get('downloadSlots')
                    dl_fields_main = DOWNLOAD_FIELDS[('2_halo' if req['pass']==2 else 1) if req_dl_slots is not None else req['pass']]
                    per_device_bytes = []
                    staging_slices = None; base = None
                    if SHM is not None:
                        sizes = []
                        for d in devices:
                            nslots = len(d._owned_dl(req_dl_slots))
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
                        return d.step(r,body_addr,dirty,halo, staging_slices[di] if staging_slices is not None else None)
                    futs=[ex.submit(run_one,(di,d)) for di,d in enumerate(devices)]
                    parts=[f.result() for f in futs]
                    futs = None; run_one = None
                    wood_slots=sorted(set(s for p in parts for s in p['woodAddedSlots']))
                    reply_header={'ok':True,'uploadedBytes':sum(p['uploadedBytes'] for p in parts),'downloadedBytes':sum(p['downloadedBytes'] for p in parts),'woodAddedSlots':wood_slots,'downloadRunsPerDevice':[runs_of(p['downloadSlots']) for p in parts],'devices':[{k:v for k,v in p.items() if k not in ('staging','downloadSlots')} for p in parts]}
                    if staging_slices is not None:
                        parts = None; staging_slices = None; base = None; body_np = None
                        emit_shm(reply_header, sum(per_device_bytes))
                    else:
                        out=parts[0]['staging'] if len(parts)==1 else (np.concatenate([p['staging'] for p in parts]) if any(p['staging'].size for p in parts) else np.empty(0,dtype=np.uint8))
                        parts = None; base = None; body_np = None
                        emit(reply_header, out)
                        out = None
                elif req['kind']=='tick':
                    if not all(d.ready for d in devices): raise ValueError('tick sin sync previo')
                    dirty = req.get('dirtySlots', [])
                    if req.get('haloSlotsPerDevice') is not None and req['haloSlotsPerDevice'] != cached_halo_per:
                        cached_halo_per = req['haloSlotsPerDevice']
                        cached_halo_plan = None
                    halo_per = cached_halo_per or []
                    req_dl_slots = req.get('downloadSlots', [])
                    p1 = req['pass1Params']; p2 = req['pass2Params']
                    dirty_sorted = sorted(int(s) for s in dirty)
                    uploaded_per_dev = [0] * len(devices)
                    if dirty_sorted:
                        body_np = np.frombuffer(body, dtype=np.uint8)
                        body_addr = body_np.ctypes.data
                        for di, d in enumerate(devices):
                            uploaded_per_dev[di] += d.upload_dirty(body_addr, dirty_sorted, also_back=(len(devices) > 1))
                        body_np = None
                    release_body(body); body = None
                    if len(devices) > 1:
                        if cached_halo_plan is None:
                            cached_halo_plan = []
                            for di, dst_d in enumerate(devices):
                                if di >= len(halo_per) or not halo_per[di]: continue
                                for src_di, src_d in enumerate(devices):
                                    if src_di == di: continue
                                    src_set = src_d.owned
                                    h_slots = sorted(int(s) for s in halo_per[di] if int(s) in src_set)
                                    if h_slots:
                                        cached_halo_plan.append((
                                            di, dst_d, src_d,
                                            src_d.map_slots_to_local_runs(h_slots),
                                            dst_d.map_slots_to_local_runs(h_slots),
                                            len(h_slots) * 256 * 8,
                                        ))
                        for di, dst_d, src_d, src_runs, dst_runs, total_b in cached_halo_plan:
                            h_buf = src_d.download_field_local_runs('life', 8, 'F', src_runs, total_b)
                            uploaded_per_dev[di] += dst_d.upload_field_local_runs('life', 8, 'B', dst_runs, h_buf)
                    per_device_bytes = []
                    staging_slices = None; base = None
                    if SHM is not None:
                        sizes = []
                        for d in devices:
                            nslots = len(d._owned_dl(req_dl_slots))
                            sizes.append(nslots * sum(256 * esz for _, esz in FIELDS))
                        total_dl_all = sum(sizes)
                        if total_dl_all:
                            SHM.ensure(total_dl_all)
                            base = np.frombuffer(SHM.mm, dtype=np.uint8, count=total_dl_all)
                            staging_slices = []; soff = 0
                            for sz in sizes: staging_slices.append(base[soff:soff + sz]); soff += sz
                            per_device_bytes = sizes
                    futs = [
                        ex.submit(
                            d.tick_kernels, p1, p2, req_dl_slots,
                            uploaded_per_dev[di], staging_slices[di] if staging_slices is not None else None,
                        )
                        for di, d in enumerate(devices)
                    ]
                    parts = [f.result() for f in futs]
                    futs = None
                    wood_slots = sorted(set(s for p in parts for s in p['woodAddedSlots']))
                    reply_header = {
                        'ok': True, 'uploadedBytes': sum(p['uploadedBytes'] for p in parts),
                        'downloadedBytes': sum(p['downloadedBytes'] for p in parts),
                        'woodAddedSlots': wood_slots, 'downloadRunsPerDevice': [runs_of(p['downloadSlots']) for p in parts],
                        'devices': [{k: v for k, v in p.items() if k not in ('staging', 'downloadSlots')} for p in parts],
                    }
                    if staging_slices is not None:
                        parts = None; staging_slices = None; base = None
                        emit_shm(reply_header, sum(per_device_bytes))
                    else:
                        out = parts[0]['staging'] if len(parts) == 1 else (np.concatenate([p['staging'] for p in parts]) if any(p['staging'].size for p in parts) else np.empty(0, dtype=np.uint8))
                        parts = None; base = None
                        emit(reply_header, out)
                        out = None
                elif req['kind']=='flush':
                    release_body(body); body = None
                    per_device_bytes = []
                    staging_slices = None; base = None
                    if SHM is not None:
                        sizes = []
                        for d in devices:
                            sizes.append(len(d.owned_sorted()) * sum(256*esz for _,esz in FIELDS))
                        total_dl_all = sum(sizes)
                        if total_dl_all:
                            SHM.ensure(total_dl_all)
                            base = np.frombuffer(SHM.mm, dtype=np.uint8, count=total_dl_all)
                            staging_slices = []; soff = 0
                            for sz in sizes: staging_slices.append(base[soff:soff+sz]); soff += sz
                            per_device_bytes = sizes
                    futs=[ex.submit(d.flush, staging_slices[di] if staging_slices is not None else None) for di, d in enumerate(devices)]
                    parts=[f.result() for f in futs]
                    futs = None
                    reply_header={'ok':True,'downloadedBytes':sum(p['downloadedBytes'] for p in parts),'downloadRunsPerDevice':[runs_of(p['downloadSlots']) for p in parts]}
                    if staging_slices is not None:
                        parts = None; staging_slices = None; base = None
                        emit_shm(reply_header, sum(per_device_bytes))
                    else:
                        out=parts[0]['staging'] if len(parts)==1 else (np.concatenate([p['staging'] for p in parts]) if any(p['staging'].size for p in parts) else np.empty(0,dtype=np.uint8))
                        parts = None; base = None
                        emit(reply_header, out)
                        out = None
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
