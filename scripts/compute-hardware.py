#!/usr/bin/env python3
"""Read-only, sanitized capability probe. Never enumerates processes or secrets."""
import ctypes as C
import json
import os
import pathlib
import shutil
import subprocess

def value(path):
    p=pathlib.Path(path)
    return p.read_text().strip() if p.exists() else None

result={'cpuModel':next((line.split(':',1)[1].strip() for line in pathlib.Path('/proc/cpuinfo').read_text().splitlines() if line.startswith('model name')),None),'logicalCPUs':os.cpu_count(),'affinityCPUs':len(os.sched_getaffinity(0)),'cpuMax':value('/sys/fs/cgroup/cpu.max'),'cpuset':value('/sys/fs/cgroup/cpuset.cpus.effective'),'memoryMax':value('/sys/fs/cgroup/memory.max'),'memoryCurrent':value('/sys/fs/cgroup/memory.current'),'tools':{name:shutil.which(name) for name in ['node','python3','nvcc','nvidia-smi','vulkaninfo','clinfo','g++']}}
try:
    result['gpus']=subprocess.check_output(['nvidia-smi','--query-gpu=index,name,memory.total,memory.free,driver_version,compute_cap,utilization.gpu,pcie.link.gen.current,pcie.link.width.current','--format=csv,noheader,nounits'],text=True,timeout=10).strip().splitlines()
    lib=C.CDLL('libcuda.so.1'); count=C.c_int(); init=lib.cuInit(0)
    result['cuda']={'cuInit':init,'cuDeviceGetCount':lib.cuDeviceGetCount(C.byref(count)) if init==0 else None,'devices':count.value}
except Exception as error: result['cuda']={'error':str(error)}
result['vulkanICDFiles']=[str(p) for folder in ['/usr/share/vulkan/icd.d','/etc/vulkan/icd.d'] for p in pathlib.Path(folder).glob('*.json')]
try:
    lib=C.CDLL('libvulkan.so.1')
    class Info(C.Structure):
        _fields_=[('sType',C.c_uint32),('pNext',C.c_void_p),('flags',C.c_uint32),('pApplicationInfo',C.c_void_p),('enabledLayerCount',C.c_uint32),('ppEnabledLayerNames',C.c_void_p),('enabledExtensionCount',C.c_uint32),('ppEnabledExtensionNames',C.c_void_p)]
    create=lib.vkCreateInstance;create.argtypes=[C.POINTER(Info),C.c_void_p,C.POINTER(C.c_void_p)];create.restype=C.c_int
    info=Info();info.sType=1;instance=C.c_void_p();status=create(C.byref(info),None,C.byref(instance))
    result['vulkan']={'vkCreateInstance':status}
    if status==0:
        enum=lib.vkEnumeratePhysicalDevices;enum.argtypes=[C.c_void_p,C.POINTER(C.c_uint32),C.c_void_p];enum.restype=C.c_int
        count=C.c_uint32();result['vulkan']['enumerationResult']=enum(instance,C.byref(count),None);result['vulkan']['devices']=count.value
        destroy=lib.vkDestroyInstance;destroy.argtypes=[C.c_void_p,C.c_void_p];destroy(instance,None)
except Exception as error:result['vulkan']={'error':str(error)}
result['nodeWebGPU']=subprocess.check_output(['node','-e','process.stdout.write(JSON.stringify({navigator:typeof navigator!=="undefined",gpu:typeof navigator!=="undefined"&&!!navigator.gpu}))'],text=True).strip()
result['drm']=[{'node':str(p),'readable':os.access(p,os.R_OK),'writable':os.access(p,os.W_OK)} for p in pathlib.Path('/dev/dri').glob('renderD*')]
print(json.dumps(result,indent=2))
