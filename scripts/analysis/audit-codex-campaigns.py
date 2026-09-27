#!/usr/bin/env python3
"""Audita T1–T3 contra archivos diarios, manifiestos y relanzadas.

--muestra imprime progreso sin escribir. El modo final escribe la auditoría
incluso si una réplica falló: estado rojo y exit 2, nunca un verde parcial.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys


BASE = Path('/datos/tmp-atlas-lab/datos-lab')
BALANCE = Path('/datos/tmp-atlas-lab/balance')
SHA_V4 = '667454d5e0232885d78c37775d6a5619f516872d'
SHA_C8 = 'd2ebf11d51c3221477d88c7045faeafa2a229683'
LIMITS = {'teselasActivas': 1303552, 'chunks': 5092, 'fauna': 7821312}
GOVERNOR = 'no-ejecutado; replica de leyes, no del servidor'
EXPECTED = {
    'CTRLV4': {
        'digest': 'd896b52065e33463ecb824137431e896432da83d14be01a1233443325c5f0b74',
        'paramsSha256': '5b1bbb549e7dec5bfd7fdac11dcf8e89b33d2bfea5d80ac0a5865d17871338bb',
        'instrumentos': 'si; solo lectura (scripts/lab/instrumentos.ts): conducta por tiempo, comida compartida, natalidad local y panel C8',
    },
    'HOG': {
        'digest': '63d4fc53b1a4c92e9c10bebed763958183ac22f246d8af744ba6a6ebfc840f0a',
        'paramsSha256': '9a60a0576abbfd10bf9fad79e53c5d98550efc8d18c9cafe7c756b8833265b42',
        'instrumentos': 'si; solo lectura (scripts/lab/instrumentos.ts): conducta por tiempo y comida compartida',
    },
    'CTRL2': {
        'digest': '63d4fc53b1a4c92e9c10bebed763958183ac22f246d8af744ba6a6ebfc840f0a',
        'paramsSha256': '3d7a05d5d1d2ee6ee0ee6feaeb18bbc8a2599db1b64c7365a6569bfec7e43b36',
        'instrumentos': 'si; solo lectura (scripts/lab/instrumentos.ts): conducta por tiempo y comida compartida',
    },
    'PUB2': {
        'digest': '63d4fc53b1a4c92e9c10bebed763958183ac22f246d8af744ba6a6ebfc840f0a',
        'paramsSha256': '3d7a05d5d1d2ee6ee0ee6feaeb18bbc8a2599db1b64c7365a6569bfec7e43b36',
        'instrumentos': 'si; solo lectura (scripts/lab/instrumentos.ts): conducta por tiempo y comida compartida',
    },
}
GROUPS = (
    ('CTRLV4', BASE / 'ctrlv4', range(6001, 6021), SHA_V4,
     {6004, 6009, 6010, 6011, 6012, 6013, 6015, 6017, 6018}, 'tower'),
    ('HOG', BASE / 'c8panel', range(2001, 2013), SHA_C8, {2010}, 'tower'),
    ('CTRL2', BASE / 'c8panel/portatil', range(2001, 2013), SHA_C8,
     {2002, 2004, 2006, 2007, 2008, 2009, 2010, 2011, 2012}, 'laptop'),
    ('PUB2', BASE / 'f21b-portatil', (5, 29, 101, 202, 404, 505), SHA_C8,
     {5, 29, 101, 202, 404}, 'laptop'),
    ('PUB2', BASE / 'f21b-torre', (606, 707), SHA_C8, {606, 707}, 'pub2_tower'),
)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def params_sha256(params):
    if not isinstance(params, dict):
        raise ValueError('params no es objeto')
    packed = json.dumps(params, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(packed).hexdigest()


def overlap_evidence(usar_hedge_torre=False):
    # Importación read-only sin generar __pycache__ en el worktree compartido.
    path = Path(__file__).with_name('verificar-solapes-relanzadas.py')
    namespace = {'__name__': 'verificar_solapes', '__file__': str(path)}
    exec(compile(path.read_bytes(), str(path), 'exec'), namespace)
    return namespace['verify'](BASE, usar_hedge_torre)


def provenance_functions():
    # El mismo gate read-only que consumen F2.1/T5 y el preflight C8.
    path = Path(__file__).with_name('hedge_provenance.py')
    namespace = {'__name__': 'hedge_provenance', '__file__': str(path)}
    exec(compile(path.read_bytes(), str(path), 'exec'), namespace)
    return namespace


def safe_progress(path):
    try:
        states, finished, interrupted = progress(path)
        return states, finished, interrupted, None
    except ValueError as exc:
        return {}, False, False, str(exc)


def progress(path):
    states = {}
    if not path.is_file():
        return states, False, False
    finished = False
    stopped = False
    started = False
    for line in path.read_text().splitlines()[1:]:
        parts = line.split('\t')
        if len(parts) != 4:
            raise ValueError(f'Fila mal formada en {path}: {line}')
        _, name, state, info = parts
        if name == 'GESTOR':
            if state == 'INICIO':
                started = True
            if state == 'DETENER':
                stopped = True
            if state == 'FIN' and info == 'réplicas terminadas':
                finished = True
            continue
        row = states.setdefault(name, {'identidad': set(), 'identidadHashes': {}, 'estados': [], 'fallos': []})
        row['estados'].append(state)
        if state == 'LANZADA':
            row.setdefault('lanzamientos', []).append(info)
        if state == 'FALLO':
            row['fallos'].append(info)
        if state == 'IDENTIDAD':
            match = re.search(r'(?:día|dia)=(\d+)\s+sha256(?:canon)?=([0-9a-f]{64})', info)
            if not match:
                raise ValueError(f'IDENTIDAD mal formada en {path}: {name} {info}')
            day = int(match.group(1))
            if day in row['identidadHashes']:
                raise ValueError(f'IDENTIDAD duplicada en {path}: {name} día {day}')
            row['identidad'].add(day)
            row['identidadHashes'][day] = match.group(2)
    laptop_names = {f'CTRL2-{seed}' for seed in (2002, 2004, 2006, 2007, 2008, 2009, 2010, 2011, 2012)}
    laptop_names |= {f'PUB2-{seed}' for seed in (5, 29, 101, 202, 404)}
    interrupted = (path.name == 'codex-laptop-20260926.tsv' and started and not finished and not stopped
                   and set(states) == laptop_names
                   and all(set(row['estados']) == {'LANZADA', 'IDENTIDAD'}
                           and row['estados'].count('LANZADA') == 1
                           and row['estados'].count('IDENTIDAD') == 3
                           and row['identidad'] == {1, 2, 3} and not row['fallos']
                           for row in states.values()))
    return states, finished and not stopped, interrupted


def audit(usar_hedge_torre=False):
    p_tower, tower_finished, _, tower_log_error = safe_progress(BASE / 'codex-tower-20260926.tsv')
    p_laptop, laptop_finished, laptop_interrupted, laptop_log_error = safe_progress(BALANCE / 'codex-laptop-20260926.tsv')
    p_pub2_tower, _, _, pub2_log_error = safe_progress(BASE / 'f21b-torre/codex-pub2-torre-20260926.tsv')
    p_hedge, _, _, hedge_log_error = (safe_progress(BASE / 'hedge-torre-20260926/codex-hedge-torre-20260926.tsv')
                                   if usar_hedge_torre else ({}, False, False, None))
    hedge_names = {f'CTRL2-{seed}' for seed in (2002, 2004, 2006, 2007, 2008, 2009, 2010, 2011, 2012)}
    hedge_names |= {f'PUB2-{seed}' for seed in (5, 29, 101, 202, 404)}
    overlaps = overlap_evidence(usar_hedge_torre)
    overlap_by_name = {row['replica']: row for row in overlaps['replicas']}
    groups = GROUPS
    # PUB2-505 ya era completa en el portátil; solo cinco PUB2 y nueve CTRL2 se sustituyen.
    if usar_hedge_torre:
        groups = tuple((arm, BASE / 'hedge-torre-20260926', tuple(sorted(reruns)), sha, reruns, 'hedge')
                       if arm == 'CTRL2' else
                       (arm, BASE / 'hedge-torre-20260926', (5, 29, 101, 202, 404), sha,
                        {5, 29, 101, 202, 404}, 'hedge') if arm == 'PUB2' and host == 'laptop' else
                       (arm, root, seeds, sha, reruns, host)
                       for arm, root, seeds, sha, reruns, host in GROUPS)
        groups += (('CTRL2', BASE / 'c8panel/portatil', (2001, 2003, 2005), SHA_C8, set(), 'laptop'),)
        groups += (('PUB2', BASE / 'f21b-portatil', (505,), SHA_C8, set(), 'laptop'),)
    out = {'tipo': 'auditoria_campanas_codex_20260926',
           'fuente14Relanzadas': 'hedge-torre-20260926' if usar_hedge_torre else 'portatil',
           'gestores': {'torreFin': tower_finished, 'portatilFin': laptop_finished,
                       'portatilInterrumpidoCon14Lanzadas': laptop_interrupted,
                       'pub2TorreProcedencia': bool(p_pub2_tower),
                       'hedgeTorreProcedencia': False},
           'solapes': {'estado': overlaps['estado'], **overlaps['resumen']},
           'procedencia': {}, 'grupos': {}, 'faltantes': [], 'fallos': []}
    for label, error in (('torre', tower_log_error), ('portatil', laptop_log_error),
                         ('pub2Torre', pub2_log_error), ('hedgeTorre', hedge_log_error)):
        if error:
            out['fallos'].append({'replica': f'TSV-{label}', 'detalleProcedencia': error})
    provenance = provenance_functions()
    selected_name = 'hedgeTorre' if usar_hedge_torre else 'portatil14'
    checks = [
        ('pub2Torre', BASE / 'f21b-torre/codex-pub2-torre-20260926.tsv',
         [BASE / 'f21b-torre' / f'PUB2-{seed}' for seed in (606, 707)],
         lambda: provenance['verify_pub2_tower'](BASE, require_complete=False)),
        (selected_name,
         BASE / 'hedge-torre-20260926/codex-hedge-torre-20260926.tsv' if usar_hedge_torre
         else BALANCE / 'codex-laptop-20260926.tsv',
         [BASE / 'hedge-torre-20260926' / name for name in hedge_names] if usar_hedge_torre else
         [BASE / ('c8panel/portatil' if name.startswith('CTRL2-') else 'f21b-portatil') / name
          for name in hedge_names],
         (lambda: provenance['verify_hedge'](BASE, require_complete=False)) if usar_hedge_torre
         else (lambda: provenance['verify_laptop'](BASE, BALANCE, require_complete=False))),
    ]
    for label, log, folders, check in checks:
        if not log.is_file() or not all(folder.is_dir() for folder in folders):
            out['procedencia'][label] = {'estado': 'pendiente', 'motivo': 'TSV o directorios de réplicas ausentes'}
            continue
        try:
            result = check()
            out['procedencia'][label] = {'estado': result['estado'],
                                         'replicas': len(result['replicas']),
                                         'identidadesTSV': result['identidadesTSV'],
                                         'solapesComparados': result['solapesComparados']}
        except (ValueError, OSError) as exc:
            out['procedencia'][label] = {'estado': 'fallo', 'motivo': str(exc)}
            out['fallos'].append({'replica': f'PROCEDENCIA-{label}', 'detalleProcedencia': str(exc)})
    out['gestores']['pub2TorreProcedencia'] = out['procedencia']['pub2Torre']['estado'] == 'completo'
    out['gestores']['hedgeTorreProcedencia'] = (out['procedencia'].get('hedgeTorre', {}).get('estado') == 'completo')
    names = [f'{arm}-{seed}' for arm, _, seeds, _, _, _ in groups for seed in seeds]
    if len(names) != 52 or len(set(names)) != 52:
        raise ValueError('Contrato de campañas: se requieren 52 réplicas únicas')
    for arm, root, seeds, sha, reruns, host in groups:
        rows = []
        for seed in seeds:
            name = f'{arm}-{seed}'
            folder = root / name
            missing = []
            if folder.is_symlink():
                missing.append('directorio de réplica es symlink; no se lee')
                out['faltantes'].append({'replica': name, 'errores': missing})
                rows.append({'replica': name, 'diasEncontrados': 0, 'sha': None,
                             'relaunch': seed in reruns, 'parcialArchivado': False,
                             'identidadDias': [], 'solapeAcreditado': False,
                             'ultimoEstadoGestor': None, 'fallosHistoricosGestor': [],
                             'hashesDia': {}, 'errores': missing, 'estado': 'incompleta'})
                continue
            if not folder.is_dir():
                missing.append('directorio de réplica ausente')
            else:
                expected_files = {'replica.json'} | {f'dia-{day:03}.json' for day in range(1, 61)}
                if {path.name for path in folder.iterdir()} != expected_files:
                    missing.append('inventario de réplica distinto de 60 días + replica.json')
            day_hashes = {}
            meta_path = folder / 'replica.json'
            meta = None
            if meta_path.is_symlink():
                missing.append('replica.json es symlink')
            if meta_path.is_file() and not meta_path.is_symlink():
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
                expected = EXPECTED[arm]
                if meta.get('digest') != expected['digest']:
                    missing.append('digest de código distinto del brazo congelado')
                try:
                    if params_sha256(meta.get('params')) != expected['paramsSha256']:
                        missing.append('parámetros completos distintos del brazo congelado')
                except ValueError as exc:
                    missing.append(str(exc))
                if meta.get('gobernador') != GOVERNOR or 'techoLab' in meta or 'techoLabDetalle' in meta:
                    missing.append('modo de réplica distinto de leyes sin gobernador/techo')
                if meta.get('instrumentos') != expected['instrumentos']:
                    missing.append('instrumentos distintos del brazo congelado')
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
                if path.is_symlink():
                    missing.append(f'dia-{day:03}.json es symlink')
                    continue
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
            p = {'tower': p_tower, 'laptop': p_laptop, 'pub2_tower': p_pub2_tower,
                 'hedge': p_hedge}[host].get(name, {})
            terminal = next((state for state in reversed(p.get('estados', []))
                             if state in ('COMPLETA', 'FALLO')), None)
            if seed in reruns:
                if not (archived / 'dia-003.json').is_file():
                    missing.append('parcial previo no archivado')
                overlap = overlap_by_name.get(name)
                if not overlap or not overlap['solapeAcreditado']:
                    missing.append('solape archivado/relanzado no acreditado')
                if p.get('identidad') != {1, 2, 3}:
                    missing.append('identidad días 1–3 no acreditada en gestor')
                if host in ('hedge', 'pub2_tower', 'laptop') and overlap and p.get('identidadHashes'):
                    overlap_hashes = {row['dia']: row['sha256Relanzado'] for row in overlap['solapes'] if row['dia'] in (1, 2, 3)}
                    if p.get('identidadHashes') != overlap_hashes:
                        missing.append('huellas IDENTIDAD del TSV torre distintas de JSON relanzados')
                if host == 'laptop' and (not laptop_interrupted or 'LANZADA' not in p.get('estados', [])):
                    missing.append('lanzamiento del portátil interrumpido no acreditado')
                elif host == 'hedge' and (p.get('estados', []).count('LANZADA') != 1
                                          or not any(f'sha={SHA_C8}' in info and f'salida={folder}' in info
                                                     and ' nice=19 ' in info and ' TMPDIR=/datos/tmp-atlas-lab ' in info
                                                     for info in p.get('lanzamientos', []))):
                    missing.append('lanzamiento hedge de torre no acreditado en bitácora')
                elif host == 'pub2_tower' and (p.get('estados', []).count('LANZADA_VERIFICADA') != 1
                                                or 'MANIFIESTO_VERIFICADO' not in p.get('estados', [])):
                    missing.append('procedencia/manifiesto PUB2 de torre no acreditado en bitácora')
                elif host == 'tower' and terminal != 'COMPLETA':
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
                         'solapeAcreditado': overlap_by_name.get(name, {}).get('solapeAcreditado') if seed in reruns else None,
                         'ultimoEstadoGestor': terminal, 'fallosHistoricosGestor': p.get('fallos', []),
                         'hashesDia': day_hashes, 'errores': missing,
                         'estado': 'fallo' if terminal == 'FALLO' else 'completa' if not missing else 'incompleta'})
        out['grupos'].setdefault(arm, {'replicas': []})['replicas'].extend(rows)
    for group in out['grupos'].values():
        rows = group['replicas']
        group.update({'requeridas': len(rows), 'completas': sum(not row['errores'] for row in rows),
                      'fallidas': sum(row['estado'] == 'fallo' for row in rows),
                      'estado': 'fallo' if any(row['estado'] == 'fallo' for row in rows)
                                else 'completo' if all(row['estado'] == 'completa' for row in rows)
                                else 'incompleta'})
    out['estado'] = ('fallo' if out['fallos'] or overlaps['resumen']['diferencias'] else
                     'completo' if not out['faltantes'] and tower_finished
                     and out['procedencia']['pub2Torre']['estado'] == 'completo'
                     and out['procedencia'][selected_name]['estado'] == 'completo'
                     and sum(group['requeridas'] for group in out['grupos'].values()) == 52 else 'incompleta')
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--muestra', action='store_true')
    parser.add_argument('--usar-hedge-torre', action='store_true', help='elige explícitamente 14 copias de torre')
    args = parser.parse_args()
    result = audit(args.usar_hedge_torre)
    if args.muestra:
        print(json.dumps({k: v for k, v in result.items() if k != 'grupos'} |
                         {'grupos': {k: {'requeridas': v['requeridas'], 'completas': v['completas'],
                                         'fallidas': v['fallidas'], 'estado': v['estado']}
                                     for k, v in result['grupos'].items()}}, ensure_ascii=False, indent=2))
        return 0 if result['estado'] == 'completo' else 2
    target = BALANCE / ('auditoria-campanas-codex-hedge-torre.json' if args.usar_hedge_torre
                        else 'auditoria-campanas-codex.json')
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(f'{target}: {result["estado"]}; {len(result["faltantes"])} réplicas con errores; '
          f'{len(result["fallos"])} fallos de gestor/procedencia')
    return 0 if result['estado'] == 'completo' else 2


if __name__ == '__main__':
    raise SystemExit(main())
