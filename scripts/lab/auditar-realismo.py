"""Read-only Object-8 audit. Only accepts private copied backups, never a live world.

Uses are recorded-benefit counts, not visits. Archived objects are stale physical
states: their calendar age is not active exposure. No material totals are mixed
across the floating body/structure and integer technology accounting systems.
"""
import argparse, collections, csv, ctypes, hashlib, json, math, os, sqlite3, statistics
from datetime import datetime
from pathlib import Path

PRIVATE = Path('/datos/tmp-atlas-lab/datos-lab/codex8-respaldos').resolve()
TICKS_DAY = 2400

def digest(body):
    return hashlib.sha256(body.encode()).hexdigest()

def dist(values):
    values = list(values)
    return {'n': len(values), 'min': min(values) if values else None,
            'median': statistics.median(values) if values else None,
            'max': max(values) if values else None, 'sum': sum(values)}

def objects(db, w):
    active = set(w['chunks'])
    structures = {}
    places = {}
    for p in w['places']:
        assert p['id'] not in places, 'duplicate resident place'
        live=f"{math.floor(p['x']/16)},{math.floor(p['y']/16)}" in active
        places[p['id']]={'id':p['id'],'x':p['x'],'y':p['y'],'gatherings':p.get('gatherings',0),'active':live}
    for s in w['structures']:
        assert s['id'] not in structures
        assert f"{math.floor(s['x']/16)},{math.floor(s['y']/16)}" in active, 'resident structure outside active chunks'
        structures[s['id']] = {**s, 'active':True,'observedTick':w['tick']}
    chunks = 0
    archived_place_ids=set()
    query = '''SELECT c.key,c.tick,c.body,c.digest FROM chunks c
               JOIN (SELECT key,MAX(tick) t FROM chunks WHERE tick<=? GROUP BY key) m
               ON c.key=m.key AND c.tick=m.t'''
    for key,tick,body,sha in db.execute(query,(w['tick'],)):
        if key in active:
            continue
        assert digest(body) == sha, 'chunk checksum mismatch'
        chunk = json.loads(body)
        assert chunk['key']==key
        chunks += 1
        for s in chunk.get('structures',[]):
            assert s['id'] not in structures, 'duplicate active/archive structure'
            assert f"{math.floor(s['x']/16)},{math.floor(s['y']/16)}"==key, 'archived structure in wrong chunk'
            structures[s['id']]={**s,'active':False,'observedTick':tick}
        for p in chunk.get('places',[]):
            assert p['id'] not in archived_place_ids, 'duplicate archived place'
            archived_place_ids.add(p['id'])
            assert f"{math.floor(p['x']/16)},{math.floor(p['y']/16)}"==key, 'archived place in wrong chunk'
            if p['id'] in places:
                old=places[p['id']]
                assert (old['x'],old['y'])==(p['x'],p['y']) and not old['active'], 'place identity collision'
            places[p['id']]={'id':p['id'],'x':p['x'],'y':p['y'],'gatherings':p.get('gatherings',0),'active':False}
    built=[s for s in structures.values() if s['id'].startswith('structure-') and s['id'][10:].isdigit()]
    assert len(built) == w['structureCounter'], 'cumulative constructed structure coverage incomplete'
    assert {int(s['id'][10:]) for s in built}==set(range(1,w['structureCounter']+1)), 'constructed identities not contiguous'
    return structures,places,chunks

def recipe_stats(db, w):
    counts=collections.Counter(); ages0=[]; sums=collections.Counter(); no_use=set()
    q='''SELECT d.id,d.tick,s.body,s.digest FROM technology_definitions d LEFT JOIN
         (SELECT recipeId,MAX(tick) t FROM technology_stats WHERE tick<=? GROUP BY recipeId) m
         ON d.id=m.recipeId LEFT JOIN technology_stats s ON s.recipeId=m.recipeId AND s.tick=m.t
         WHERE d.tick<=?'''
    for rid,tick,body,sha in db.execute(q,(w['tick'],w['tick'])):
        assert body is not None, 'missing cumulative recipe stats'
        assert digest(body)==sha
        s=json.loads(body); counts['recipes']+=1
        assert s['recipeId']==rid
        for k in ('uses','manufactured','utility'): sums[k]+=s[k]
        for k in ('uses','manufactured','utility'):
            if s[k]==0: counts[k+'Zero']+=1
        if s['uses']==0:
            no_use.add(rid)
            ages0.append((w['tick']-tick)/TICKS_DAY)
            if s['manufactured']>0: counts['manufacturedButUsesZero']+=1
            if w['tick']-tick>=20*TICKS_DAY: counts['usesZeroAge20']+=1
    totals=w['technology']['catalogue']['totals']
    for k in ('recipes','uses','manufactured'):
        assert (counts[k] if k=='recipes' else sums[k])==totals[k], ('catalogue mismatch',k)
    assert math.isclose(sums['utility'],totals['utility'],rel_tol=1e-10,abs_tol=1e-7)
    return {'counts':dict(counts),'sums':dict(sums),'unusedCalendarAgeDays':dist(ages0),'catalogueTotals':totals},no_use

def receipts(db,w,no_use):
    bykind=collections.Counter(); inputs=collections.Counter(); catalysts=set(); used=set()
    benefit=0; first=None; last=None; counter=0; water_consumed=0
    q='SELECT serial,tick,body,digest FROM technology_executions WHERE tick<=? ORDER BY serial'
    for serial,tick,body,sha in db.execute(q,(w['tick'],)):
        assert digest(body)==sha
        e=json.loads(body); kind=e['kind']; bykind[kind]+=1; counter+=1
        first=tick if first is None else first; last=tick
        if kind in ('use','water') and e.get('benefit',0)>0:
            used.add(e['recipeId']);benefit+=e['benefit']
        if kind in ('research','craft'):
            for item in e.get('inputs',[]):
                if item['resourceId'].startswith('recipe:'):
                    inputs[item['resourceId'][7:]]+=item['mass']
        for c in e.get('catalysts',[]):
            if c.get('recipeId'): catalysts.add(c['recipeId'])
        water_consumed+=e.get('water',{}).get('consumed',0) if isinstance(e.get('water'),dict) else 0
    row=db.execute("SELECT value FROM metadata WHERE key='technology-pruned-v1'").fetchone()
    pruned=json.loads(row[0]) if row else None
    return {'retainedCount':counter,'firstTick':first,'lastTick':last,'byKind':dict(bykind),
            'usefulRecipes':len(used),'benefit':benefit,'recipeInputsDistinct':len(inputs),
            'recipeInputMass':sum(inputs.values()),'catalystRecipesDistinct':len(catalysts),
            'inputRecipesWithZeroLifetimeUses':len(set(inputs)&no_use),'catalystRecipesWithZeroLifetimeUses':len(catalysts&no_use),
            'prunedCount':pruned['count'] if pruned else 0,'prunedByKind':pruned.get('byKind',{}) if pruned else {}}

def inspect_backup(row,detail=False):
    path=Path(row['database']).resolve()
    assert path.parent==PRIVATE and path.suffix=='.sqlite', 'only private copied backups accepted'
    db=sqlite3.connect('file:'+str(path)+'?mode=ro&immutable=1',uri=True)
    db.execute('PRAGMA query_only=ON')
    body,sha=db.execute('SELECT body,digest FROM snapshots WHERE slot=0').fetchone()
    assert digest(body)==sha
    snapshot=json.loads(body); w=snapshot.get('world',snapshot)
    structures,places,archivedChunks=objects(db,w)
    homes=collections.Counter((p['home']['x'],p['home']['y']) for p in w['people'] if p.get('home'))
    grouped={}
    built=[s for s in structures.values() if s['id'].startswith('structure-') and s['id'][10:].isdigit()]
    legacy=[s for s in structures.values() if s['id'].startswith('structure-legacy-')]
    for label,selection in [('all',list(structures.values())),('built',built),('legacy',legacy),('active',[s for s in built if s['active']]),('archived',[s for s in built if not s['active']])]:
        grouped[label]={'n':len(selection),'usesZero':sum(s['uses']==0 for s in selection),
            'usesZeroAge20':sum(s['uses']==0 and w['tick']-s['builtAt']>=20*TICKS_DAY for s in selection),
            'broken':sum(s['condition']<=.1 for s in selection),'conditionZero':sum(s['condition']==0 for s in selection),
            'condition':dist(s['condition'] for s in selection),'calendarAgeDays':dist((w['tick']-s['builtAt'])/TICKS_DAY for s in selection),
            'uses':dist(s['uses'] for s in selection),'water':sum(s['water'] for s in selection),'food':sum(s['food'] for s in selection),
            'stockOnBroken':{'water':sum(s['water'] for s in selection if s['condition']<=.1),'food':sum(s['food'] for s in selection if s['condition']<=.1)},
            'noLivingHomeReference':sum(homes[(s['x'],s['y'])]==0 for s in selection),
            'stockOnUsesZero':{'water':sum(s['water'] for s in selection if s['uses']==0),'food':sum(s['food'] for s in selection if s['uses']==0)}}
    material=collections.Counter();residue=collections.Counter();items=[];itemrows=[]
    for p in w['people']:
        material.update(p['materials']);residue.update(p['technology']['residue']);items.extend(p['technology']['items'])
        for i in p['technology']['items']:
            itemrows.append({'id':i['id'],'mass':i['mass'],'initialMass':i['initialMass'],'madeAt':i['madeAt'],'protected':p['role'] in ('S','I')})
    result={'version':row['version'],'backup':Path(row['database']).name,'snapshotSha':sha,'tick':w['tick'],'day':w['tick']/TICKS_DAY,
        'seed':w['seed'],'people':len(w['people']),'structureCounter':w['structureCounter'],'activeChunks':len(w['chunks']),
        'archivedInactiveChunks':archivedChunks,'inventionDynamics':w['inventionDynamics'],'structures':grouped,
        'places':{'n':len(places),'zeroGatherings':sum(p['gatherings']==0 for p in places.values()),'archived':sum(not p['active'] for p in places.values())},
        'livingHomes':{'peopleWithHome':sum(bool(p.get('home')) for p in w['people']),'distinctCoordinates':len(homes)},
        'stocks':{'bodyFoodInventory':sum(p['inventory'] for p in w['people']),'bodyMaterialUnits':dict(material),'technologyResidueIntegerMass':dict(residue),
            'technologyItems':len(items),'technologyItemIntegerMass':sum(i['mass'] for i in items),
            'itemCalendarAgeDays':dist((w['tick']-i['madeAt'])/TICKS_DAY for i in items),'itemsUnworn':sum(i['mass']==i['initialMass'] for i in items),
            'itemsUnwornAge20':sum(i['mass']==i['initialMass'] and w['tick']-i['madeAt']>=20*TICKS_DAY for i in items)},
        'technologyLedger':w['technology']['ledger'],'technologyCatalogue':w['technology']['catalogue']['totals'],'persistencia':w['params']['persistencia']}
    if detail:
        result['recipes'],no_use=recipe_stats(db,w);result['receipts']=receipts(db,w,no_use)
    sanitized=[]
    for s in structures.values():
        sanitized.append({k:s[k] for k in ('id','x','y','condition','water','food','uses','builtAt','active','observedTick')})
    result['structureRows']=sorted(sanitized,key=lambda s:s['id'])
    result['itemRows']=sorted(itemrows,key=lambda i:i['id'])
    db.close()
    return result

def intervals(a,b):
    aa={s['id']:s for s in a['structureRows']};bb={s['id']:s for s in b['structureRows']}
    rows=[];elapsed=(b['tick']-a['tick'])/TICKS_DAY
    for key in sorted(aa.keys()&bb.keys()):
        if not key[10:].isdigit():continue
        x,y=aa[key],bb[key];du=y['uses']-x['uses'];assert du>=0
        rows.append({'id':key,'dayFrom':a['day'],'dayTo':b['day'],'usesDelta':du,'usesPerCalendarDayInterval':du/elapsed,
            'conditionFrom':x['condition'],'conditionTo':y['condition'],'conditionDelta':y['condition']-x['condition'],
            'activeFrom':x['active'],'activeTo':y['active'],'observationTickFrom':x['observedTick'],'observationTickTo':y['observedTick'],
            'sameArchivedRecord':not x['active'] and not y['active'] and x['observedTick']==y['observedTick'],
            'stockUnchanged':x['water']==y['water'] and x['food']==y['food']})
    ai={i['id']:i for i in a['itemRows']};bi={i['id']:i for i in b['itemRows']};both=ai.keys()&bi.keys()
    return {'version':a['version'],'dayFrom':a['day'],'dayTo':b['day'],'matched':len(rows),
        'itemsMatched':len(both),'itemsSameMass':sum(ai[i]['mass']==bi[i]['mass'] for i in both),
        'itemsSameMassMortalAtBoth':sum(ai[i]['mass']==bi[i]['mass'] and not ai[i]['protected'] and not bi[i]['protected'] for i in both),
        'usesNoIncrease':sum(r['usesDelta']==0 for r in rows),'conditionDecreased':sum(r['conditionDelta']<0 for r in rows),
        'conditionIncreasedNet':sum(r['conditionDelta']>0 for r in rows),'conditionEqual':sum(r['conditionDelta']==0 for r in rows),
        'sameArchivedRecord':sum(r['sameArchivedRecord'] for r in rows),'rows':rows}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True);args=parser.parse_args()
    os.sched_setaffinity(0,range(6,32));os.setpriority(os.PRIO_PROCESS,0,19)
    ctypes.CDLL(None).prctl(15,b'codex8-audit',0,0,0)
    initial={'nice':os.getpriority(os.PRIO_PROCESS,0),'affinity':sorted(os.sched_getaffinity(0))}
    manifest=json.loads((PRIVATE/'manifest.json').read_text());results=[];spans=[]
    for v in ('v13','v12'):
        group=[r for r in manifest['backups'] if r['version']==v]
        for index,row in enumerate(group):
            result=inspect_backup(row,detail=index==len(group)-1);results.append(result)
            print(json.dumps({k:result[k] for k in ('version','day','people','structureCounter')}),flush=True)
        series=[r for r in results if r['version']==v]
        spans.extend(intervals(a,b) for a,b in zip(series,series[1:]))
    final={'nice':os.getpriority(os.PRIO_PROCESS,0),'affinity':sorted(os.sched_getaffinity(0))}
    dest=Path(args.output);dest.mkdir(exist_ok=True,parents=True)
    valid=initial==final and final['nice']==19
    resource_path=dest/'recursos.json' if valid else dest/f'recursos-FAIL-{os.getpid()}.json'
    resource_path.write_text(json.dumps({'initial':initial,'final':final,'valid':valid},indent=2)+'\n')
    assert valid, 'compute resource drift; prior results preserved'
    output={'cut':datetime.now().astimezone().isoformat(),'resources':{'initial':initial,'final':final},'backups':results,'intervals':spans,
        'limits':['uses counts recorded benefit, not occupation','interval rates are not daily use history','stock unchanged does not prove never consumed',
                  'archived condition is state at observedTick, calendar age is not exposure','receipt details have bounded retention; recipe stats are cumulative']}
    (dest/'publicos.json').write_text(json.dumps(output,indent=2)+'\n')
    for span in spans:
        name=f"{span['version']}-estructuras-{span['dayFrom']:.3f}-{span['dayTo']:.3f}.csv"
        with (dest/name).open('w') as f:
            writer=csv.DictWriter(f,fieldnames=span['rows'][0].keys() if span['rows'] else ['id'],lineterminator='\n');writer.writeheader();writer.writerows(span['rows'])

if __name__=='__main__':main()
