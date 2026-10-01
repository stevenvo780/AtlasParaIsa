#!/usr/bin/env python3
"""Reproduce Culture/Q1-Q5 from frozen copies; no simulation or live data.

First run codex8-c8-recalcular.mts separately with codex8-node and nice/CPU
guards to generate codex8-c8-node.json. This reader never launches children.

TMPDIR=/datos/tmp-atlas-lab taskset -c 6-31 nice -n 19 \
  /datos/tmp-atlas-lab/codex8-runtime/codex8-python \
  /datos/tmp-atlas-lab/balance/codex8-c8-recalcular.py --node-json \
  /datos/tmp-atlas-lab/balance/codex8-c8-node.json

Writes only codex8-c8-cifras.json beside this script. Existing results are used
only for an exact semantic comparison, never as computational input.
"""
import datetime
import ctypes
import hashlib
import importlib.util
import itertools
import json
import os
from pathlib import Path
import sqlite3
import statistics
import sys
import argparse

sys.dont_write_bytecode = True
REPO=Path('/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/auditoria-realismo')
ROOT=Path('/datos/tmp-atlas-lab/datos-lab/codex8-c8-copia')
BALANCE=Path('/datos/tmp-atlas-lab/balance')
OUTPUT=BALANCE/'codex8-c8-cifras.json'
EXPECTED_SHA='18062f5063cddf7847051490c5f6ca34db81da4c'
WINDOWS={'early5_14':(5,14),'middle25_34':(25,34),'late41_60':(41,60),'end51_60':(51,60)}

def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def guard():
    nice=os.getpriority(os.PRIO_PROCESS,0)
    cpus=sorted(os.sched_getaffinity(0))
    assert nice==19 and cpus==list(range(6,32)),(nice,cpus)
    return {'pid':os.getpid(),'comm':Path('/proc/self/comm').read_text().strip(),
            'nice':nice,'cpus':cpus,'utc':utc()}

def load(path):
    return json.loads(Path(path).read_text())

def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def flatten(obj,prefix=''):
    result={}
    for k,v in obj.items():
        key=prefix+'.'+k if prefix else k
        if isinstance(v,dict):result.update(flatten(v,key))
        else:result[key]=v
    return result

def summaries(xs):
    mu=statistics.mean(xs);med=statistics.median(xs)
    return {'mean':mu,'populationSD':statistics.pstdev(xs),
            'meanAbsoluteDeviationFromMean':statistics.mean(abs(x-mu) for x in xs),
            'medianAbsoluteDeviation':statistics.median(abs(x-med) for x in xs),
            'min':min(xs),'max':max(xs),'fractionAtLeast0999':sum(x>=.999 for x in xs)/len(xs)}

assert ctypes.CDLL(None).prctl(15,b'codex8-audit',0,0,0)==0
launch_nice=os.getpriority(os.PRIO_PROCESS,0)
os.setpriority(os.PRIO_PROCESS,0,19)
initial=guard()
previous=load(OUTPUT) if OUTPUT.exists() else None
previous_artifact_sha=sha256(OUTPUT) if OUTPUT.exists() else None
manifest=load(ROOT/'MANIFEST.json')
for record in manifest['records']:
    assert sha256(record['copy'])==record['sha256'],record['copy']
parser=argparse.ArgumentParser()
parser.add_argument('--node-json',type=Path,default=BALANCE/'codex8-c8-node.json')
parser.add_argument('--output',type=Path,default=OUTPUT)
args=parser.parse_args()
OUTPUT=args.output
node=load(args.node_json)
for point in ('initial','final'):
    assert node['resourceGuard'][point]['nice']==19 and node['resourceGuard'][point]['cpus']=='6-31'
out={k:node[k] for k in ('evaluatorSha256','syntheticTests','originalPrimaryComparisonMismatches','c8')}
out['cutUTC']=manifest['completedUTC']
source_manifest=load(ROOT/'SOURCE-MANIFEST.json')
assert source_manifest['sha']==EXPECTED_SHA
assert sha256(ROOT/'SOURCE-MANIFEST.json')==node['sourceManifestSHA256']
h=hashlib.sha256()
for record in sorted(source_manifest['records'],key=lambda r:r['name']):
    assert sha256(record['copy'])==record['sha256']
    h.update(record['name'].encode());h.update(b'\0');h.update(Path(record['copy']).read_bytes())
digest=h.hexdigest();records={};identities=[];errors=[]
assert digest==source_manifest['worldSourceDigest']==node['sourceDigestHistorical']
for folder in ('torre-primario','torre'):
    for arm in sorted((ROOT/folder).iterdir()):
        if not arm.is_dir():continue
        meta=load(arm/'replica.json');seed=int(arm.name.split('-')[-1])
        days={int(p.stem[4:]):load(p) for p in sorted(arm.glob('dia-*.json'))}
        records[arm.name]=(meta,days)
        checks={'seed':meta['seed']==seed,'sha':meta['sha']==EXPECTED_SHA,
                'digest':meta['digest']==digest,'days60':meta['dias']==60 and set(days)==set(range(1,61)),
                'ticks':all(v['tick']==d*2400 for d,v in days.items()),
                'metricsVersion2':meta['metricasVersion']==2,
                'governorOff':meta['gobernador']=='no-ejecutado; replica de leyes, no del servidor',
                'censusMortals':all(sum(v['censoComunidades']['tamanos'])+v['censoComunidades']['sinComunidad']==v['vecinosMortales'] for v in days.values())}
        errors.extend(f'{arm.name}:{key}' for key,value in checks.items() if not value)
        identities.append({'name':arm.name,'set':folder,'seed':seed,'sha':meta['sha'],
                           'sourceDigest':meta['digest'],'finalWorldDigest':meta['digestoMundoFinal'],
                           'params':meta['params'],'checks':checks})
assert not errors,errors
pairs=[]
for seed in range(9501,9511):
    c=flatten(records[f'CDC-{seed}'][0]['params']);d=flatten(records[f'CDD-{seed}'][0]['params'])
    diff={k:[c.get(k),d.get(k)] for k in set(c)|set(d) if c.get(k)!=d.get(k)}
    assert diff=={'social.disolucion':[0,1],'social.maxComunidades':[8,64],'limites.comunidades':[1303552,64]},diff
    pairs.append({'seed':seed,'paramDifferences':diff})
spec=importlib.util.spec_from_file_location('frozen_comd',ROOT/'evaluar.py')
ev=importlib.util.module_from_spec(spec);spec.loader.exec_module(ev)
# The evaluator returns B as a tuple; JSON represents the same ordered triple
# as an array. Compare JSON representations, preserving every value/field.
q=json.loads(json.dumps(ev.evaluar(str(ROOT/'torre-primario'))));metrics=[]
for name,(meta,days) in records.items():
    row={'name':name,'seed':meta['seed'],'arm':name.split('-')[0],
         'day60Population':days[60]['vecinosMortales'],'day60Births':days[60]['nacimientos'],'windows':{}}
    for label,(a,b) in WINDOWS.items():
        xs=[days[d] for d in range(a,b+1)];time={};active=0
        for day in xs:
            f=day['repartoTiempoPorAccion']['fracciones'];n=day['repartoTiempoPorAccion']['personaTicks']
            active+=n*(1-f.get('rest',0))
            for k,v in f.items():
                if k!='rest':time[k]=time.get(k,0)+n*v
        time={k:v/active for k,v in time.items()}
        row['windows'][label]={
            'days':[a,b],'nDays':len(xs),
            'diversityWindow':statistics.mean(x['diversidadConductaVentana'] for x in xs),
            'diversityComponent':statistics.mean(x['diversidadConductaVentanaComponentes']['conducta'] for x in xs),
            'occupationsComponent':statistics.mean(x['diversidadConductaVentanaComponentes']['oficios'] for x in xs),
            'activeLifetimeDiversity':statistics.mean(x['diversidadConductaActiva'] for x in xs),
            'betweenCommunities':statistics.mean(x['diversidadEntreGrupos']['comunidades'] for x in xs if x['diversidadEntreGrupos']['comunidades'] is not None),
            'communityMetricNonNull':sum(x['diversidadEntreGrupos']['comunidades'] is not None for x in xs),
            'g3':statistics.mean(ev.g3(x) for x in xs),
            'communityCount':statistics.mean(x['censoComunidades']['n'] for x in xs),
            'activeTimeFractionByAction':time}
    row['day60BetweenCommunities']=days[60]['diversidadEntreGrupos']['comunidades']
    row['day60DiversityWindow']=days[60]['diversidadConductaVentana']
    row['communityCapDays41_60']=sum(days[d]['censoComunidades']['n']==meta['params']['social']['maxComunidades'] for d in range(41,61))
    row['descriptiveBetweenCommunitiesTrend11_60']=node['betweenTrends'][name]
    metrics.append(row)
out.update({'snapshotManifestSha256':sha256(ROOT/'MANIFEST.json'),'sourceDigestHistorical':digest,
            'identities':identities,'pairedParams':pairs,'identityErrors':errors,'qPrimary':q,'metrics':metrics})
backup_manifest=Path('/datos/tmp-atlas-lab/datos-lab/codex8-respaldos/manifest.json');backups=load(backup_manifest);culture_rows=[]
keys=('sharing','stewardship','openness')
for backup in backups['backups']:
    con=sqlite3.connect('file:'+backup['database']+'?mode=ro&immutable=1',uri=True)
    body,snapshot_digest=con.execute('SELECT body,digest FROM snapshots WHERE slot=0').fetchone();con.close()
    snap=json.loads(body);world=snap.get('world',snap)
    people=[person for person in world['people'] if person['role']=='neighbor'];groups={}
    for person in people:
        if person['communityId'] is not None:groups.setdefault(person['communityId'],[]).append(person)
    groups={k:v for k,v in groups.items() if len(v)>=3}
    means={g:{k:statistics.mean(p['culture'][k] for p in ps) for k in keys} for g,ps in groups.items()}
    distance=[statistics.mean(abs(a[k]-b[k]) for k in keys) for a,b in itertools.combinations(means.values(),2)]
    culture={k:summaries([p['culture'][k] for p in people]) for k in keys}
    between={k:summaries([v[k] for v in means.values()]) for k in keys} if means else {}
    trait={k:summaries([p['traits'][k] for p in people]) for k in ('curiosity','sociability','industriousness','care','resilience')}
    culture_rows.append({'version':backup['version'],'backup':Path(backup['database']).name,
        'backupCompressedSHA256':backup['sha256_gz'],'snapshotDigest':snapshot_digest,
        'seed':world['seed'],'tick':world['tick'],'day':world['tick']/2400,'mortals':len(people),
        'allCommunities':len(world['communities']),'eligibleCommunityCount':len(groups),
        'eligibleMortals':sum(map(len,groups.values())),
        'gen1PlusMortals':sum(p['genome']['generation']>=1 for p in people),
        'meanAgeDays':statistics.mean((world['tick']-p['bornAt'])/2400 for p in people),
        'culture':culture,'communityCultureMeansUnweighted':between,
        'meanCulturalDistanceBetweenCommunityMeans':statistics.mean(distance) if distance else None,
        'maxCulturalDistanceBetweenCommunityMeans':max(distance) if distance else None,
        'meanAlleleSD':statistics.mean(statistics.pstdev(p['genome']['alleles'][i] for p in people) for i in range(14)),
        'traitVariation':trait})
out['cultureBackups']={'manifestPath':str(backup_manifest),'manifestSHA256':sha256(backup_manifest),
    'definition':'mortals role=neighbor alive in snapshot slot0; eligible groups >=3 mortals; population SD; mean absolute deviation from mean; unweighted community means; culturalDistance=mean(abs delta sharing/stewardship/openness); three cuts per version, no daily series',
    'rows':culture_rows}
aggregate={};primary=[r for r in metrics if r['seed']<=9506]
for arm in ('CDC','CDD'):
    rs=[r for r in primary if r['arm']==arm];aggregate[arm]={}
    for window in WINDOWS:
        fields=('diversityWindow','diversityComponent','occupationsComponent','betweenCommunities','activeLifetimeDiversity','g3','communityCount')
        row={k:{'meanAcross6Seeds':statistics.mean(r['windows'][window][k] for r in rs),
                'minAcross6Seeds':min(r['windows'][window][k] for r in rs),
                'maxAcross6Seeds':max(r['windows'][window][k] for r in rs)} for k in fields}
        actions={k:statistics.mean(r['windows'][window]['activeTimeFractionByAction'].get(k,0) for r in rs)
                 for k in ('approach','share','cooperate','hunt','farm','research','craft','explore','gather','forage')}
        row['actionActiveFractionsMeanAcrossSeeds']=actions
        row['cultureTouchedActionsFraction']=sum(actions[k] for k in ('share','cooperate','hunt','farm'))
        aggregate[arm][window]=row
    a=aggregate[arm]['early5_14'];b=aggregate[arm]['end51_60']
    aggregate[arm]['occupationContributionFractionOfTotalDrop']=(a['occupationsComponent']['meanAcross6Seeds']-b['occupationsComponent']['meanAcross6Seeds'])/2/(a['diversityWindow']['meanAcross6Seeds']-b['diversityWindow']['meanAcross6Seeds'])
ratios=[]
for seed in range(9501,9507):
    c=next(r for r in primary if r['seed']==seed and r['arm']=='CDC');d=next(r for r in primary if r['seed']==seed and r['arm']=='CDD')
    ratios.append({'seed':seed,'F60_CDC':c['day60BetweenCommunities'],'F60_CDD':d['day60BetweenCommunities'],
        'F60ratio':d['day60BetweenCommunities']/c['day60BetweenCommunities'],
        'meanF41_60_CDC':c['windows']['late41_60']['betweenCommunities'],
        'meanF41_60_CDD':d['windows']['late41_60']['betweenCommunities']})
out['aggregatesPrimary']=aggregate;out['pairedF']=ratios
adenda=[]
for seed in range(9501,9511):
    c=records[f'CDC-{seed}'][1];d=records[f'CDD-{seed}'][1]
    mk=ev.mann_kendall([d[i]['censoComunidades']['n'] for i in range(31,61)])
    ratio=d[60]['nacimientos']/c[60]['nacimientos']
    g3c=statistics.mean(ev.g3(c[i]) for i in range(41,61));g3d=statistics.mean(ev.g3(d[i]) for i in range(41,61))
    frac=statistics.mean(ev.r(d[i]) for i in range(11,61));m=statistics.mean(ev.m(d[i]) for i in range(41,61))
    adenda.append({'seed':seed,'g3c':g3c,'g3d':g3d,'Q1':g3d>g3c,
        'frag':mk[0]>0 and mk[1]<.05 and mk[2]>=.1,'fracR':frac,'Q3ref':frac>.2,
        'ratioB':ratio,'Q4':ratio>=.9,'Q4ref':ratio<.8,'M':m,'Q5':m<.6})
out['qAdendaIndependentRecalculation']={'rows':adenda,
    'counts':{k:sum(r[k] for r in adenda) for k in ('Q1','frag','Q3ref','Q4','Q4ref','Q5')},
    'source':'same primitive g3,r,m,mann_kendall from immutable copied evaluar.py; 10 seeds, scaled preregistration thresholds; no evaluator source modified'}
final=guard()
comparison=None
if previous is not None:
    keys=[k for k in out if k!='cutUTC'];mismatches=[k for k in keys if out[k]!=previous.get(k)]
    assert not mismatches,mismatches
    comparison={'previousArtifactSHA256':previous_artifact_sha,'comparedTopLevelKeys':keys,
                'mismatches':mismatches,
                'method':'exact JSON-representation equality; evaluator B tuple serialized as ordered array; timestamps/resource evidence excluded'}
out['recomputedUTC']=utc()
out['resourceGuards']={'python':{'launchNiceBeforeExplicitSet':launch_nice,'explicitSetNice':19,
                              'initial':initial,'final':final},'node':node['resourceGuard']}
out['previousResultComparison']=comparison
OUTPUT.write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'output':str(OUTPUT),'sha256':sha256(OUTPUT),'resourceGuards':out['resourceGuards'],
                  'previousResultComparison':comparison,'identities':len(identities),'diaries':1200,
                  'cultureCuts':len(culture_rows),'C8passes':sum(r['c8']['estado']=='cumple' for r in out['c8'])},ensure_ascii=False,indent=2))
