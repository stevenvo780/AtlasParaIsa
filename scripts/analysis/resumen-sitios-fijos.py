#!/usr/bin/env python3
"""Compara agregados de snapshot-economia.py de una misma réplica, sin leer SQLite.

Uso: python3 scripts/analysis/resumen-sitios-fijos.py \
  --par 6018:/ruta/pre25.json:/ruta/fijos-post30.json [--par ...]
Solo lee los JSON indicados y escribe un resumen JSON a stdout.
"""
import argparse
import json
import math
import re
from pathlib import Path

RADII = (7, 16)
STOCK = ('madera', 'piedra', 'fauna')
HARVEST = ('celdas_madera_cosechable', 'celdas_piedra_cosechable', 'celdas_fauna')
MAX_JSON_BYTES = 4 * 1024 * 1024
SHA256 = re.compile(r'^[0-9a-f]{64}$')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_aggregate(path):
    source = Path(path)
    require(source.stat().st_size <= MAX_JSON_BYTES, f'JSON agregado excede 4 MiB: {source}')
    value = json.loads(source.read_text(encoding='utf-8'))
    require(isinstance(value, dict) and isinstance(value.get('snapshots'), list)
            and isinstance(value.get('fuente_temporal'), str) and value['fuente_temporal']
            and isinstance(value.get('metodo'), dict) and value['metodo'],
            f'Formato de agregado incompatible: {source}')
    return value


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def snapshot_at(aggregate, seed, before):
    candidates = []
    for snap in aggregate['snapshots']:
        require(isinstance(snap, dict) and type(snap.get('seed')) is int and snap['seed'] == seed,
                'Semilla de snapshot incompatible')
        day = snap.get('dia')
        require(finite(day) and day >= 0, 'Día de snapshot incompatible')
        if (before and day < 25) or (not before and day >= 30):
            candidates.append(snap)
    require(candidates, 'Falta snapshot pre25' if before else 'Post insuficiente: falta snapshot de día >=30')
    chosen = max(candidates, key=lambda row: (row['dia'], row.get('saved_at_ms', 0)))
    require(isinstance(chosen.get('sha256'), str) and SHA256.fullmatch(chosen['sha256']),
            'Digest de snapshot incompatible')
    return chosen


def groups_by_id(rows, label):
    require(isinstance(rows, list), f'{label}: lista de comunidades ausente')
    result = {}
    for row in rows:
        require(isinstance(row, dict) and type(row.get('id')) in (str, int)
                and row['id'] not in result, f'{label}: ID de comunidad incompatible o duplicado')
        result[row['id']] = row
    return result


def center(value, label):
    require(isinstance(value, list) and len(value) == 2 and all(type(v) is int for v in value),
            f'{label}: centro incompatible')
    return value


def radius(row, number, label):
    value = row.get(f'radio_{number}')
    require(isinstance(value, dict), f'{label}: falta radio {number}')
    center(value.get('centro'), label)
    expected, observed = value.get('celdas_esperadas'), value.get('celdas_observadas')
    require(type(expected) is int and type(observed) is int and expected > 0
            and 0 <= observed <= expected, f'{label}: cobertura incompatible')
    for key in STOCK:
        require(finite(value.get(key)) and value[key] >= 0, f'{label}: {key} incompatible')
    for key in HARVEST:
        require(type(value.get(key)) is int and 0 <= value[key] <= observed,
                f'{label}: {key} incompatible')
    return value


def functional_per_neighbor(group, label):
    count, members = group.get('objetos_funcionales'), group.get('miembros_vecinos')
    require(type(count) is int and type(members) is int and count >= 0 and members > 0,
            f'{label}: inventario funcional incompatible')
    return count / members


def measured(value):
    return {key: value[key] for key in ('celdas_esperadas', 'celdas_observadas', *STOCK, *HARVEST)}


def compare_pair(seed, pre_path, post_path):
    pre, post = read_aggregate(pre_path), read_aggregate(post_path)
    require(pre['fuente_temporal'] == post['fuente_temporal'], 'Fuente temporal distinta')
    require(pre['metodo'] == post['metodo'], 'Método de agregación distinto')
    before, after = snapshot_at(pre, seed, True), snapshot_at(post, seed, False)
    reference = post.get('referencia_centros_fijos')
    require(isinstance(reference, dict) and reference.get('dia') == before['dia']
            and reference.get('sha256') == before['sha256'],
            'Referencia de centros fijos no coincide con el último pre25')
    pre_groups = groups_by_id(before.get('comunidades'), 'pre25')
    post_groups = groups_by_id(after.get('comunidades'), 'post30')
    fixed_groups = groups_by_id(after.get('centros_fijos'), 'centros fijos')
    require(pre_groups.keys() == fixed_groups.keys(),
            'Los centros fijos post30 no corresponden exactamente a los ID pre25')
    result = []
    for ident, old_group in pre_groups.items():
        new_group, fixed = post_groups.get(ident), fixed_groups[ident]
        old_r7 = radius(old_group, 7, f'{ident} pre25')
        old_r16 = radius(old_group, 16, f'{ident} pre25')
        fixed_r7 = radius(fixed, 7, f'{ident} post30 fijo')
        fixed_r16 = radius(fixed, 16, f'{ident} post30 fijo')
        site = center(old_r7['centro'], f'{ident} pre25')
        require(old_r16['centro'] == site and fixed_r7['centro'] == site
                and fixed_r16['centro'] == site, f'{ident}: centro fijo no corresponde al pre25')
        current_center = None
        if new_group is not None:
            current_r7 = radius(new_group, 7, f'{ident} post30 actual')
            current_r16 = radius(new_group, 16, f'{ident} post30 actual')
            require(current_r7['centro'] == current_r16['centro'],
                    f'{ident}: radios del centro actual post30 incompatibles')
            current_center = current_r7['centro']
        require(fixed.get('centro_comunidad_actual') == current_center,
                f'{ident}: centro actual post30 incompatible')
        radius_results = {}
        for number, old, new in ((7, old_r7, fixed_r7), (16, old_r16, fixed_r16)):
            require(old['celdas_esperadas'] == new['celdas_esperadas'],
                    f'{ident}: geometría de radio {number} distinta')
            comparable = old['celdas_observadas'] == old['celdas_esperadas'] \
                and new['celdas_observadas'] == new['celdas_esperadas']
            radius_results[f'radio_{number}'] = {
                'antes_observado': measured(old), 'despues_observado': measured(new),
                'stock_fisico_comparable': comparable,
                'delta_stock_fisico_si_comparable':
                    {key: new[key] - old[key] for key in (*STOCK, *HARVEST)} if comparable else None,
            }
        old_tools = functional_per_neighbor(old_group, f'{ident} pre25')
        new_tools = functional_per_neighbor(new_group, f'{ident} post30') if new_group is not None else None
        result.append({'id': ident, 'estado': 'continua' if new_group is not None else 'desaparecida',
                       'centro_sitio_fijo': site,
                       'centro_comunidad_actual_antes': site,
                       'centro_comunidad_actual_despues': current_center,
                       'funcionales_por_vecino': {'antes': old_tools, 'despues': new_tools,
                                                  'delta': new_tools - old_tools if new_tools is not None else None},
                       **radius_results})
    for ident, new_group in post_groups.items():
        if ident in pre_groups:
            continue
        current_r7 = radius(new_group, 7, f'{ident} post30 nuevo')
        current_r16 = radius(new_group, 16, f'{ident} post30 nuevo')
        require(current_r7['centro'] == current_r16['centro'],
                f'{ident}: radios del centro nuevo incompatibles')
        new_tools = functional_per_neighbor(new_group, f'{ident} post30 nuevo')
        result.append({'id': ident, 'estado': 'nueva', 'centro_sitio_fijo': None,
                       'centro_comunidad_actual_antes': None,
                       'centro_comunidad_actual_despues': current_r7['centro'],
                       'funcionales_por_vecino': {'antes': None, 'despues': new_tools, 'delta': None},
                       **{f'radio_{number}': {'antes_observado': None, 'despues_observado': measured(current),
                                             'stock_fisico_comparable': False,
                                             'delta_stock_fisico_si_comparable': None}
                          for number, current in ((7, current_r7), (16, current_r16))}})
    for label, snap in (('pre25', before), ('post30', after)):
        for key in ('planos', 'estructuras', 'poblacion_vecina'):
            require(type(snap.get(key)) is int and snap[key] >= 0, f'{label}: {key} incompatible')
    return {'seed': seed, 'fuente_temporal': pre['fuente_temporal'],
            'antes': {'dia': before['dia'], 'sha256': before['sha256'],
                      'planos': before['planos'], 'estructuras': before['estructuras'],
                      'poblacion_vecina': before['poblacion_vecina']},
            'despues': {'dia': after['dia'], 'sha256': after['sha256'],
                        'planos': after['planos'], 'estructuras': after['estructuras'],
                        'poblacion_vecina': after['poblacion_vecina']},
            'comunidades': result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--par', action='append', required=True, metavar='SEED:PRE_JSON:POST_JSON')
    args = parser.parse_args()
    comparisons = []
    try:
        for spec in args.par:
            parts = spec.split(':', 2)
            require(len(parts) == 3 and parts[0].isdigit() and parts[1] and parts[2],
                    'Formato de --par: SEED:PRE_JSON:POST_JSON')
            comparisons.append(compare_pair(int(parts[0]), parts[1], parts[2]))
    except (ValueError, OSError, json.JSONDecodeError) as error:
        parser.error(str(error))
    print(json.dumps({'metodo': 'Sitios fijos pre25 de la misma réplica; radios solapados no se suman; '
                                  'comparación descriptiva sin inferencia causal',
                      'pares': comparisons}, indent=2, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main()
