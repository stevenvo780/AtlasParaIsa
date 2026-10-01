"""Supplement to final numeric review: hash lineage, Q statements and C1-C7 raw checks."""
import os,ctypes,json,hashlib,math,statistics as st,collections
from pathlib import Path
from datetime import datetime,timezone
ctypes.CDLL(None).prctl(15,b'codex8-audit',0,0,0);os.setpriority(os.PRIO_PROCESS,0,19)
def guard():return {'nice':os.getpriority(os.PRIO_PROCESS,0),'cpus':sorted(os.sched_getaffinity(0)),'TMPDIR':os.environ.get('TMPDIR')}
initial=guard();assert initial['nice']==19 and initial['cpus']==list(range(6,32))
B=Path('/datos/tmp-atlas-lab/balance');R=Path('/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/auditoria-realismo');D=Path('/datos/tmp-atlas-lab/datos-lab/codex8-c8-copia')
def load(p):return json.loads(Path(p).read_text())
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
result=load(B/'codex8-revision-final.json');C=load(B/'codex8-c8-cifras.json');L=load(B/'codex8-laboratorio-cifras.json');P=load(B/'codex8-datos-final/publicos.json')
checks=0;diff=[]
def check(label,a,b):
 global checks
 checks+=1
 if isinstance(a,float) and isinstance(b,(float,int)):same=math.isclose(a,b,rel_tol=1e-10,abs_tol=1e-7)
 else:same=a==b
 if not same:diff.append({'label':label,'expected':a,'actual':b})
for s in L['sources']:
 m=load(s['manifest']);rows=m.get('records',m.get('files'))
 for r in rows:
  p=Path(r['copy']);p=p if p.is_absolute() else Path(s['copied_directory'])/p
  check('manifest_file_sha',r['sha256'],sha(p))
 check('manifest_sha',s['manifest_sha256'],sha(s['manifest']))
# All historical rule source files digest; current key mechanism files compared directly.
sm=load(D/'SOURCE-MANIFEST.json');h=hashlib.sha256()
for r in sorted(sm['records'],key=lambda x:x['name']):
 p=Path(r['copy']);check('source_file_sha',r['sha256'],sha(p));h.update(r['name'].encode());h.update(b'\0');h.update(p.read_bytes())
check('source_digest',C['sourceDigestHistorical'],h.hexdigest())
for name in ['index.ts','society.ts','genetics.ts','diversidad.ts']:check('current_vs_panel_rules:'+name,(R/'src/world'/name).read_bytes()==(D/'source-world'/name).read_bytes(),True)
primary_criteria={};adenda=[];q2=[];resources_note={}
def bilateral_mk(xs):
 n=len(xs);s=sum((xs[j]>xs[i])-(xs[j]<xs[i]) for i in range(n) for j in range(i+1,n));v=n*(n-1)*(2*n+5)/18
 z=(s-(1 if s>0 else -1))/math.sqrt(v) if s else 0
 return s,math.erfc(abs(z)/math.sqrt(2)),st.median((xs[j]-xs[i])/(j-i) for i in range(n) for j in range(i+1,n))
for seed in range(9501,9511):
 sets={};metas={}
 for arm in ('CDC','CDD'):
  folder=D/('torre-primario' if seed<=9506 else 'torre')/f'{arm}-{seed}';xs=[load(p) for p in sorted(folder.glob('dia-*.json'))];sets[arm]=xs;metas[arm]=load(folder/'replica.json')
  check('C_identity_seed',seed,metas[arm]['seed']);check('C_identity_days',60,len(xs))
  if seed<=9506:
   end=xs[-1];prev=xs[49];window=xs[50:]
   coop={k:end['cooperacionAcumuladaPorTipo'].get(k,0)-prev['cooperacionAcumuladaPorTipo'].get(k,0) for k in ['teaching','trade','constructionHelp','foodShared']}
   if 'foodShared' in end:coop['foodShared']=end['foodShared']-prev['foodShared']
   total=sum(coop.values());us=sum(x['usosUtiles']-x['usosSinAutorResuelto'] for x in window);foreign=sum(x['usosDeInventorAjeno'] for x in window)
   deaths=end['muertesPorCausa'];pop0=metas[arm]['resumen']['poblacionInicial']
   flags={'C1':all(x['poblacion']>=16 for x in window),'C2':end['nacimientos']-prev['nacimientos']>=1 and end['fundadoresMortalesVivos']<=1,'C3':len(set(end['generacionesMortalesVivas']))>=3,
          'C4':sum(n>=5 and n/total>=.1 for n in coop.values())>=2,'C5':end['conflictosAcumulados']-prev['conflictosAcumulados']>=1,
          'C6':end['poblacion']-pop0==end['nacimientos']-sum(deaths.values()) and sum(n>0 for n in deaths.values())>=2 and all(k in ['starvation','dehydration','exposure','senescence'] for k,n in deaths.items() if n>0),
          'C7':us>=20 and foreign/us>=.15 and sum(x['usosDeInventorAjeno']>0 for x in window)>=5}
   primary_criteria[f'{arm}-{seed}']=flags
   for k,v in flags.items():check('primary_C1_C7:'+k,True,v)
 c,d=sets['CDC'],sets['CDD'];g3c=st.mean(sum(t>=3 for t in x['censoComunidades']['tamanos']) for x in c[40:]);g3d=st.mean(sum(t>=3 for t in x['censoComunidades']['tamanos']) for x in d[40:])
 n=[x['censoComunidades']['n'] for x in d[30:]];s,p,sen=bilateral_mk(n);q2.append({'seed':seed,'S':s,'p':p,'Sen':sen})
 ratio=d[-1]['nacimientos']/c[-1]['nacimientos'];frac=st.mean(any(t<=1 for t in x['censoComunidades']['tamanos']) for x in d[10:]);m=st.mean(max(x['censoComunidades']['tamanos'])/(sum(x['censoComunidades']['tamanos'])+x['censoComunidades']['sinComunidad']) for x in d[40:])
 row={'seed':seed,'g3c':g3c,'g3d':g3d,'Q1':g3d>g3c,'frag':s>0 and p<.05 and sen>=.1,'fracR':frac,'Q3ref':frac>.2,'ratioB':ratio,'Q4':ratio>=.9,'Q4ref':ratio<.8,'M':m,'Q5':m<.6};adenda.append(row)
 original=next(x for x in C['qAdendaIndependentRecalculation']['rows'] if x['seed']==seed)
 for k,v in row.items():check('Q_adenda:'+k,v,original[k])
 if seed<=9506:
  q=next(x for x in C['qPrimary']['filas'] if x['semilla']==seed)
  for k,v in [('G3_CDC',g3c),('G3_CDD',g3d),('M_CDD',m),('fracR',frac),('B',[c[-1]['nacimientos'],d[-1]['nacimientos'],60]),('ratioB',round(ratio,3))]:check('Q_primary:'+k,v,q[k])
  check('Q_primary:S',s,q['Q2']['S']);check('Q_primary:p',round(p,4),q['Q2']['p']);check('Q_primary:Sen',round(sen,4),q['Q2']['sen'])
for k,v in C['qAdendaIndependentRecalculation']['counts'].items():check('Q_adenda_count',sum(x[k] for x in adenda),v)
for k,v in C['qPrimary']['cuentas'].items():
 key={'Q2frag':'frag','Q1ref':'Q1'}.get(k,k);count=sum((not x[key]) if k=='Q1ref' else x[key] for x in adenda[:6]);check('Q_primary_count',count,v)
canonical=load(B/'codex8-datos-final/recursos.json');fail=load(B/'codex8-datos-final/recursos-replay73703-FAIL.json')
check('restored_canonical_resources',P['resources']['initial'],canonical['initial']);check('restored_canonical_resources',P['resources']['final'],canonical['final']);check('restored_canonical_source_sha',sha(B/'codex8-datos-final/publicos.json'),canonical['acceptedDataSha256']);check('failed_replay_preserved',False,fail['valid']);check('failed_replay_final_nice',-4,fail['final']['nice'])
instrument=R/'scripts/lab/auditar-realismo.py';review=load(B/'codex8-revision-instrumento.json')
# Recover exactly the pre-wrapper-change source representation and prove why its SHA changed.
now=instrument.read_text();old=now.replace("    valid=initial==final and final['nice']==19\n    resource_path=dest/'recursos.json' if valid else dest/f'recursos-FAIL-{os.getpid()}.json'\n    resource_path.write_text(json.dumps({'initial':initial,'final':final,'valid':valid},indent=2)+'\\n')\n    assert valid, 'compute resource drift; prior results preserved'\n", "    (dest/'recursos.json').write_text(json.dumps({'initial':initial,'final':final,'valid':initial==final and final['nice']==19},indent=2)+'\\n')\n    assert initial==final and final['nice']==19, 'compute resource drift; prior results preserved'\n")
reconstructed_sha=hashlib.sha256(old.encode()).hexdigest()
# Record reconstruction rather than blindly treating post-review source as the same source.
source_transition={'currentSHA256':sha(instrument),'reviewedSyntheticSHA256':review['finalInstrumentReview']['instrumentSha256'],'reconstructedPreWrapperSHA256':reconstructed_sha,'exactRecoveredMatch':reconstructed_sha==review['finalInstrumentReview']['instrumentSha256'],'changeScope':'main resource artifact filename/guard only; objects, recipes, receipts, inspect_backup, intervals unchanged'}
final=guard();valid=initial==final
extra={'resources':{'initial':initial,'final':final,'valid':valid},'comparisons':checks,'mismatches':diff,'Q1Q5Independent':adenda,'Q2Independent':q2,'primaryC1C7Independent':primary_criteria,'instrumentSourceTransition':source_transition,'canonicalResourceArtifactSHA256':sha(B/'codex8-datos-final/recursos.json'),'failedResourceArtifactSHA256':sha(B/'codex8-datos-final/recursos-replay73703-FAIL.json'),'generatedUTC':datetime.now(timezone.utc).isoformat()}
out=B/('codex8-revision-final.json' if valid else f'codex8-final-verificar-extra-FAIL-{os.getpid()}.json')
if valid:
 result['supplementalVerification']=extra;result['totalComparisons']+=checks;result['mismatches']+=diff;result['numericStatus']='PASS' if not result['mismatches'] else 'FAIL';result['limitations']=[x for x in result['limitations'] if not x.startswith('Q and C1-C7')];out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
else:out.write_text(json.dumps(extra,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'comparisons':checks,'mismatches':diff,'resourceValid':valid,'sourceTransition':source_transition},ensure_ascii=False));assert valid
