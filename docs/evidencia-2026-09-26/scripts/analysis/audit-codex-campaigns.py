#!/usr/bin/env python3
"""Audita T1–T3 contra archivos diarios, manifiestos y relanzadas.

--muestra imprime progreso sin escribir. El modo final escribe la auditoría
incluso si una réplica falló: estado rojo y exit 2, nunca un verde parcial.
"""

import argparse
import hashlib
import json
from pathlib import Path
import sys


BASE = Path('/datos/tmp-atlas-lab/datos-lab')
BALANCE = Path('/datos/tmp-atlas-lab/balance')
SHA_V4 = '667454d5e0232885d78c37775d6a5619f516872d'
SHA_C8 = 'd2ebf11d51c3221477d88c7045faeafa2a229683'
LIMITS = {'teselasActivas': 1303552, 'chunks': 5092, 'fauna': 7821312}
GROUPS = (
    ('CTRLV4', BASE / 'ctrlv4', range(6001, 6021), SHA_V4,
     {6004, 6009, 6010, 6011, 6012, 6013, 6015, 6017, 6018}, 'tower'),
    ('HOG', BASE / 'c8panel', range(2001, 2013), SHA_C8, {2010}, 'tower'),
    ('CTRL2', BASE / 'c8panel/portatil', range(2001, 2013), SHA_C8,
     {2002, 2004, 2006, 2007, 2008, 2009, 2010, 2011, 2012}, 'laptop'),
    ('PUB2', BASE / 'f21b-portatil', (5, 29, 101, 202, 404, 505, 606, 707), SHA_C8,
     {5, 29, 101, 202, 404, 606, 707}, 'laptop'),
)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def progress(path):
    states = {}
    if not path.is_file():
        return states, False
    finished = False
    stopped = False
    for line in path.read_text().splitlines()[1:]:
        parts = line.split('\t')
        if len(parts) != 4:
            raise ValueError(f'Fila mal formada en {path}: {line}')
        _, name, state, info = parts
        if name == 'GESTOR':
            if state == 'DETENER':
                stopped = True
            if state == 'FIN' and info == 'réplicas terminadas':
                finished = True
            continue
        row = states.setdefault(name, {'identidad': set(), 'estados': [], 'fallos': []})
        row['estados'].append(state)
        if state == 'FALLO':
            row['fallos'].append(info)
        if state == 'IDENTIDAD':
            row['identidad'].add(int(info.split()[0].split('=')[1]))
    return states, finished and not stopped


def audit():
    p_tower, tower_finished = progress(BASE / 'codex-tower-20260926.tsv')
    p_laptop, laptop_finished = progress(BALANCE / 'codex-laptop-20260926.tsv')
    out = {'tipo': 'auditoria_campanas_codex_20260926',
           'gestores': {'torreFin': tower_finished, 'portatilFin': laptop_finished},
           'grupos': {}, 'faltantes': [], 'fallos': []}
    for arm, root, seeds, sha, reruns, host in GROUPS:
        rows = []
        for seed in seeds:
            name = f'{arm}-{seed}'
            folder = root / name
            missing = []
            day_hashes = {}
            meta_path = folder / 'replica.json'
            meta = None
            if meta_path.is_file():
                try:
                    meta = json.loads(meta_path.read_text())
                    if not isinstance(meta, dict):
                        missing.append('replica.json no es objeto')
                        meta = None
                except (OSError, ValueError) as exc:
                    missing.append(f'replica.json ilegible: {exc}')
            if meta is None:
                if not meta_path.is_file():
                    missing.append('replica.json')
            else:
                if meta.get('seed') != seed or meta.get('dias') != 60 or meta.get('sha') != sha:
                    missing.append('manifiesto no corresponde a semilla/días/SHA')
                params = meta.get('params', {})
                if not isinstance(params, dict):
                    params = {}
                    missing.append('params no es objeto')
                for section in ('persistencia', 'limites', 'social'):
                    if not isinstance(params.get(section), dict):
                        params[section] = {}
                if params.get('persistencia', {}).get('cadaTicks') != 300:
                    missing.append('persistencia.cadaTicks != 300')
                for key, value in LIMITS.items():
                    if params.get('limites', {}).get(key) != value:
                        missing.append(f'limites.{key} != {value}')
                expected_hog = 1 if arm == 'HOG' else 0
                if params.get('social', {}).get('hogarTrabajo') != expected_hog:
                    missing.append(f'social.hogarTrabajo != {expected_hog}')
            days_found = 0
            for day in range(1, 61):
                path = folder / f'dia-{day:03}.json'
                if not path.is_file():
                    missing.append(f'dia-{day:03}.json')
                    continue
                days_found += 1
                try:
                    body = json.loads(path.read_text())
                    if not isinstance(body, dict) or body.get('tick') != day * 2400:
                        missing.append(f'tick incorrecto día {day}')
                    if day in (1, 3, 60):
                        day_hashes[str(day)] = digest(path)
                except (OSError, ValueError) as exc:
                    missing.append(f'dia-{day:03d}.json ilegible: {exc}')
            if len(list(folder.glob('dia-*.json'))) != days_found:
                missing.append('archivos de día extra o mal nombrados')
            archived = root / 'parciales-20260924' / name
            p = (p_tower if host == 'tower' else p_laptop).get(name, {})
            terminal = next((state for state in reversed(p.get('estados', []))
                             if state in ('COMPLETA', 'FALLO')), None)
            if seed in reruns:
                if not (archived / 'dia-003.json').is_file():
                    missing.append('parcial previo no archivado')
                if p.get('identidad') != {1, 2, 3}:
                    missing.append('identidad días 1–3 no acreditada en gestor')
                if terminal != 'COMPLETA':
                    missing.append(f'gestor sin COMPLETA final (último terminal: {terminal})')
            if terminal == 'FALLO':
                failure = {'replica': name, 'detalleGestor': p.get('fallos', [])[-1] if p.get('fallos') else None}
                out['fallos'].append(failure)
                missing.append(f'gestor marcó FALLO final: {failure["detalleGestor"]}')
            if missing:
                out['faltantes'].append({'replica': name, 'errores': missing})
            rows.append({'replica': name, 'diasEncontrados': days_found,
                         'sha': meta.get('sha') if meta else None,
                         'relaunch': seed in reruns, 'parcialArchivado': archived.is_dir(),
                         'identidadDias': sorted(p.get('identidad', [])),
                         'ultimoEstadoGestor': terminal, 'fallosHistoricosGestor': p.get('fallos', []),
                         'hashesDia': day_hashes, 'errores': missing,
                         'estado': 'fallo' if terminal == 'FALLO' else 'completa' if not missing else 'incompleta'})
        out['grupos'][arm] = {'requeridas': len(tuple(seeds)),
                              'completas': sum(not row['errores'] for row in rows),
                              'fallidas': sum(row['estado'] == 'fallo' for row in rows),
                              'estado': 'fallo' if any(row['estado'] == 'fallo' for row in rows)
                                        else 'completo' if all(row['estado'] == 'completa' for row in rows)
                                        else 'incompleta',
                              'replicas': rows}
    out['estado'] = ('fallo' if out['fallos'] else
                     'completo' if not out['faltantes'] and tower_finished and laptop_finished else 'incompleta')
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--muestra', action='store_true')
    args = parser.parse_args()
    result = audit()
    if args.muestra:
        print(json.dumps({k: v for k, v in result.items() if k != 'grupos'} |
                         {'grupos': {k: {'requeridas': v['requeridas'], 'completas': v['completas'],
                                         'fallidas': v['fallidas'], 'estado': v['estado']}
                                     for k, v in result['grupos'].items()}}, ensure_ascii=False, indent=2))
        return 0
    target = BALANCE / 'auditoria-campanas-codex.json'
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(f'{target}: {result["estado"]}; {len(result["faltantes"])} réplicas con errores; '
          f'{len(result["fallos"])} fallos de gestor')
    return 0 if result['estado'] == 'completo' else 2


if __name__ == '__main__':
    raise SystemExit(main())
