#!/usr/bin/env python3
"""Compara dos JSON agregados de snapshot-economia.py; no lee SQLite ni escribe archivos.

Uso: python3 scripts/analysis/comparar-snapshots-economia.py --antes PRE.json --despues POST.json
Elige el snapshot de tick mayor con día <25 y >=30, respectivamente.
"""
import argparse
import json
import math
import re
from pathlib import Path

RADII = (7, 16)
STOCK = ('madera', 'piedra', 'fauna', 'celdas_madera_cosechable',
         'celdas_piedra_cosechable', 'celdas_fauna')
SHA256 = re.compile(r'^[0-9a-f]{64}$')


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def checked_number(value, label, integer=False, minimum=None):
    if not finite(value) or (integer and not isinstance(value, int)) or (minimum is not None and value < minimum):
        raise ValueError(f'{label}: número inválido')
    return value


def load_cut(path, predicate, label):
    with open(path, encoding='utf-8') as file:
        data = json.load(file)
    source = data.get('fuente_temporal')
    if not isinstance(source, str) or not source or not Path(source).is_absolute() or Path(source).name != 'world.sqlite' \
            or not Path(source).parent.name.startswith('atlas-lab-') or 'tmp-atlas-lab' not in Path(source).parts:
        raise ValueError(f'{label}: fuente_temporal no es una ruta SQLite temporal del extractor')
    method = data.get('metodo')
    if not isinstance(method, dict) or not method:
        raise ValueError(f'{label}: falta metodo del extractor')
    snapshots = data.get('snapshots')
    if not isinstance(snapshots, list) or not snapshots:
        raise ValueError(f'{label}: falta snapshots[]')
    eligible = []
    for snap in snapshots:
        if not isinstance(snap, dict):
            raise ValueError(f'{label}: snapshot inválido')
        tick = checked_number(snap.get('tick'), f'{label}.tick', integer=True, minimum=0)
        day = checked_number(snap.get('dia'), f'{label}.dia', minimum=0)
        if not math.isclose(day, tick / 2400, abs_tol=1e-9):
            raise ValueError(f'{label}: tick/día inconsistentes')
        if predicate(day):
            eligible.append(snap)
    if not eligible:
        raise ValueError(f'{label}: no hay corte temporal elegible')
    snap = max(eligible, key=lambda x: x['tick'])
    checked_number(snap.get('seed'), f'{label}.seed', integer=True, minimum=0)
    if not isinstance(snap.get('sha256'), str) or not SHA256.fullmatch(snap['sha256']):
        raise ValueError(f'{label}: falta digest SHA-256 válido')
    for key in ('planos', 'estructuras', 'poblacion_vecina'):
        checked_number(snap.get(key), f'{label}.{key}', integer=True, minimum=0)
    groups = snap.get('comunidades')
    if not isinstance(groups, list):
        raise ValueError(f'{label}: falta comunidades[]')
    by_id = {}
    for group in groups:
        if not isinstance(group, dict) or not isinstance(group.get('id'), str) or not group['id'] or group['id'] in by_id:
            raise ValueError(f'{label}: ID de comunidad inválido o duplicado')
        checked_number(group.get('miembros_vecinos'), f'{label}.miembros_vecinos', integer=True, minimum=0)
        checked_number(group.get('objetos_funcionales'), f'{label}.objetos_funcionales', integer=True, minimum=0)
        materials = group.get('material_personal')
        if not isinstance(materials, dict):
            raise ValueError(f'{label}: falta material_personal')
        checked_number(materials.get('wood'), f'{label}.material_personal.wood', minimum=0)
        for radius in RADII:
            r = group.get(f'radio_{radius}')
            if not isinstance(r, dict) or not isinstance(r.get('centro'), list) or len(r['centro']) != 2:
                raise ValueError(f'{label}: falta centro de radio {radius}')
            for coord in r['centro']:
                checked_number(coord, f'{label}.centro', integer=True)
            expected = checked_number(r.get('celdas_esperadas'), f'{label}.celdas_esperadas', integer=True, minimum=1)
            observed = checked_number(r.get('celdas_observadas'), f'{label}.celdas_observadas', integer=True, minimum=0)
            if observed > expected:
                raise ValueError(f'{label}: cobertura > total')
            for key in STOCK:
                checked_number(r.get(key), f'{label}.radio_{radius}.{key}', minimum=0)
        if group['radio_7']['centro'] != group['radio_16']['centro']:
            raise ValueError(f'{label}: centros radio 7 y 16 difieren dentro de una comunidad')
        by_id[group['id']] = group
    return snap, by_id, source, method


def delta_pair(before, after):
    return {'antes': before, 'despues': after, 'cambio': after - before}


def per_neighbor(group, field):
    if group is None or group['miembros_vecinos'] == 0:
        return None
    total = group['objetos_funcionales'] if field == 'objetos_funcionales' else group['material_personal']['wood']
    return total / group['miembros_vecinos']


def observed_radius(group, radius):
    if group is None:
        return None
    r = group[f'radio_{radius}']
    return {'centro': r['centro'], 'celdas_observadas': r['celdas_observadas'],
            'celdas_esperadas': r['celdas_esperadas'],
            'stock_observado': {key: r[key] for key in STOCK}}


def compare_group(group_id, before, after):
    result = {'id': group_id,
              'miembros_vecinos': {'antes': before['miembros_vecinos'] if before else None,
                                   'despues': after['miembros_vecinos'] if after else None},
              'objetos_funcionales_por_vecino': {'antes': per_neighbor(before, 'objetos_funcionales'),
                                                  'despues': per_neighbor(after, 'objetos_funcionales')},
              'madera_personal_por_vecino': {'antes': per_neighbor(before, 'wood'),
                                             'despues': per_neighbor(after, 'wood')},
              'radios': {}}
    for key in ('objetos_funcionales_por_vecino', 'madera_personal_por_vecino'):
        pair = result[key]
        pair['cambio'] = pair['despues'] - pair['antes'] if pair['antes'] is not None and pair['despues'] is not None else None
    for radius in RADII:
        a, b = observed_radius(before, radius), observed_radius(after, radius)
        reasons = []
        if a is None or b is None:
            reasons.append('comunidad_ausente_en_un_corte')
        else:
            if a['centro'] != b['centro']:
                reasons.append('centro_diferente')
            if a['celdas_observadas'] < a['celdas_esperadas'] or b['celdas_observadas'] < b['celdas_esperadas']:
                reasons.append('cobertura_incompleta')
            if a['celdas_esperadas'] != b['celdas_esperadas']:
                reasons.append('geometria_diferente')
        entry = {'estado': 'no_comparable' if reasons else 'comparable', 'motivos': reasons,
                 'observado_antes': a, 'observado_despues': b}
        if not reasons:
            entry['cambios_stock'] = {key: b['stock_observado'][key] - a['stock_observado'][key] for key in STOCK}
        result['radios'][str(radius)] = entry
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--antes', type=Path, required=True)
    parser.add_argument('--despues', type=Path, required=True)
    args = parser.parse_args()
    before, before_groups, before_source, before_method = load_cut(args.antes, lambda day: day < 25, 'antes')
    after, after_groups, after_source, after_method = load_cut(args.despues, lambda day: day >= 30, 'despues')
    if before['seed'] != after['seed']:
        parser.error('Los cortes tienen semillas diferentes')
    if before_source != after_source or before_method != after_method:
        parser.error('Los cortes no están pareados: fuente_temporal o metodo diferentes')
    if after['tick'] <= before['tick']:
        parser.error('El corte posterior no es posterior')
    output = {
        'alcance': 'comparación descriptiva de dos snapshots agregados de la misma semilla; no identifica causa',
        'semilla': before['seed'],
        'fuente_temporal': before_source,
        'metodo': before_method,
        'antes': {'archivo': str(args.antes), 'tick': before['tick'], 'dia': before['dia'], 'sha256': before['sha256']},
        'despues': {'archivo': str(args.despues), 'tick': after['tick'], 'dia': after['dia'], 'sha256': after['sha256']},
        'global': {'poblacion_vecina': delta_pair(before['poblacion_vecina'], after['poblacion_vecina']),
                   'planos': delta_pair(before['planos'], after['planos']),
                   'estructuras': delta_pair(before['estructuras'], after['estructuras'])},
        'comunidades': [compare_group(group_id, before_groups.get(group_id), after_groups.get(group_id))
                        for group_id in sorted(before_groups.keys() | after_groups.keys())],
    }
    print(json.dumps(output, indent=2, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main()
