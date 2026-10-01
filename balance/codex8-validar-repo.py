import ctypes,json,os,shutil,subprocess,time
from pathlib import Path
os.sched_setaffinity(0,range(6,32));os.setpriority(os.PRIO_PROCESS,0,19)
ctypes.CDLL(None).prctl(15,b'codex8-checks',0,0,0)
base=Path('/datos/tmp-atlas-lab/balance');runtime=Path('/datos/tmp-atlas-lab/codex8-runtime')
runtime.mkdir(exist_ok=True);node=runtime/'codex8-node'
shutil.copy2(shutil.which('node'),node)
cwd='/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/auditoria-realismo'
env={**os.environ,'TMPDIR':'/datos/tmp-atlas-lab'}
commands=[('typecheck',[str(node),'node_modules/typescript/bin/tsc','--noEmit']),('test',[str(node),'--import','tsx','--test','--test-timeout=600000',*sorted(str(p.relative_to(cwd)) for p in Path(cwd).glob('tests/*.test.ts'))])]
records=[]
for label,cmd in commands:
    start=time.time();bad=[];samples=0
    with (base/f'codex8-{label}.log').open('w') as log:
        child=subprocess.Popen(cmd,cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT)
        while child.poll() is None:
            for stat in Path(f'/proc/{child.pid}/task').glob('*/stat'):
                try:
                    raw=stat.read_text();fields=raw[raw.rfind(')')+2:].split();ni=int(fields[16])
                    affinity=sorted(os.sched_getaffinity(int(stat.parent.name)))
                    samples+=1
                    if ni!=19 or not set(affinity)<=set(range(6,32)):bad.append({'tid':stat.parent.name,'nice':ni,'affinity':affinity})
                except ProcessLookupError:pass
            time.sleep(2)
            if time.time()-start>1200:child.terminate()
        code=child.wait()
    row={'label':label,'exit':code,'elapsedSeconds':time.time()-start,'resourceSamples':samples,'resourceIssues':bad};records.append(row)
    print(json.dumps(row),flush=True)
    (base/'codex8-validacion-repo.json').write_text(json.dumps(records,indent=2)+'\n')
    if code!=0:break
