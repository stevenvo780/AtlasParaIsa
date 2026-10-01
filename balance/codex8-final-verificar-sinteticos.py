"""Final source SHA and cheap in-memory fixtures; never invokes main or real verifier."""
import os,ctypes,sys,importlib.util,json,hashlib,ast,statistics as st,math
from pathlib import Path
from datetime import datetime,timezone
sys.dont_write_bytecode=True
ctypes.CDLL(None).prctl(15,b'codex8-audit',0,0,0);os.setpriority(os.PRIO_PROCESS,0,19)
B=Path('/datos/tmp-atlas-lab/balance');R=Path('/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/auditoria-realismo')
def guard():return {'nice':os.getpriority(os.PRIO_PROCESS,0),'cpus':sorted(os.sched_getaffinity(0)),'TMPDIR':os.environ.get('TMPDIR')}
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
initial=guard();assert initial['nice']==19 and initial['cpus']==list(range(6,32))
instrument=R/'scripts/lab/auditar-realismo.py';before=sha(instrument)
verifier=B/'codex8-verificar-publicos.py';spec=importlib.util.spec_from_file_location('codex8_independent_final_synthetics',verifier);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
synthetics=module.self_tests()
for case in synthetics:
 assert case['independent']=='PASS',case
 assert case.get('audited')!='GAP',case
assert len(synthetics)==19
report=(B/'auditoria-realismo-20260930.md').read_text();P=json.loads((B/'codex8-datos-final/publicos.json').read_text());manifest=json.loads(Path('/datos/tmp-atlas-lab/datos-lab/codex8-respaldos/manifest.json').read_text())
checked=[];errors=[]
for p in P['backups']:
 m=next(x for x in manifest['backups'] if Path(x['database']).name==p['backup'])
 row=f"|{p['version']}|{p['backup']}|{p['day']:.3f}|{p['people']}|{m['sha256_gz']}|";checked.append(row)
 if row not in report:errors.append(row)
for span in [s for s in P['intervals'] if s['dayTo']==max(x['day'] for x in P['backups'] if x['version']==s['version'])]:
 rid='structure-113' if span['version']=='v13' else 'structure-421';r=next(x for x in span['rows'] if x['id']==rid)
 row=f"|{span['version']}|{rid}|{span['dayTo']-span['dayFrom']:.3f}|{r['conditionTo']:.6f}|{r['usesDelta']}|{r['stockUnchanged']}|";checked.append(row)
 if row not in report:errors.append(row)
syntax=[]
for path in [instrument,B/'codex8-laboratorio-recalcular.py',verifier]:
 ast.parse(path.read_text(),filename=str(path));syntax.append({'path':str(path),'sha256':sha(path),'syntax':'PASS'})
final=guard();after=sha(instrument);valid=initial==final
record={'generatedUTC':datetime.now(timezone.utc).isoformat(),'instrumentSha256':before,'sourceStable':before==after,'synthetic':synthetics,'PASS':len(synthetics),'auditedGaps':sum(x.get('audited')=='GAP' for x in synthetics),'resources':{'initial':initial,'final':final,'valid':valid},'additionalReportTableRows':checked,'tableMismatches':errors,'syntaxChecks':syntax,'method':'Import verifier self_tests() only with bytecode disabled; no main, --real, simulation or subprocess; fixtures in SQLite memory.'}
result=json.loads((B/'codex8-revision-final.json').read_text())
if valid and before==after:
 result['currentInstrumentSyntheticReview']=record
 result['totalComparisons']+=len(checked)
 result['tableRowsChecked']+=checked
 result['mismatches']+=errors
 result['numericStatus']='PASS' if not result['mismatches'] else 'FAIL'
 result['supplementalVerification']['instrumentSourceTransition']['changeScope']='Historical byte diff not established; current source directly tested in currentInstrumentSyntheticReview, no reliance on inferred source equivalence.'
 (B/'codex8-revision-final.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
else:(B/f'codex8-final-verificar-sinteticos-FAIL-{os.getpid()}.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'sha256':before,'synthetics':len(synthetics),'gaps':record['auditedGaps'],'tableMismatches':errors,'resourceValid':valid,'sourceStable':before==after},ensure_ascii=False))
assert valid and before==after
