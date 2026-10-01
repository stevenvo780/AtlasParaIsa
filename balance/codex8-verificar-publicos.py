"""Independent read-only verification of Object-8 copied backups and summaries.

Synthetic fixtures run in memory before any real database is opened. The reader
does not import the audited instrument for real calculations and never reads a
live world, original backup path, credentials, sessions or personal narrative.
"""
import argparse
import collections
import copy
import ctypes
import gzip
import hashlib
import importlib.util
import json
import math
import os
import re
import sqlite3
import statistics
from datetime import datetime
from pathlib import Path

PRIVATE = Path('/datos/tmp-atlas-lab/datos-lab/codex8-respaldos').resolve()
BALANCE = Path('/datos/tmp-atlas-lab/balance')
AUDITED = Path('/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/auditoria-realismo/scripts/lab/auditar-realismo.py')
DAY = 2400


def require(condition, message):
    if not condition:
        raise ValueError(message)


def pairs_unique(pairs):
    out = {}
    for key, value in pairs:
        require(key not in out, 'duplicate JSON key')
        out[key] = value
    return out


def decode(body, digest):
    require(hashlib.sha256(body.encode()).hexdigest() == digest, 'body digest mismatch')
    return json.loads(body, object_pairs_hook=pairs_unique)


def file_hash(path, compressed=False):
    h = hashlib.sha256()
    opener = gzip.open if compressed else open
    with opener(path, 'rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def accepted_path(value, suffix):
    p = Path(value).resolve()
    require(p.parent == PRIVATE and p.suffix == suffix, 'outside private backup copies')
    return p


def coordinate_key(obj):
    return f"{math.floor(obj['x'] / 16)},{math.floor(obj['y'] / 16)}"


def constructed(identity):
    return re.fullmatch(r'structure-[0-9]+', identity) is not None


def read_objects(db, world):
    """Correlated latest-row query; active state overrides archived versions."""
    active = set(world['chunks'])
    structures, places = {}, {}
    for obj in world['structures']:
        require(obj['id'] not in structures, 'duplicate resident structure')
        require(coordinate_key(obj) in active, 'resident structure outside active region')
        structures[obj['id']] = dict(obj, active=True, observedTick=world['tick'])
    for obj in world['places']:
        require(obj['id'] not in places, 'duplicate resident place')
        places[obj['id']] = dict(obj, active=coordinate_key(obj) in active)
    seen_regions, seen_archive_places = set(), set()
    query = '''SELECT c.key,c.tick,c.body,c.digest FROM chunks AS c
        WHERE c.tick<=? AND NOT EXISTS
        (SELECT 1 FROM chunks AS later WHERE later.key=c.key AND later.tick<=? AND later.tick>c.tick)
        ORDER BY c.key'''
    for key, tick, body, digest in db.execute(query, (world['tick'], world['tick'])):
        if key in active:
            continue
        require(key not in seen_regions, 'duplicate latest archived region')
        seen_regions.add(key)
        chunk = decode(body, digest)
        require(chunk['key'] == key, 'archive key mismatch')
        for obj in chunk.get('structures', []):
            require(obj['id'] not in structures, 'duplicate active/archive structure')
            require(coordinate_key(obj) == key, 'archived structure wrong coordinates')
            structures[obj['id']] = dict(obj, active=False, observedTick=tick)
        for obj in chunk.get('places', []):
            require(obj['id'] not in seen_archive_places, 'duplicate place inside archive')
            seen_archive_places.add(obj['id'])
            require(coordinate_key(obj) == key, 'archived place wrong coordinates')
            previous = places.get(obj['id'])
            if previous is not None:
                require(not previous['active'] and (previous['x'], previous['y']) == (obj['x'], obj['y']),
                        'place identity collision')
            places[obj['id']] = dict(obj, active=False)
    built = [obj for obj in structures.values() if constructed(obj['id'])]
    require(len(built) == world['structureCounter'], 'constructed cardinality mismatch')
    require({int(obj['id'][10:]) for obj in built} == set(range(1, world['structureCounter'] + 1)),
            'constructed identities incomplete')
    return structures, places, len(seen_regions)


def distribution(values):
    ordered = sorted(values)
    return {'n': len(ordered), 'min': ordered[0] if ordered else None,
            'median': statistics.median(ordered) if ordered else None,
            'max': ordered[-1] if ordered else None, 'sum': math.fsum(ordered)}


def structure_summary(structures, world):
    all_rows = list(structures.values())
    made = [s for s in all_rows if constructed(s['id'])]
    homes = {(p['home']['x'], p['home']['y']) for p in world['people'] if p.get('home')}
    groups = {'all': all_rows, 'built': made,
              'legacy': [s for s in all_rows if s['id'].startswith('structure-legacy-')],
              'active': [s for s in made if s['active']], 'archived': [s for s in made if not s['active']]}
    output = {}
    for name, rows in groups.items():
        unused = [s for s in rows if s['uses'] == 0]
        broken = [s for s in rows if s['condition'] <= 0.1]
        ages = [(world['tick'] - s['builtAt']) / DAY for s in rows]
        output[name] = {'n': len(rows), 'usesZero': len(unused),
            'usesZeroAge20': sum(world['tick'] - s['builtAt'] >= 20 * DAY for s in unused),
            'broken': len(broken), 'conditionZero': sum(s['condition'] == 0 for s in rows),
            'condition': distribution(s['condition'] for s in rows), 'calendarAgeDays': distribution(ages),
            'uses': distribution(s['uses'] for s in rows),
            'water': math.fsum(s['water'] for s in rows), 'food': math.fsum(s['food'] for s in rows),
            'stockOnBroken': {k: math.fsum(s[k] for s in broken) for k in ('water', 'food')},
            'stockOnUsesZero': {k: math.fsum(s[k] for s in unused) for k in ('water', 'food')},
            'noLivingHomeReference': sum((s['x'], s['y']) not in homes for s in rows)}
    return output


def recipe_summary(db, world):
    """Independent per-definition latest-before-cut lookup, avoiding the audit JOIN."""
    counts = collections.Counter()
    stats_rows, unused_ages, unused_ids = [], [], set()
    for rid, birth in db.execute('SELECT id,tick FROM technology_definitions WHERE tick<=? ORDER BY id', (world['tick'],)):
        row = db.execute('SELECT tick,body,digest FROM technology_stats WHERE recipeId=? AND tick<=? ORDER BY tick DESC LIMIT 1',
                         (rid, world['tick'])).fetchone()
        require(row is not None, 'definition without cumulative statistics at cut')
        stat_tick, body, digest = row
        stat = decode(body, digest)
        require(stat['recipeId'] == rid, 'statistics identity mismatch')
        if 'tick' in stat:
            require(stat['tick'] == stat_tick, 'statistics tick mismatch')
        stats_rows.append(stat)
        counts['recipes'] += 1
        for key in ('uses', 'manufactured', 'utility'):
            if stat[key] == 0:
                counts[key + 'Zero'] += 1
        if stat['uses'] == 0:
            unused_ids.add(rid)
            unused_ages.append((world['tick'] - birth) / DAY)
            counts['manufacturedButUsesZero'] += stat['manufactured'] > 0
            counts['usesZeroAge20'] += world['tick'] - birth >= 20 * DAY
    totals = {key: math.fsum(s[key] for s in stats_rows) for key in ('uses', 'manufactured', 'utility')}
    expected = world['technology']['catalogue']['totals']
    require(counts['recipes'] == expected['recipes'], 'definition total mismatch')
    for key in ('uses', 'manufactured'):
        require(totals[key] == expected[key], f'cumulative {key} mismatch')
    require(math.isclose(totals['utility'], expected['utility'], rel_tol=1e-10, abs_tol=1e-7), 'cumulative utility mismatch')
    return {'counts': {k: v for k, v in counts.items() if v}, 'sums': totals,
            'unusedCalendarAgeDays': distribution(unused_ages), 'catalogueTotals': expected}, unused_ids


def retained_summary(db, world, unused):
    kinds, inputs = collections.Counter(), collections.Counter()
    useful, catalytic, benefits = set(), set(), []
    ticks, count = [], 0
    for serial, tick, body, digest in db.execute('SELECT serial,tick,body,digest FROM technology_executions WHERE tick<=? ORDER BY serial', (world['tick'],)):
        e = decode(body, digest)
        count += 1
        ticks.append(tick)
        kinds[e['kind']] += 1
        if e['kind'] in ('use', 'water') and e.get('benefit', 0) > 0:
            useful.add(e['recipeId'])
            benefits.append(e['benefit'])
        if e['kind'] in ('research', 'craft'):
            for item in e.get('inputs', []):
                if item['resourceId'].startswith('recipe:'):
                    inputs[item['resourceId'].removeprefix('recipe:')] += item['mass']
        catalytic.update(c['recipeId'] for c in e.get('catalysts', []) if c.get('recipeId'))
    boundary = db.execute("SELECT value FROM metadata WHERE key='technology-pruned-v1'").fetchone()
    pruned = json.loads(boundary[0]) if boundary else {}
    return {'retainedCount': count, 'firstTick': ticks[0] if ticks else None, 'lastTick': ticks[-1] if ticks else None,
            'byKind': dict(kinds), 'usefulRecipes': len(useful), 'benefit': math.fsum(benefits),
            'recipeInputsDistinct': len(inputs), 'recipeInputMass': sum(inputs.values()), 'catalystRecipesDistinct': len(catalytic),
            'inputRecipesWithZeroLifetimeUses': len(set(inputs) & unused),
            'catalystRecipesWithZeroLifetimeUses': len(catalytic & unused),
            'prunedCount': pruned.get('count', 0), 'prunedByKind': pruned.get('byKind', {})}


def stock_summary(world):
    people = world['people']
    item_rows = [dict(id=i['id'], mass=i['mass'], initialMass=i['initialMass'], madeAt=i['madeAt'],
                      protected=p['role'] in {'S', 'I'}) for p in people for i in p['technology']['items']]
    require(len({i['id'] for i in item_rows}) == len(item_rows), 'duplicate live item identity')
    material_keys = set().union(*(p['materials'] for p in people)) if people else set()
    residue_keys = set().union(*(p['technology']['residue'] for p in people)) if people else set()
    return {'bodyFoodInventory': math.fsum(p['inventory'] for p in people),
            'bodyMaterialUnits': {k: math.fsum(p['materials'].get(k, 0) for p in people) for k in material_keys},
            'technologyResidueIntegerMass': {k: sum(p['technology']['residue'].get(k, 0) for p in people) for k in residue_keys},
            'technologyItems': len(item_rows), 'technologyItemIntegerMass': sum(i['mass'] for i in item_rows),
            'itemCalendarAgeDays': distribution((world['tick'] - i['madeAt']) / DAY for i in item_rows),
            'itemsUnworn': sum(i['mass'] == i['initialMass'] for i in item_rows),
            'itemsUnwornAge20': sum(i['mass'] == i['initialMass'] and world['tick'] - i['madeAt'] >= 20 * DAY for i in item_rows)}, sorted(item_rows, key=lambda i: i['id'])


def span_summary(a, b):
    elapsed = (b['tick'] - a['tick']) / DAY
    require(elapsed > 0, 'non-positive backup interval')
    old = {s['id']: s for s in a['structureRows'] if constructed(s['id'])}
    new = {s['id']: s for s in b['structureRows'] if constructed(s['id'])}
    rows = []
    for identity in sorted(set(old) & set(new)):
        left, right = old[identity], new[identity]
        delta = right['uses'] - left['uses']
        require(delta >= 0, 'uses regressed')
        rows.append({'id': identity, 'dayFrom': a['day'], 'dayTo': b['day'], 'usesDelta': delta,
            'usesPerCalendarDayInterval': delta / elapsed,
            'conditionFrom': left['condition'], 'conditionTo': right['condition'],
            'conditionDelta': right['condition'] - left['condition'],
            'activeFrom': left['active'], 'activeTo': right['active'],
            'observationTickFrom': left['observedTick'], 'observationTickTo': right['observedTick'],
            'sameArchivedRecord': not left['active'] and not right['active'] and left['observedTick'] == right['observedTick'],
            'stockUnchanged': left['water'] == right['water'] and left['food'] == right['food']})
    old_items = {i['id']: i for i in a['itemRows']}
    new_items = {i['id']: i for i in b['itemRows']}
    both = set(old_items) & set(new_items)
    same = {i for i in both if old_items[i]['mass'] == new_items[i]['mass']}
    return {'version': a['version'], 'dayFrom': a['day'], 'dayTo': b['day'], 'matched': len(rows),
            'itemsMatched': len(both), 'itemsSameMass': len(same),
            'itemsSameMassMortalAtBoth': sum(not old_items[i]['protected'] and not new_items[i]['protected'] for i in same),
            'usesNoIncrease': sum(r['usesDelta'] == 0 for r in rows),
            'conditionDecreased': sum(r['conditionDelta'] < 0 for r in rows),
            'conditionIncreasedNet': sum(r['conditionDelta'] > 0 for r in rows),
            'conditionEqual': sum(r['conditionDelta'] == 0 for r in rows),
            'sameArchivedRecord': sum(r['sameArchivedRecord'] for r in rows), 'rows': rows}


def compare(actual, expected, prefix, mismatches, checks):
    if isinstance(actual, dict) and isinstance(expected, dict):
        for key in sorted(set(actual) | set(expected)):
            require(key in actual and key in expected, f'{prefix}: key mismatch {key}')
            compare(actual[key], expected[key], f'{prefix}.{key}', mismatches, checks)
    elif isinstance(actual, list) and isinstance(expected, list):
        require(len(actual) == len(expected), f'{prefix}: length mismatch')
        for index, (x, y) in enumerate(zip(actual, expected)):
            compare(x, y, f'{prefix}[{index}]', mismatches, checks)
    else:
        checks[0] += 1
        if isinstance(expected, int) and not isinstance(expected, bool):
            same = actual == expected
        elif isinstance(actual, (int, float)) and not isinstance(actual, bool) and isinstance(expected, float):
            same = math.isclose(actual, expected, rel_tol=1e-10, abs_tol=1e-7)
        else:
            same = actual == expected
        if not same:
            mismatches.append({'field': prefix, 'independent': actual, 'audited': expected})


def fixture():
    db = sqlite3.connect(':memory:')
    db.executescript('CREATE TABLE chunks(key TEXT,tick INTEGER,body TEXT,digest TEXT);'
        'CREATE TABLE technology_definitions(id TEXT,tick INTEGER);'
        'CREATE TABLE technology_stats(recipeId TEXT,tick INTEGER,body TEXT,digest TEXT);'
        'CREATE TABLE technology_executions(serial INTEGER,tick INTEGER,body TEXT,digest TEXT);'
        'CREATE TABLE metadata(key TEXT,value TEXT);')
    world = {'tick': 100, 'chunks': {'0,0': {}}, 'structures': [], 'places': [], 'people': [], 'structureCounter': 0}
    return db, world


def insert(db, table, key, tick, body):
    text = json.dumps(body, separators=(',', ':'))
    db.execute(f'INSERT INTO {table} VALUES(?,?,?,?)', (key, tick, text, hashlib.sha256(text.encode()).hexdigest()))


def structure(identity='structure-1', x=0, uses=0):
    return {'id': identity, 'x': x, 'y': 0, 'uses': uses, 'builtAt': 0,
            'condition': 0.08, 'water': 0.3, 'food': 0.2}


def self_tests():
    results = []
    spec = importlib.util.spec_from_file_location('audited_object8', AUDITED)
    audited = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audited)

    def case(name, setup, want_error=False):
        db, world = fixture()
        setup(db, world)
        try:
            read_objects(db, world)
            outcome = not want_error
        except ValueError:
            outcome = want_error
        require(outcome, f'independent synthetic failed: {name}')
        try:
            audited.objects(db, world)
            audit_outcome = not want_error
        except (ValueError, AssertionError):
            audit_outcome = want_error
        results.append({'case': name, 'independent': 'PASS', 'audited': 'PASS' if audit_outcome else 'GAP'})
        db.close()

    def active(db, w):
        w['structures'] = [structure(uses=7)]; w['structureCounter'] = 1
        insert(db, 'chunks', '0,0', 80, {'key': '0,0', 'structures': [structure(uses=1)]})
        require(read_objects(db, w)[0]['structure-1']['uses'] == 7, 'active precedence')
    case('active overrides stale archived body', active)

    def horizon(db, w):
        w['structureCounter'] = 1
        insert(db, 'chunks', '1,0', 40, {'key': '1,0', 'structures': [structure(x=16, uses=1)]})
        insert(db, 'chunks', '1,0', 80, {'key': '1,0', 'structures': [structure(x=16, uses=3)]})
        insert(db, 'chunks', '1,0', 120, {'key': '1,0', 'structures': [structure(x=16, uses=9)]})
        got = read_objects(db, w)[0]['structure-1']
        require(got['uses'] == 3 and got['observedTick'] == 80, 'latest as-of cut')
    case('latest per key at or before horizon', horizon)

    def legacy(db, w):
        w['structures'] = [structure('structure-legacy-anchor')]
    case('legacy excluded from constructed counter', legacy)

    def resident_duplicate(db, w):
        w['structures'] = [structure(), structure()]; w['structureCounter'] = 2
    case('resident duplicate rejected', resident_duplicate, True)

    def archive_duplicate(db, w):
        w['structureCounter'] = 1
        insert(db, 'chunks', '1,0', 80, {'key': '1,0', 'structures': [structure(x=16), structure(x=16)]})
    case('archived structure duplicate rejected', archive_duplicate, True)

    def duplicate_place(db, w):
        p = {'id': 'place-x', 'x': 0, 'y': 0}
        w['places'] = [p, p]
    case('resident place duplicate rejected', duplicate_place, True)

    def archive_places(db, w):
        p = {'id': 'place-x', 'x': 16, 'y': 0}
        insert(db, 'chunks', '1,0', 80, {'key': '1,0', 'places': [p, p]})
    case('duplicate inside archived places rejected', archive_places, True)

    def dormant_overlay(db, w):
        w['places'] = [{'id': 'place-x', 'x': 16, 'y': 0, 'gatherings': 1}]
        insert(db, 'chunks', '1,0', 80, {'key': '1,0', 'places': [{'id': 'place-x', 'x': 16, 'y': 0, 'gatherings': 4}]})
        require(read_objects(db, w)[1]['place-x']['gatherings'] == 4, 'dormant anchor overlay')
    case('one dormant resident anchor may overlay archive', dormant_overlay)

    def negative_coordinates(db, w):
        w['structureCounter'] = 1
        insert(db, 'chunks', '-1,0', 80, {'key': '-1,0', 'structures': [structure(x=-1)]})
    case('negative coordinate uses floor division', negative_coordinates)

    def missing_serial(db, w):
        w['structures'] = [structure('structure-2')]; w['structureCounter'] = 1
    case('constructed serial completeness', missing_serial, True)

    def bad_hash(db, w):
        insert(db, 'chunks', '1,0', 80, {'key': '1,0'})
        db.execute("UPDATE chunks SET digest='bad'")
    case('bad archive digest rejected', bad_hash, True)

    db, w = fixture()
    w['technology'] = {'catalogue': {'totals': {'recipes': 1, 'uses': 2, 'manufactured': 3, 'utility': 0.4}}}
    db.executemany('INSERT INTO technology_definitions VALUES(?,?)', [('recipe-1', 20), ('recipe-future', 120)])
    insert(db, 'technology_stats', 'recipe-1', 80, {'recipeId': 'recipe-1', 'tick': 80, 'uses': 2, 'manufactured': 3, 'utility': 0.4})
    insert(db, 'technology_stats', 'recipe-1', 120, {'recipeId': 'recipe-1', 'tick': 120, 'uses': 7, 'manufactured': 8, 'utility': 2})
    require(recipe_summary(db, w)[0]['sums']['uses'] == 2, 'recipe cut')
    results.append({'case': 'recipe definitions and statistics bounded by horizon', 'independent': 'PASS'})
    db.execute('DELETE FROM technology_stats')
    try:
        recipe_summary(db, w)
        raise RuntimeError('missing cumulative stats accepted')
    except ValueError:
        pass
    results.append({'case': 'missing cumulative recipe stats rejected', 'independent': 'PASS'})
    db.close()

    a = {'version': 'synthetic', 'tick': 0, 'day': 0, 'structureRows': [dict(structure(uses=1), active=True, observedTick=0)], 'itemRows': []}
    b = copy.deepcopy(a); b.update(tick=4800, day=2)
    b['structureRows'][0].update(uses=5, observedTick=4800)
    span = span_summary(a, b)['rows'][0]
    require(span['usesDelta'] == 4 and span['usesPerCalendarDayInterval'] == 2, 'interval average')
    require('dailyUses' not in span and 'neverConsumed' not in span and span['stockUnchanged'], 'epistemic fields')
    results += [{'case': 'delta four over two days is interval average, not daily history', 'independent': 'PASS'},
                {'case': 'equal endpoints permit unobserved consume-and-refill', 'independent': 'PASS'}]
    item = {'id': 'product-1', 'mass': 4, 'initialMass': 4, 'madeAt': 0}
    roles = ['S', 'I', 'neighbor']
    w = {'tick': 100, 'people': [{'role': role, 'inventory': 0, 'materials': {},
         'technology': {'residue': {}, 'items': [dict(item, id=f'product-{n}')]}} for n, role in enumerate(roles)]}
    require([i['protected'] for i in stock_summary(w)[1]] == [True, True, False], 'protected roles')
    results.append({'case': 'S and I protected, neighbor mortal', 'independent': 'PASS'})
    try:
        json.loads('{"a":1,"a":2}', object_pairs_hook=pairs_unique)
        raise RuntimeError('JSON duplicate key accepted')
    except ValueError:
        pass
    results.append({'case': 'duplicate JSON key rejected', 'independent': 'PASS'})
    try:
        accepted_path('/datos/workspaces/personal/AtlasParaIsa/data/world.sqlite', '.sqlite')
        raise RuntimeError('live path accepted')
    except ValueError:
        pass
    results.append({'case': 'live path refused before opening', 'independent': 'PASS'})
    wrong, checked = [], [0]
    compare(1000000000001, 1000000000000, 'largeInteger', wrong, checked)
    require(len(wrong) == 1, 'integer comparison used floating tolerance')
    results.append({'case': 'integer comparison remains exact at large magnitude', 'independent': 'PASS'})
    return results


def verify_real(manifest_path, results_path):
    manifest = json.loads(manifest_path.read_text(), object_pairs_hook=pairs_unique)
    expected = json.loads(results_path.read_text(), object_pairs_hook=pairs_unique)
    require(len(manifest['backups']) == 6 and len(expected['backups']) == 6, 'expected six copied snapshots')
    indexed = {(r['version'], r['backup']): r for r in expected['backups']}
    require(len(indexed) == 6, 'duplicate result identity')
    hashes, summaries, mismatches, checked = [], [], [], [0]
    by_version = collections.defaultdict(list)
    for row in manifest['backups']:
        p = accepted_path(row['database'], '.sqlite')
        gz = accepted_path(row['copy'], '.gz')
        require(p.stat().st_size == row['sqlite_bytes'] and gz.stat().st_size == row['gzip_bytes'], 'copy size mismatch')
        gz_hash = file_hash(gz)
        require(gz_hash == row['sha256_gz'], 'copied gzip differs from manifest')
        before = file_hash(p)
        require(file_hash(gz, compressed=True) == before, 'SQLite copy differs from its gzip')
        with sqlite3.connect(p.as_uri() + '?mode=ro&immutable=1', uri=True) as db:
            db.execute('PRAGMA query_only=ON')
            body, digest = db.execute('SELECT body,digest FROM snapshots WHERE slot=0').fetchone()
            snap = decode(body, digest); w = snap.get('world', snap)
            structures, places, archive_n = read_objects(db, w)
            stocks, item_rows = stock_summary(w)
            structure_rows = sorted([{k: s[k] for k in ('id', 'x', 'y', 'condition', 'water', 'food', 'uses', 'builtAt', 'active', 'observedTick')}
                                    for s in structures.values()], key=lambda s: s['id'])
            key = (row['version'], p.name)
            require(key in indexed, 'copied backup missing from results')
            reference = indexed[key]
            home_coords = {(person['home']['x'], person['home']['y']) for person in w['people'] if person.get('home')}
            recalculated = {'version': row['version'], 'backup': p.name, 'snapshotSha': digest, 'tick': w['tick'],
                'day': w['tick'] / DAY, 'seed': w['seed'], 'people': len(w['people']), 'structureCounter': w['structureCounter'],
                'activeChunks': len(w['chunks']), 'archivedInactiveChunks': archive_n, 'inventionDynamics': w['inventionDynamics'],
                'structures': structure_summary(structures, w),
                'places': {'n': len(places), 'zeroGatherings': sum(p.get('gatherings', 0) == 0 for p in places.values()),
                           'archived': sum(not p['active'] for p in places.values())},
                'livingHomes': {'peopleWithHome': sum(bool(p.get('home')) for p in w['people']), 'distinctCoordinates': len(home_coords)},
                'stocks': stocks, 'technologyLedger': w['technology']['ledger'],
                'technologyCatalogue': w['technology']['catalogue']['totals'], 'persistencia': w['params']['persistencia'],
                'structureRows': structure_rows, 'itemRows': item_rows}
            if 'recipes' in reference:
                recalculated['recipes'], unused = recipe_summary(db, w)
                recalculated['receipts'] = retained_summary(db, w, unused)
                # Counter missing-zero keys are semantically equal; do not hide missing nonzero counts.
                for k in set(reference['recipes']['counts']) | set(recalculated['recipes']['counts']):
                    recalculated['recipes']['counts'].setdefault(k, 0)
                    reference['recipes']['counts'].setdefault(k, 0)
            compare(recalculated, reference, f'{row["version"]}/{p.name}', mismatches, checked)
            by_version[row['version']].append(recalculated)
            summaries.append({'version': row['version'], 'backup': p.name, 'tick': w['tick'],
                              'constructed': len([s for s in structures.values() if constructed(s['id'])]),
                              'places': len(places), 'recipesChecked': 'recipes' in reference})
        after = file_hash(p)
        require(before == after, 'read altered SQLite copy')
        hashes.append({'backup': p.name, 'sqliteShaBefore': before, 'sqliteShaAfter': after,
                       'gzipSha': gz_hash, 'gzipMatchesManifest': True, 'decompressedMatchesSqlite': True})
        print(json.dumps({'verified': p.name, 'tick': w['tick'], 'mismatchesSoFar': len(mismatches)}), flush=True)
    intervals = []
    for version in ('v13', 'v12'):
        series = sorted(by_version[version], key=lambda r: r['tick'])
        require(len(series) == 3 and sum('recipes' in r for r in series) == 1 and 'recipes' in series[-1], 'three backups and latest detail per version')
        intervals.extend(span_summary(a, b) for a, b in zip(series, series[1:]))
    compare(intervals, expected['intervals'], 'intervals', mismatches, checked)
    require(expected['resources']['initial'] == expected['resources']['final'], 'audited resource drift')
    require(expected['resources']['final']['nice'] == 19 and expected['resources']['final']['affinity'] == list(range(6, 32)), 'audited resources outside policy')
    return {'status': 'PASS' if not mismatches else 'FAIL', 'snapshots': summaries,
            'detailRecipesSnapshots': sum(s['recipesChecked'] for s in summaries), 'intervals': len(intervals),
            'scalarComparisons': checked[0], 'mismatches': mismatches, 'copyHashes': hashes,
            'resultsSha256': file_hash(results_path), 'manifestSha256': file_hash(manifest_path)}


def resources():
    return {'nice': os.getpriority(os.PRIO_PROCESS, 0), 'affinity': sorted(os.sched_getaffinity(0))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--real', action='store_true')
    parser.add_argument('--manifest', type=Path, default=PRIVATE / 'manifest.json')
    parser.add_argument('--results', type=Path, default=BALANCE / 'codex8-datos-final/publicos.json')
    args = parser.parse_args()
    ctypes.CDLL(None).prctl(15, b'codex8-verify', 0, 0, 0)
    os.sched_setaffinity(0, range(6, 32))
    os.setpriority(os.PRIO_PROCESS, 0, 19)
    initial = resources()
    require(initial['nice'] == 19 and initial['affinity'] == list(range(6, 32)), 'start outside compute policy')
    source_before = file_hash(AUDITED)
    report = {'cut': datetime.now().astimezone().isoformat(), 'instrumentSha256': source_before,
              'synthetic': self_tests(), 'real': {'status': 'NOT_RUN'}}
    print(json.dumps({'syntheticsPassed': len(report['synthetic']),
                      'auditedSyntheticGaps': [r['case'] for r in report['synthetic'] if r.get('audited') == 'GAP']}), flush=True)
    if args.real:
        report['real'] = verify_real(args.manifest, args.results)
    report['resources'] = {'initial': initial, 'final': resources()}
    report['instrumentStableDuringReview'] = source_before == file_hash(AUDITED)
    report['limits'] = ['Copies only; no source gzip or live world opened.',
        'Integer quantities exact; floating comparisons rel=1e-10 abs=1e-7; independent math.fsum.',
        'Active/archive observations have different clocks; sums are mixed-time states.',
        'Three snapshots per version cannot reconstruct daily use or assert never consumed.',
        'Real verifier rechecks summaries and row identities, not complete Store/law validation or replay.',
        'Receipt count and used-as-input fields are restricted to retained history.']
    require(report['resources']['initial'] == report['resources']['final'], 'verifier resource drift')
    dest = BALANCE / 'codex8-revision-instrumento.json'
    dest.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    md = ['# Revisión independiente del instrumento de realismo', '',
          f'Corte: {report["cut"]}. Instrumento SHA256 `{source_before}`.', '',
          f'Sintéticos del lector independiente: **{len(report["synthetic"])} PASS**.',
          f'Recálculo real: **{report["real"]["status"]}**.', '',
          '| Caso sintético | Lector independiente | Instrumento auditado |', '|---|---|---|']
    md.extend(f'| {r["case"]} | {r["independent"]} | {r.get("audited", "no invocado")} |' for r in report['synthetic'])
    if args.real:
        v = report['real']
        md += ['', f'**{len(v["snapshots"])}** snapshots, **{v["detailRecipesSnapshots"]}** catálogos detallados, '
                    f'**{v["intervals"]}** intervalos y **{v["scalarComparisons"]}** comparaciones; '
                    f'**{len(v["mismatches"])}** diferencias. Los seis gzip coinciden con el manifest y las seis bases con su gzip; '
                    'SHA SQLite antes/después idénticos.', '',
               'Las comparaciones cubren estructuras/all/built/legacy/active/archive, condición/edad/usos/stocks, '
               'lugares, hogares, reservas corporales/materiales, productos y sus roles S/I, tecnología, '
               'estadísticas acumuladas al horizonte, recibos retenidos e intervalos.']
    md += ['', 'Límites:', ''] + [f'- {s}' for s in report['limits']]
    md += ['', f'Recursos: nice={initial["nice"]}, CPUs 6–31, inicial/final iguales.',
           f'Instrumento estable durante revisión: {report["instrumentStableDuringReview"]}.',
           'No se editaron el instrumento auditado, las reglas, specs, evaluadores, preregistros ni servicios.']
    (BALANCE / 'codex8-revision-instrumento.md').write_text('\n'.join(md) + '\n')
    print(json.dumps({'report': str(dest), 'real': report['real']['status']}), flush=True)
    if report['real']['status'] == 'FAIL':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
