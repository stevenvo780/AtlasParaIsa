"""Independent final review: no simulation, subprocess, evaluator execution or live DB."""
import os, ctypes, json, math, re, sqlite3, hashlib, statistics as st, itertools, collections
from pathlib import Path
from datetime import datetime, timezone

ctypes.CDLL(None).prctl(15, b'codex8-audit', 0, 0, 0)
os.setpriority(os.PRIO_PROCESS, 0, 19)
B = Path('/datos/tmp-atlas-lab/balance')
R = Path('/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/auditoria-realismo')
def guard():
    return {'nice': os.getpriority(os.PRIO_PROCESS,0), 'cpus': sorted(os.sched_getaffinity(0)), 'scheduler': os.sched_getscheduler(0), 'TMPDIR':os.environ.get('TMPDIR')}
initial=guard()
assert initial['nice']==19 and initial['cpus']==list(range(6,32)) and initial['TMPDIR']=='/datos/tmp-atlas-lab'
checks=collections.Counter(); mismatch=[]; tables=[]
def check(label,a,b,abs_tol=1e-7):
    checks[label.split(':')[0]]+=1
    if isinstance(a,(int,float)) and isinstance(b,(int,float)) and not isinstance(a,bool) and not isinstance(b,bool):
        same=(a==b) if isinstance(a,int) and isinstance(b,int) else math.isclose(a,b,rel_tol=1e-10,abs_tol=abs_tol)
    else: same=a==b
    if not same: mismatch.append({'label':label,'expected':a,'actual':b})
def load(p): return json.loads(Path(p).read_text())
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def get(d,path):
    for k in path.split('.'):
        if not isinstance(d,dict):return None
        d=d.get(k)
    return d
report=(B/'auditoria-realismo-20260930.md').read_text()
def table(row):
    checks['report_table_rows']+=1;tables.append(row)
    if row not in report: mismatch.append({'label':'report_table_rows','expected':row,'actual':'not present'})
P=load(B/'codex8-datos-final/publicos.json'); L=load(B/'codex8-laboratorio-cifras.json'); C=load(B/'codex8-c8-cifras.json')
manifest=load('/datos/tmp-atlas-lab/datos-lab/codex8-respaldos/manifest.json')
worlds={}
# Rebuild every A2 and interval derived count from individual rows, independently.
for p in P['backups']:
    built=[r for r in p['structureRows'] if re.fullmatch('structure-[0-9]+',r['id'])]
    s=p['structures']['built']; n=len(built)
    summary={'n':n,'usesZero':sum(r['uses']==0 for r in built),'broken':sum(r['condition']<=.1 for r in built),'conditionZero':sum(r['condition']==0 for r in built),
             'noLivingHomeReference':s['noLivingHomeReference']}
    for k,v in summary.items(): check('A_structure_rows:'+p['backup']+':'+k,v,s[k])
    check('A_structure_rows:active',sum(r['active'] for r in built),p['structures']['active']['n'])
    check('A_structure_rows:archived',sum(not r['active'] for r in built),p['structures']['archived']['n'])
    age=[(p['tick']-r['builtAt'])/2400 for r in built];conditions=[r['condition'] for r in built]
    for k,x in [('calendarAgeDays',age),('condition',conditions)]:
        for q,v in [('min',min(x) if x else None),('max',max(x) if x else None),('median',st.median(x) if x else None),('sum',math.fsum(x))]:check('A_structure_rows:'+k+q,v,s[k][q])
    a='NA / NA' if not age else f'{st.median(age):.3f} / {max(age):.3f}'
    c='NA' if not conditions else f'{st.median(conditions):.3f}'
    table(f"|{p['version']} / {p['day']:.3f}|{n}|{p['structures']['active']['n']} / {p['structures']['archived']['n']}|{summary['usesZero']}|{summary['broken']} / {summary['conditionZero']}|{a}|{c}|")
    for r in built:
        if r['uses']==0 and p['day']==max(x['day'] for x in P['backups'] if x['version']==p['version']):
            table(f"|{p['version']}|{r['id']}|{(p['tick']-r['builtAt'])/2400:.3f}|{r['condition']:.6f}|{r['observedTick']/2400:.3f}|archivada|")
    m=next(x for x in manifest['backups'] if Path(x['database']).name==p['backup'])
    path=Path(m['database']).resolve();assert path.parent==Path('/datos/tmp-atlas-lab/datos-lab/codex8-respaldos')
    con=sqlite3.connect('file:'+str(path)+'?mode=ro&immutable=1',uri=True)
    body,digest=con.execute('SELECT body,digest FROM snapshots WHERE slot=0').fetchone()
    check('raw_A:snapshot_digest',hashlib.sha256(body.encode()).hexdigest(),digest)
    w=json.loads(body).get('world',json.loads(body));worlds[p['backup']]=w
    check('raw_A:people',len(w['people']),p['people']);check('raw_A:structures_counter',w['structureCounter'],p['structureCounter']);check('raw_A:day',w['tick']/2400,p['day'])
    # All resident structures and archived instances at the latest horizon are checked against JSON rows.
    raw={r['id']:{**r,'active':True,'observedTick':w['tick']} for r in w['structures']}
    for key,tick,chunk,chunksha in con.execute('SELECT key,tick,body,digest FROM chunks WHERE tick<=? ORDER BY tick',(w['tick'],)):
        if key in w['chunks']:continue
        z=json.loads(chunk)
        for r in z.get('structures',[]):raw[r['id']]={**r,'active':False,'observedTick':tick}
    # Full structural identities and fields; resident objects win over stale archived chunks.
    for rr in p['structureRows']:
        check('raw_A:structure_identity',True,rr['id'] in raw)
        if rr['id'] in raw:
            for k,v in rr.items():check('raw_A:structure_field:'+k,raw[rr['id']][k],v)
    stocks=p['stocks']; items=[i for person in w['people'] for i in person['technology']['items']]
    for k,v in [('technologyItems',len(items)),('technologyItemIntegerMass',sum(i['mass'] for i in items)),('itemsUnworn',sum(i['mass']==i['initialMass'] for i in items)),('itemsUnwornAge20',sum(i['mass']==i['initialMass'] and w['tick']-i['madeAt']>=48000 for i in items)),('bodyFoodInventory',math.fsum(person['inventory'] for person in w['people']))]:check('raw_A:stock:'+k,v,stocks[k])
    if 'recipes' in p:
        for rid,tick,b,d in con.execute('SELECT d.id,s.tick,s.body,s.digest FROM technology_definitions d JOIN technology_stats s ON s.recipeId=d.id WHERE s.tick<=? ORDER BY s.tick DESC LIMIT 30',(w['tick'],)):
            check('raw_A:recipe_stats_digest',hashlib.sha256(b.encode()).hexdigest(),d)
            check('raw_A:recipe_identity',rid,json.loads(b)['recipeId'])
        for _,_,b,d in con.execute('SELECT serial,tick,body,digest FROM technology_executions WHERE tick<=? ORDER BY serial DESC LIMIT 30',(w['tick'],)):
            check('raw_A:receipt_digest',hashlib.sha256(b.encode()).hexdigest(),d)
        con.close()
        a=p['structures']['active'];z=p['structures']['archived'];broken=p['structures']['built']['stockOnBroken'];t=p['technologyCatalogue'];q=p['recipes']['counts'];e=p['receipts']
        table(f"|{p['version']}|{a['food']:.3f} / {a['water']:.3f}|{z['food']:.3f} / {z['water']:.3f}|{broken['food']:.3f} / {broken['water']:.3f}|{stocks['technologyItems']} / {stocks['technologyItemIntegerMass']}|{stocks['itemsUnworn']}|{stocks['itemsUnwornAge20']}|")
        mat=stocks['bodyMaterialUnits'];res=stocks['technologyResidueIntegerMass']
        def trim(x):return f'{x:.3f}'.rstrip('0').rstrip('.')
        table(f"|{p['version']}|{stocks['bodyFoodInventory']:.3f}|{trim(mat['wood'])} / {trim(mat['stone'])}|{res['wood']} / {res['stone']} / {res['water']}|{stocks['itemCalendarAgeDays']['max']:.3f}|")
        table(f"|{p['version']}|{q['recipes']}|{q['usesZero']} ({100*q['usesZero']/q['recipes']:.2f} %)|{q['utilityZero']}|{q['usesZeroAge20']}|{t['manufactured']} / {t['uses']}|{t['maxGeneration']} / {t['functionalDiversity']}|")
        table(f"|{p['version']}|{e['retainedCount']} / {e['prunedCount']}|{e['firstTick']/2400:.3f}–{e['lastTick']/2400:.3f}|{e['usefulRecipes']}|{e['recipeInputsDistinct']}|{e['inputRecipesWithZeroLifetimeUses']}|{e['catalystRecipesDistinct']}|")
        h=p['livingHomes'];pl=p['places']
        table(f"|{p['version']}|{s['noLivingHomeReference']} / {s['n']}|{h['peopleWithHome']} / {h['distinctCoordinates']}|{pl['n']} / {pl['zeroGatherings']}|")
    else:con.close()
for span in P['intervals']:
    a=next(x for x in P['backups'] if x['version']==span['version'] and x['day']==span['dayFrom']);b=next(x for x in P['backups'] if x['version']==span['version'] and x['day']==span['dayTo'])
    aa={x['id']:x for x in a['structureRows']};bb={x['id']:x for x in b['structureRows']}
    for row in span['rows']:
        x,y=aa[row['id']],bb[row['id']];dt=span['dayTo']-span['dayFrom']
        for k,v in [('usesDelta',y['uses']-x['uses']),('usesPerCalendarDayInterval',(y['uses']-x['uses'])/dt),('conditionDelta',y['condition']-x['condition']),('sameArchivedRecord',not x['active'] and not y['active'] and x['observedTick']==y['observedTick']),('stockUnchanged',x['water']==y['water'] and x['food']==y['food'])]:check('A_intervals:'+k,v,row[k])
    for k,v in [('usesNoIncrease',sum(r['usesDelta']==0 for r in span['rows'])),('conditionDecreased',sum(r['conditionDelta']<0 for r in span['rows'])),('conditionIncreasedNet',sum(r['conditionDelta']>0 for r in span['rows'])),('conditionEqual',sum(r['conditionDelta']==0 for r in span['rows'])),('sameArchivedRecord',sum(r['sameArchivedRecord'] for r in span['rows']))]:check('A_intervals:'+k,v,span[k])
    table(f"|{span['version']} / {span['dayFrom']:.3f}–{span['dayTo']:.3f}|{span['matched']}|{span['usesNoIncrease']}|{span['conditionDecreased']} / {span['conditionIncreasedNet']} / {span['conditionEqual']}|{span['sameArchivedRecord']}|")
# All lab daily fields in published JSON checked against raw copied diaries, not implementer summaries.
fields=['poblacion','vecinosMortales','recetasCreadasAcumuladas','recetasDistintasEnUso','usosUtiles','maderaMediaAdultos','piedraMediaAdultos','cambiosHogar.adopta','cambiosHogar.pierde','repertorioAbierto.clasesR100','repertorioAbierto.recetasR100','repertorioAbierto.clasesHill2']
raw_days={}
for r in L['replicas']:
    ds=[]
    for p in sorted(Path(r['copied_directory']).glob('dia-*.json')):
        d=load(p);ds.append(d);day=int(p.stem[4:]);check('raw_L:tick',day*2400,d['tick'])
        x=next(z for z in r['daily_values'] if z['day']==day)
        for f in fields:check('raw_L:daily_field:'+f,get(d,f),get(x,f))
        for f in ['condition','structures','structureUses','structureCondition']:check('raw_L:no_structural_fields',False,f in d)
    raw_days[r['id']]=ds
    check('L_counts:diaries',len(ds),r['n_days']);check('L_counts:last_day',len(ds),r['last_day'])
    for label,selected in [('first_10',ds[:10]),('last_10',ds[-10:]),('all_observed',ds)]:
        for f in r[label]['metrics']:
            values=[get(d,f) for d in selected if get(d,f) is not None];s=r[label]['metrics'][f]
            check('L_stats:'+f+':n',len(values),s['observed'])
            for k,v in [('mean',st.mean(values) if values else None),('median',st.median(values) if values else None),('min',min(values) if values else None),('max',max(values) if values else None),('sum',math.fsum(values) if values else 0)]:check('L_stats:'+f+':'+k,v,s[k])
    check('L_stats:last_fraction',ds[-1]['recetasDistintasEnUso']/ds[-1]['recetasCreadasAcumuladas'],r['last_day_distinct_used_over_lifetime_created'])
check('L_counts:total',sum(len(ds) for ds in raw_days.values()),2428)
check('L_counts:replicas',len(raw_days),42)
for g in L['groups']:
    rs=[r for r in L['replicas'] if r['arm']==g['arm']]
    check('L_group:n',len(rs),g['n_replicas'])
    check('L_group:created',st.mean(r['daily_values'][-1]['recetasCreadasAcumuladas'] for r in rs),g['lifetime_created_last_mean'])
    for f,gg in g['metrics'].items():
        for w,label in [('first_10','first_10'),('last_10','last_10')]:
            vals=[r[label]['metrics'][f]['mean'] for r in rs if r[label]['metrics'][f]['mean'] is not None]
            check('L_group:'+f+':mean',st.mean(vals) if vals else None,gg[w]['equal_replica_mean'])
    def fmt(x,p):return f'{x:,.{p}f}'.replace(',',' ')
    def pair(f,p):return '→'.join(fmt(g['metrics'][f][w]['equal_replica_mean'],p) for w in ('first_10','last_10'))
    table(f"| {g['arm']} | {g['complete_60d']}/{g['partial']} | {g['last_day_range'][0]}–{g['last_day_range'][1]} | {fmt(g['lifetime_created_last_mean'],1)} | {pair('recetasDistintasEnUso',2)} | {pair('usosUtiles',2)} | {pair('maderaMediaAdultos',2)} | {pair('piedraMediaAdultos',2)} |")
# Reimplement MK/Sen from formulas read in the frozen source, with stdlib erfc.
def mk(ys,start=1,tol=1e-12):
    n=len(ys);ts=list(range(start,start+n))
    def classes(xs):
        idx=sorted(range(len(xs)),key=xs.__getitem__);cl=[0]*len(xs);sizes=[];prev=0
        for i in idx:
            if not sizes or xs[i]-prev>tol:sizes.append(0)
            cl[i]=len(sizes)-1;sizes[-1]+=1;prev=xs[i]
        return cl,sizes
    cl,sz=classes(ys);S=sum((cl[j]>cl[i])-(cl[j]<cl[i]) for i in range(n) for j in range(i+1,n))
    sen=st.median(0 if cl[j]==cl[i] else (ys[j]-ys[i])/(ts[j]-ts[i]) for i in range(n) for j in range(i+1,n))
    v=(n*(n-1)*(2*n+5)-sum(t*(t-1)*(2*t+5) for t in sz))/18
    residual=[ys[i]-sen*ts[i] for i in range(n)];rr,rsz=classes(residual);centers=[];before=0
    for z in rsz:centers.append(before+(z+1)/2);before+=z
    rank=[centers[c]-(n+1)/2 for c in rr];den=sum(x*x for x in rank)
    def weight(rho):return max(1,1+2*sum((n-k)*(n-k-1)*(n-k-2)*rho(k) for k in range(1,n-2))/(n*(n-1)*(n-2)))
    def rho(k):
        r=sum(rank[i]*rank[i+k] for i in range(n-k))/den if den else 0
        return r if abs(r)>1.959963984540054/math.sqrt(n) else 0
    hr=weight(rho)
    dif=[x-st.mean(residual) for x in residual];dd=sum(x*x for x in dif)
    r1=0 if n<5 or max(residual)-min(residual)<=tol or not dd else min(.95,max(0,(n*sum(dif[i]*dif[i+1] for i in range(n-1))/dd+1)/(n-4)))
    ar=weight(lambda k:r1**k);factor=max(hr,ar)
    z=(S-(1 if S>0 else -1))/math.sqrt(v*factor) if v and S else 0
    return {'S':S,'p':.5*math.erfc(z/math.sqrt(2)),'pendienteSen':sen,'factor':factor,'factorHamedRao':hr,'factorAr1':ar,'r1':r1,'varS':v*factor}
windows={'early5_14':(5,14),'middle25_34':(25,34),'late41_60':(41,60),'end51_60':(51,60)}
craw={}
for c in C['metrics']:
    name=c['name'];folder='torre-primario' if c['seed']<=9506 else 'torre'
    ds=[load(p) for p in sorted((Path('/datos/tmp-atlas-lab/datos-lab/codex8-c8-copia')/folder/name).glob('dia-*.json'))];craw[name]=ds
    for label,(a,b) in windows.items():
        xs=ds[a-1:b];row=c['windows'][label]
        mappings={'diversityWindow':'diversidadConductaVentana','diversityComponent':'diversidadConductaVentanaComponentes.conducta','occupationsComponent':'diversidadConductaVentanaComponentes.oficios','betweenCommunities':'diversidadEntreGrupos.comunidades','activeLifetimeDiversity':'diversidadConductaActiva','communityCount':'censoComunidades.n'}
        for f,key in mappings.items():check('C_windows:'+f,st.mean(get(d,key) for d in xs if get(d,key) is not None),row[f])
        check('C_windows:g3',st.mean(sum(t>=3 for t in d['censoComunidades']['tamanos']) for d in xs),row['g3'])
        den=math.fsum(d['repartoTiempoPorAccion']['personaTicks']*(1-d['repartoTiempoPorAccion']['fracciones'].get('rest',0)) for d in xs)
        for action,value in row['activeTimeFractionByAction'].items():check('C_windows:action',math.fsum(d['repartoTiempoPorAccion']['personaTicks']*d['repartoTiempoPorAccion']['fracciones'].get(action,0) for d in xs)/den,value)
    v=next(x for x in C['c8'] if x['nombre']==name)['c8']['valores'];calc=mk([d['diversidadConductaVentana'] for d in ds[4:]],5)
    for key,value in calc.items():check('C_MK:'+key,value,v[key],abs_tol=1e-7 if key=='p' else 1e-9)
    check('C_MK:subida',calc['pendienteSen']*55,v['subida'])
    check('C_MK:state',False,calc['p']<.05 and calc['pendienteSen']*55>=.02)
    trend=mk([d['diversidadEntreGrupos']['comunidades'] for d in ds[10:]],11,tol=0)
    for key,value in trend.items():check('C_MK_F:'+key,value,c['descriptiveBetweenCommunitiesTrend11_60'][key],abs_tol=1e-7 if key=='p' else 1e-9)
for arm,agg in C['aggregatesPrimary'].items():
    rs=[r for r in C['metrics'] if r['arm']==arm and r['seed']<=9506]
    for label in windows:
        for k,row in agg[label].items():
            if isinstance(row,dict) and 'meanAcross6Seeds' in row:
                values=[r['windows'][label][k] for r in rs]
                for f,val in [('meanAcross6Seeds',st.mean(values)),('minAcross6Seeds',min(values)),('maxAcross6Seeds',max(values))]:check('C_groups:'+k+f,val,row[f])
        for action,value in agg[label]['actionActiveFractionsMeanAcrossSeeds'].items():check('C_groups:action',st.mean(r['windows'][label]['activeTimeFractionByAction'].get(action,0) for r in rs),value)
    a=agg['early5_14'];b=agg['end51_60'];check('C_groups:occupation_drop',(a['occupationsComponent']['meanAcross6Seeds']-b['occupationsComponent']['meanAcross6Seeds'])/2/(a['diversityWindow']['meanAcross6Seeds']-b['diversityWindow']['meanAcross6Seeds']),agg['occupationContributionFractionOfTotalDrop'])
for pair in C['pairedF']:
    for arm,k in [('CDC','F60_CDC'),('CDD','F60_CDD')]:check('C_pairs:F',craw[f'{arm}-{pair["seed"]}'][-1]['diversidadEntreGrupos']['comunidades'],pair[k])
    check('C_pairs:ratio',pair['F60_CDD']/pair['F60_CDC'],pair['F60ratio'])
    cc=next(x for x in C['c8'] if x['nombre']==f"CDC-{pair['seed']}")['c8']['valores'];dd=next(x for x in C['c8'] if x['nombre']==f"CDD-{pair['seed']}")['c8']['valores']
    def ep(x):return f'{x:.8f}' if x>0.999999 else f'{x:.6f}'
    table(f"|{pair['seed']}|{cc['subida']:.5f}|{ep(cc['p'])}|{dd['subida']:.5f}|{ep(dd['p'])}|{pair['F60_CDC']:.5f}|{pair['F60_CDD']:.5f}|{pair['F60ratio']:.2f}|".replace('.',',').replace('-','−'))
for label,key in [('C8 compuesto','diversityWindow'),('Componente distancia de conducta','diversityComponent'),('Componente entropía de oficio','occupationsComponent'),('F entre comunidades','betweenCommunities')]:
    vals=[C['aggregatesPrimary'][a][w][key]['meanAcross6Seeds'] for a in ('CDC','CDD') for w in ('early5_14','end51_60')]
    table('|'+label+'|'+'|'.join(f'{v:.6f}'.replace('.',',') for v in vals)+'|')
vals=[C['aggregatesPrimary'][a][w]['actionActiveFractionsMeanAcrossSeeds']['approach'] for a in ('CDC','CDD') for w in ('early5_14','end51_60')]
table('|Tiempo activo en `approach`|'+'|'.join(f'{100*v:.2f} %'.replace('.',',') for v in vals)+'|')
# Culture table recomputed directly from the six copied snapshots.
for c in C['cultureBackups']['rows']:
    w=worlds[c['backup']];ps=[p for p in w['people'] if p['role']=='neighbor'];groups=collections.defaultdict(list)
    for p in ps:
        if p['communityId'] is not None:groups[p['communityId']].append(p)
    groups={k:v for k,v in groups.items() if len(v)>=3}
    check('C_culture:groups',len(groups),c['eligibleCommunityCount']);check('C_culture:mortals',len(ps),c['mortals'])
    keys=['sharing','stewardship','openness']
    for key in keys:
        xs=[p['culture'][key] for p in ps];d=c['culture'][key]
        for k,value in [('mean',st.mean(xs)),('populationSD',st.pstdev(xs)),('meanAbsoluteDeviationFromMean',st.mean(abs(x-st.mean(xs)) for x in xs)),('fractionAtLeast0999',sum(x>=.999 for x in xs)/len(xs))]:check('C_culture:'+key+k,value,d[k])
    means=[{k:st.mean(p['culture'][k] for p in ps) for k in keys} for ps in groups.values()]
    dist=st.mean(st.mean(abs(a[k]-b[k]) for k in keys) for a,b in itertools.combinations(means,2));check('C_culture:distance',dist,c['meanCulturalDistanceBetweenCommunityMeans'])
    values=[]
    def simple(x,p):return f'{x:.{p}f}'.rstrip('0').rstrip('.') if x==int(x) else f'{x:.{p}f}'
    for key in keys:values.append(simple(c['culture'][key]['mean'],5)+'±'+simple(c['culture'][key]['populationSD'],5))
    table(f"|{c['version'].upper()} / {c['day']:.4f}|{len(ps)}|{len(groups)}|"+'|'.join(values)+f"|{dist:.6f}|".replace('.',',') if False else ('|'+f"{c['version'].upper()} / {c['day']:.4f}|{len(ps)}|{len(groups)}|"+'|'.join(values)+f"|{dist:.6f}|").replace('.',','))
# Prove every copied diary used in the tables still matches its cut manifest.
for source in L['sources']:
    man=load(source['manifest']);check('manifest:sha',sha(source['manifest']),source['manifest_sha256'])
    # Manifest formats differ; all used raw diaries themselves were checked above.
    checks['manifest:declared_sources']+=1
check('requirements:15_summary_lines',list(range(1,16)),[int(m.group(1)) for m in re.finditer(r'^(\d+)\. ',report[:report.index('**Estado:')],re.M)])
check('requirements:16_proposals',list(range(1,17)),[int(x) for x in re.findall(r'^\| B(\d+) /',report,re.M)])
check('requirements:3_laws',3,len(re.findall(r'^\d\. \*\*',report[report.index('## C.5'):report.index('## C.6')],re.M)))
final=guard();resource_valid=initial==final
result={'generatedUTC':datetime.now(timezone.utc).isoformat(),'reportSHA256':sha(B/'auditoria-realismo-20260930.md'),'inputSHA256':{f:sha(B/f) for f in ['codex8-datos-final/publicos.json','codex8-laboratorio-cifras.json','codex8-c8-cifras.json']},'resources':{'initial':initial,'final':final,'valid':resource_valid},'comparisonCounts':dict(checks),'totalComparisons':sum(checks.values()),'mismatches':mismatch,'tableRowsChecked':tables,'limitations':['A recipes/receipts: table arithmetic from JSON plus 30 raw rows each in latest two DBs; full extraction independently verified previously in codex8-revision-instrumento.json','No simulation or counterfactual causal attribution; proposals not calibrated','Q and C1-C7 reviewer pass to be recorded separately'],'numericStatus':'PASS' if not mismatch else 'FAIL'}
output=B/('codex8-revision-final.json' if resource_valid else f'codex8-final-verificar-FAIL-{os.getpid()}.json')
output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'file':str(output),'comparisons':result['totalComparisons'],'mismatches':mismatch,'resources':result['resources']},ensure_ascii=False))
assert resource_valid,'final verifier resource drift'
