#!/usr/bin/env python3
"""Muestra acotada de SQLite TEMPORAL de laboratorio; solo lectura, JSON agregado a stdout.

Uso: python3 scripts/analysis/snapshot-economia.py --sqlite /datos/tmp-atlas-lab/atlas-lab-XXXXXX/world.sqlite --seed N
No accede a servidores ni busca bases automáticamente. El archivo temporal puede desaparecer.
"""
import argparse
import collections
import hashlib
import json
import math
import re
import sqlite3
import time
from pathlib import Path

TICKS_PER_DAY = 2400
CAPABILITIES = ('cutting', 'storage', 'insulation', 'cultivation', 'binding', 'abrasion')
RADII = (7, 16)
PAGE_TILES = 4096
MAX_PAGE_BYTES = 4 * 1024 * 1024
MAX_BODY_BYTES = 50 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 96 * 1024 * 1024
MAX_TOTAL_READ_BYTES = 192 * 1024 * 1024
MAX_SLOTS = 3
MAX_REFERENCE_BYTES = 1024 * 1024
SHA256 = re.compile(r'^[0-9a-f]{64}$')


def strict_json(body):
    def no_duplicate_keys(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ValueError(f'Clave JSON duplicada: {key}')
            value[key] = item
        return value
    return json.loads(body, object_pairs_hook=no_duplicate_keys)


def positive_int(value):
    return type(value) is int and value > 0


def validate_tile(row):
    if not isinstance(row, list) or len(row) != 20 or any(type(row[i]) is not int for i in (0, 1)) \
            or not isinstance(row[2], str) or not row[2] \
            or any(type(row[i]) not in (int, float) or not math.isfinite(row[i]) for i in (3, 4, 5)) \
            or any(row[i] is not None and (type(row[i]) not in (int, float) or not math.isfinite(row[i]) or row[i] < 0)
                   for i in (8, 9, 18)):
        raise ValueError('Tupla de tesela incompatible')


def load_stored_snapshot(con, body, digest, bytes_read):
    body_bytes = len(body.encode('utf-8'))
    if body_bytes > MAX_BODY_BYTES or hashlib.sha256(body.encode('utf-8')).hexdigest() != digest:
        raise ValueError('Cuerpo de snapshot excede límite o digest SHA-256 no concuerda')
    value = strict_json(body)
    if not isinstance(value, dict):
        raise ValueError('Snapshot no es un objeto')
    if 'snapshotEncoding' not in value:
        if value.get('tileEncoding') != 'tiles-tuple-v1' or not isinstance(value.get('tiles'), list):
            raise ValueError('Snapshot inline incompatible')
        if body_bytes + bytes_read > MAX_TOTAL_READ_BYTES:
            raise ValueError('Límite total de lectura excedido')
        return value, body_bytes, 'inline', 0
    if set(value) != {'snapshotEncoding', 'world', 'tiles'} or value['snapshotEncoding'] != 'snapshot-parts-v1':
        raise ValueError('Manifiesto snapshot-parts-v1 incompatible')
    world, tiles = value['world'], value['tiles']
    if not isinstance(world, dict) or world.get('tiles', 'absente') is not None or world.get('tileEncoding') != 'tiles-tuple-v1' \
            or 'snapshotEncoding' in world or not isinstance(tiles, dict) or set(tiles) != {'count', 'pages'}:
        raise ValueError('Metadatos paginados incompatibles')
    total, pages = tiles['count'], tiles['pages']
    if not positive_int(total) or not isinstance(pages, list) or len(pages) != math.ceil(total / PAGE_TILES):
        raise ValueError('Conteo de teselas o páginas incompatible')
    parts_schema = [(row[1], row[2].upper(), row[3], row[5])
                    for row in con.execute('PRAGMA table_info(snapshot_parts)')]
    if parts_schema != [('digest', 'TEXT', 1, 1), ('body', 'TEXT', 1, 0)]:
        raise ValueError('Esquema snapshot_parts incompatible')
    if con.execute('PRAGMA user_version').fetchone()[0] < 5:
        raise ValueError('Snapshot paginado requiere esquema 5')
    rows = []
    cumulative = body_bytes
    for index, page in enumerate(pages):
        expected_count = min(PAGE_TILES, total - index * PAGE_TILES)
        if not isinstance(page, dict) or set(page) != {'index', 'digest', 'count', 'bytes'} \
                or type(page['index']) is not int or page['index'] != index \
                or not isinstance(page['digest'], str) or not SHA256.fullmatch(page['digest']) \
                or type(page['count']) is not int or page['count'] != expected_count \
                or type(page['bytes']) is not int or not 2 <= page['bytes'] <= MAX_PAGE_BYTES:
            raise ValueError('Descriptor de página incompatible')
        cumulative += page['bytes']
        if cumulative > MAX_SNAPSHOT_BYTES or bytes_read + cumulative > MAX_TOTAL_READ_BYTES:
            raise ValueError('Límite prudente de lectura excedido')
        stored = con.execute('SELECT body FROM snapshot_parts WHERE digest=? '
                             'AND length(CAST(body AS BLOB))=?',
                             (page['digest'], page['bytes'])).fetchone()
        if not stored or not isinstance(stored[0], str):
            raise ValueError('Página ausente')
        page_body = stored[0]
        if len(page_body.encode('utf-8')) != page['bytes'] or hashlib.sha256(page_body.encode('utf-8')).hexdigest() != page['digest']:
            raise ValueError('Bytes o digest de página no concuerdan')
        chunk = strict_json(page_body)
        if not isinstance(chunk, list) or len(chunk) != page['count']:
            raise ValueError('Conteo o tipo de filas de página incompatible')
        for row in chunk:
            validate_tile(row)
        rows.extend(chunk)
    if len(rows) != total:
        raise ValueError('Conteo total de teselas incompatible')
    return {**world, 'tiles': rows}, cumulative, 'snapshot-parts-v1', len(pages)


def clamp(x):
    return max(0, min(1, x))


def capacities(item):
    """Transcripción aritmética de src/world/technology.ts:106-115."""
    p, composition, mass = item['properties'], item['composition'], item['mass']
    integrity = clamp(mass / max(1, item['initialMass']))
    solidity = 1 - composition['water'] / max(1, mass)
    usable = min(1, mass / 500) * integrity * solidity * clamp(1 - p['temperature'])
    return {
        'cutting': clamp(p['edge'] * p['hardness'] * p['cohesion'] * 1.7) * usable,
        'storage': clamp(p['containment'] * p['cohesion'] * (1 - p['porosity']) * 2) * usable,
        'insulation': clamp(p['insulation'] * p['cohesion'] * (0.3 + p['alignment']) * 1.2) * usable,
        'cultivation': clamp(p['leverage'] * (p['hardness'] * .7 + p['toughness'] * .3) * p['cohesion'] * 1.6) * usable,
        'binding': clamp(p['flexibility'] * p['alignment'] * p['cohesion'] * 1.8) * usable,
        'abrasion': clamp(p['hardness'] * (1 - p['porosity']) * (1 - p['edge'] * .5) * p['cohesion']) * usable,
    }


def radius_stock(tile_by_xy, center, radius):
    x, y = center
    cells = [(x + dx, y + dy) for dx in range(-radius, radius + 1)
             for dy in range(-radius, radius + 1) if dx*dx + dy*dy <= radius*radius]
    observed = [tile_by_xy[xy] for xy in cells if xy in tile_by_xy]
    return {'centro': [x, y], 'celdas_esperadas': len(cells),
            'celdas_observadas': len(observed),
            'madera': sum(tile[8] or 0 for tile in observed),
            'piedra': sum(tile[9] or 0 for tile in observed),
            'fauna': sum(tile[18] or 0 for tile in observed),
            'celdas_madera_cosechable': sum((tile[8] or 0) >= 1 for tile in observed),
            'celdas_piedra_cosechable': sum((tile[9] or 0) >= 1 for tile in observed),
            'celdas_fauna': sum((tile[18] or 0) >= 1 for tile in observed)}


def reference_centers(reference_path, seed, source):
    path = Path(reference_path)
    if path.stat().st_size > MAX_REFERENCE_BYTES:
        raise ValueError('JSON agregado de referencia excede 1 MiB')
    reference = strict_json(path.read_text(encoding='utf-8'))
    if not isinstance(reference, dict) or reference.get('fuente_temporal') != source \
            or not isinstance(reference.get('snapshots'), list):
        raise ValueError('Fuente o formato de referencia incompatible')
    candidates = []
    for snapshot in reference['snapshots']:
        if not isinstance(snapshot, dict) or type(snapshot.get('seed')) is not int or snapshot['seed'] != seed:
            raise ValueError('Semilla de referencia incompatible')
        day = snapshot.get('dia')
        if type(day) not in (int, float) or not math.isfinite(day):
            raise ValueError('Día de referencia incompatible')
        if day < 25:
            candidates.append(snapshot)
    if not candidates:
        raise ValueError('La referencia carece de un snapshot anterior al día 25')
    chosen = max(candidates, key=lambda row: (row['dia'], row.get('saved_at_ms', 0)))
    if not isinstance(chosen.get('sha256'), str) or not SHA256.fullmatch(chosen['sha256']) \
            or not isinstance(chosen.get('comunidades'), list):
        raise ValueError('Snapshot de referencia incompleto')
    centers = []
    seen = set()
    for group in chosen['comunidades']:
        if not isinstance(group, dict) or type(group.get('id')) not in (str, int) or group['id'] in seen:
            raise ValueError('ID de comunidad de referencia incompatible o duplicado')
        seen.add(group['id'])
        r7, r16 = group.get('radio_7'), group.get('radio_16')
        if not isinstance(r7, dict) or not isinstance(r16, dict):
            raise ValueError('Radios de referencia incompletos')
        center = r7.get('centro')
        if not isinstance(center, list) or len(center) != 2 or any(type(v) is not int for v in center) \
                or r16.get('centro') != center:
            raise ValueError('Centros radio 7/16 de referencia incompatibles')
        centers.append((group['id'], center))
    return {'dia': chosen['dia'], 'sha256': chosen['sha256'], 'slot': chosen.get('slot'),
            'descripcion': 'Sonda de sitio fijo en coordenadas pre25; no es el radio actual de la comunidad'}, centers


def measure(world, fixed_centers=None):
    if world.get('tileEncoding') != 'tiles-tuple-v1' or world.get('snapshotEncoding'):
        raise ValueError('Se requiere snapshot completo con tiles-tuple-v1, sin partes diferidas')
    tiles = world['tiles']
    for tile in tiles:
        validate_tile(tile)
    tile_by_xy = {(tile[0], tile[1]): tile for tile in tiles}
    if len(tile_by_xy) != len(tiles):
        raise ValueError('Teselas duplicadas')
    animals = collections.Counter((a['x'], a['y']) for a in world['animals'] if a['health'] > 0)
    if sum(tile[18] or 0 for tile in tiles) != sum(animals.values()) or any(
            (tile_by_xy.get(xy) or [None] * 19)[18] != count for xy, count in animals.items()):
        raise ValueError('Fauna de teselas y animales activos no concuerdan')
    people = {p['id']: p for p in world['people']}
    groups = []
    for group in world['communities']:
        members = [people[ident] for ident in group['members'] if ident in people and people[ident]['role'] == 'neighbor']
        if not members:
            continue
        inventories = [item for p in members for item in p['technology']['items']]
        functional = [capacities(item) for item in inventories]
        row = {'id': group['id'], 'miembros_vecinos': len(members),
               'material_personal': {key: sum(p['materials'][key] for p in members) for key in ('wood', 'stone')},
               'objetos': len(inventories), 'masa_objetos': sum(item['mass'] for item in inventories),
               'objetos_funcionales': sum(any(cap[c] > .07 for c in CAPABILITIES) for cap in functional),
               'objetos_por_capacidad': {c: sum(cap[c] > .07 for cap in functional) for c in CAPABILITIES}}
        for radius in RADII:
            row[f'radio_{radius}'] = radius_stock(tile_by_xy, (group['x'], group['y']), radius)
        groups.append(row)
    result = {'seed': world['seed'], 'tick': world['tick'], 'dia': world['tick'] / TICKS_PER_DAY,
            'poblacion_vecina': sum(p['role'] == 'neighbor' for p in people.values()),
            'teselas_activas': len(tiles), 'fauna_activa': sum(animals.values()),
            'planos': len(world['blueprints']), 'estructuras': len(world['structures']),
            'comunidades': groups}
    if fixed_centers is not None:
        current_centers = {row['id']: row['radio_7']['centro'] for row in groups}
        result['centros_fijos'] = [
            {'id': ident, 'centro_comunidad_actual': current_centers.get(ident),
             **{f'radio_{radius}': radius_stock(tile_by_xy, center, radius) for radius in RADII}}
            for ident, center in fixed_centers]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sqlite', required=True)
    parser.add_argument('--seed', type=int, required=True)
    parser.add_argument('--centros-desde', help='JSON agregado pre25 de la misma semilla y SQLite temporal')
    args = parser.parse_args()
    path = Path(args.sqlite).resolve(strict=True)
    if path.name != 'world.sqlite' or not path.parent.name.startswith('atlas-lab-') or 'tmp-atlas-lab' not in path.parts:
        parser.error('Solo se permite un world.sqlite temporal bajo tmp-atlas-lab/atlas-lab-*')
    fixed_reference, fixed_centers = (reference_centers(args.centros_desde, args.seed, str(path))
                                      if args.centros_desde else (None, None))
    started = time.perf_counter()
    uri = path.as_uri() + '?mode=ro'
    con = sqlite3.connect(uri, uri=True, timeout=1)
    try:
        con.execute('PRAGMA query_only=ON')
        con.execute('BEGIN')
        columns = [row[1] for row in con.execute('PRAGMA table_info(snapshots)')]
        if columns != ['slot', 'body', 'digest', 'saved_at']:
            raise ValueError('Esquema de snapshots no esperado')
        info = con.execute('SELECT slot,length(CAST(body AS BLOB)),saved_at FROM snapshots ORDER BY saved_at').fetchall()
        if len(info) > MAX_SLOTS or any(n is None or n > MAX_BODY_BYTES for _, n, _ in info):
            raise ValueError('Límite de snapshots o cuerpo excedido')
        summaries = []
        bytes_read = 0
        for slot, _, saved_at in info:
            stored = con.execute('SELECT body,digest FROM snapshots WHERE slot=?', (slot,)).fetchone()
            if not stored or not isinstance(stored[0], str) or not isinstance(stored[1], str):
                raise ValueError('Snapshot ausente o incompatible')
            body, digest = stored
            if not SHA256.fullmatch(digest):
                raise ValueError('Digest de snapshot incompatible')
            world, size, encoding, pages = load_stored_snapshot(con, body, digest, bytes_read)
            bytes_read += size
            if world.get('seed') != args.seed:
                raise ValueError('Semilla distinta a la solicitada')
            summary = measure(world, fixed_centers)
            summary.update({'slot': slot, 'saved_at_ms': saved_at, 'sha256': digest,
                            'bytes': size, 'codificacion': encoding, 'paginas': pages})
            summaries.append(summary)
        con.rollback()
    finally:
        con.close()
    output = {'fuente_temporal': str(path), 'modo': 'SQLite mode=ro, query_only=ON, BEGIN, SELECT, ROLLBACK',
                      'metodo': {'radios': list(RADII), 'centro': 'coordenadas guardadas de cada comunidad',
                                 'teselas': 'snapshot.tiles activo; wood/stone/fauna índices 8/9/18 de tiles-tuple-v1',
                                 'funcional': 'materialCapacities > 0.07 por capacidad; objetos de vecinos miembros',
                                 'superposicion': 'radios de comunidades pueden solaparse; no sumar entre ellas'},
                      'lectura_bytes': sum(s['bytes'] for s in summaries),
                      'duracion_segundos': time.perf_counter()-started,
                      'snapshots': summaries}
    if fixed_reference is not None:
        output['referencia_centros_fijos'] = fixed_reference
    print(json.dumps(output, indent=2, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main()
