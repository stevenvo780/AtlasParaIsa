#!/usr/bin/env python3
"""Resumen descriptivo, solo lectura, de las series diarias del laboratorio.

Uso: python3 scripts/analysis/diagnostico-economia-hacer.py [--base DIR]
No abre mundos, no inicia réplicas y no escribe en las carpetas de datos.
"""
import argparse
from datetime import datetime
import glob
import hashlib
import json
import math
import os
from pathlib import Path
import re
import statistics as st

BASE = '/datos/tmp-atlas-lab/datos-lab'
BALANCE = '/datos/tmp-atlas-lab/balance'
HEDGE_DIR = 'hedge-torre-20260926'
CTRL2_HEDGE_SEEDS = (2002, 2004, 2006, 2007, 2008, 2009, 2010, 2011, 2012)
PUB2_HEDGE_SEEDS = (5, 29, 101, 202, 404)
CAMPAIGNS = {
    'CTRLV4': 'ctrlv4/CTRLV4-*',
    'CTRL2': 'c8panel/portatil/CTRL2-*',
    'l60v3': 'l60v3/B-*',
}
PUB2_SOURCES = {
    'portatil': ('f21b-portatil', (5, 29, 101, 202, 404, 505)),
    'torre': ('f21b-torre', (606, 707)),
}
# PUB2-505 ya estaba completa en el corte del 24-09; las otras siete
# tienen parcial archivado obligatorio para reconstruir ese corte.
PUB2_ARCHIVED_SEEDS = (5, 29, 101, 202, 404, 606, 707)
FINAL_CONTRACTS = {
    'CTRLV4': {'prefix': 'CTRLV4', 'seeds': tuple(range(6001, 6021)),
               'sha': '667454d5e0232885d78c37775d6a5619f516872d',
               'digest': 'd896b52065e33463ecb824137431e896432da83d14be01a1233443325c5f0b74',
               'paramsSha256': '5b1bbb549e7dec5bfd7fdac11dcf8e89b33d2bfea5d80ac0a5865d17871338bb'},
    'CTRL2': {'prefix': 'CTRL2', 'seeds': tuple(range(2001, 2013)),
              'sha': 'd2ebf11d51c3221477d88c7045faeafa2a229683',
              'digest': '63d4fc53b1a4c92e9c10bebed763958183ac22f246d8af744ba6a6ebfc840f0a',
              'paramsSha256': '3d7a05d5d1d2ee6ee0ee6feaeb18bbc8a2599db1b64c7365a6569bfec7e43b36'},
    'PUB2': {'prefix': 'PUB2', 'seeds': (5, 29, 101, 202, 404, 505, 606, 707),
             'sha': 'd2ebf11d51c3221477d88c7045faeafa2a229683',
             'digest': '63d4fc53b1a4c92e9c10bebed763958183ac22f246d8af744ba6a6ebfc840f0a',
             'paramsSha256': '3d7a05d5d1d2ee6ee0ee6feaeb18bbc8a2599db1b64c7365a6569bfec7e43b36'},
    'l60v3': {'prefix': 'B', 'seeds': (5, 13, 17, 23, 29, 101, 202, 303, 404, 505, 606, 707),
              'sha': '1710b350a1801910718afb8214cfe787cd5e0a8e',
              'digest': '9fc876125e804b9d601f546b2423d142ddd112fa089efe3e36226580f6d39d16',
              'paramsSha256': 'e8eff161e688c7fe8c2a26ec948fc83a6de10939b23a3ddde1509b78e851cbd8'},
}
EARLY = range(5, 15)
MID = range(26, 36)
LATE = range(51, 61)
ACTIONS = ('gather', 'build', 'craft', 'hunt')
WINDOWS_5_DAYS = tuple((f'd{first:02d}_{first + 4:02d}', range(first, first + 5))
                       for first in (5, 10, 15, 20, 25, 30, 35))
WINDOW_KEYS = ('hacer', 'accion:approach', 'diversidadConductaVentana', 'maderaMediaAdultos')


def median(values):
    return st.median(values) if values else None


def pearson(xs, ys):
    if len(xs) < 3:
        return None
    mx, my = st.mean(xs), st.mean(ys)
    den = math.sqrt(sum((x-mx)**2 for x in xs) * sum((y-my)**2 for y in ys))
    return sum((x-mx)*(y-my) for x, y in zip(xs, ys)) / den if den else None


def scalar(day, key):
    if key == 'hacer':
        time = day.get('repartoTiempoPorAccion')
        return sum(time['fracciones'].get(a, 0) for a in ACTIONS) if time and time.get('personaTicks', 0) > 0 else None
    if key.startswith('accion:'):
        time = day.get('repartoTiempoPorAccion')
        return time['fracciones'].get(key.split(':', 1)[1], 0) if time and time.get('personaTicks', 0) > 0 else None
    if key.startswith('actividad:'):
        activity = day.get('repartoActividadPorAccion')
        return activity['fracciones'].get(key.split(':', 1)[1], 0) if activity else None
    if key.startswith('natalidad:'):
        return day.get('natalidadLocal', {}).get(key.split(':', 1)[1])
    return day.get(key)


def window(days, interval, key):
    if not all(d in days for d in interval):
        return None
    vals = [scalar(days[d], key) for d in interval if d in days]
    if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in vals):
        return None
    return median(vals)


def load_run(path):
    days = {}
    for filename in glob.glob(os.path.join(path, 'dia-*.json')):
        day = int(os.path.basename(filename)[4:7])
        with open(filename) as file:
            days[day] = json.load(file)
    if not days:
        return None
    meta_path = os.path.join(path, 'replica.json')
    if os.path.exists(meta_path):
        with open(meta_path, 'rb') as stream:
            meta_bytes = stream.read()
        meta = json.loads(meta_bytes)
        replica_sha256 = hashlib.sha256(meta_bytes).hexdigest()
    else:
        meta = {}
        replica_sha256 = None
    name = os.path.basename(path)
    seed = int(re.search(r'(\d+)$', name).group(1))
    return {'id': name, 'path': path, 'dias': days, 'seed': seed,
            'sha': meta.get('sha'), 'replica_sha256': replica_sha256,
            'day_first': min(days), 'day_last': max(days),
            'day_count': len(days), 'complete': all(d in days for d in range(1, 61))}


def require_complete_campaign(campaign, paths):
    """Evita que una lectura exploratoria de parciales parezca un balance final."""
    contract = FINAL_CONTRACTS[campaign]
    expected = {f"{contract['prefix']}-{seed}" for seed in contract['seeds']}
    actual = {os.path.basename(path) for path in paths}
    if len(paths) != len(expected) or actual != expected:
        raise ValueError(f'{campaign}: inventario final distinto; faltan={sorted(expected-actual)}, extra={sorted(actual-expected)}')
    for path in paths:
        name = os.path.basename(path)
        seed = int(name.split('-')[-1])
        if os.path.islink(path) or not os.path.isdir(path):
            raise ValueError(f'{path}: directorio ausente o symlink')
        expected_files = {'replica.json'} | {f'dia-{day:03}.json' for day in range(1, 61)}
        actual_files = set(os.listdir(path))
        if actual_files != expected_files:
            raise ValueError(f'{path}: inventario de archivos distinto; faltan={sorted(expected_files-actual_files)}, extra={sorted(actual_files-expected_files)}')
        for filename in sorted(expected_files):
            file_path = os.path.join(path, filename)
            if os.path.islink(file_path) or not os.path.isfile(file_path):
                raise ValueError(f'{file_path}: no es archivo regular')
        with open(os.path.join(path, 'replica.json')) as stream:
            meta = json.load(stream)
        if not isinstance(meta, dict) or (meta.get('seed'), meta.get('dias'), meta.get('sha'), meta.get('digest')) != (
                seed, 60, contract['sha'], contract['digest']):
            raise ValueError(f'{path}: manifiesto de seed/días/SHA/digest incorrecto')
        params = meta.get('params')
        if not isinstance(params, dict):
            raise ValueError(f'{path}: params no es objeto')
        packed = json.dumps(params, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
        if hashlib.sha256(packed).hexdigest() != contract['paramsSha256']:
            raise ValueError(f'{path}: parámetros distintos del brazo congelado')
        if campaign == 'l60v3':
            if meta.get('techoLab') != 100:
                raise ValueError(f'{path}: techo de laboratorio distinto de 100')
        elif meta.get('gobernador') != 'no-ejecutado; replica de leyes, no del servidor' or 'techoLab' in meta:
            raise ValueError(f'{path}: modo de réplica no corresponde a leyes sin techo')
        for day in range(1, 61):
            with open(os.path.join(path, f'dia-{day:03}.json')) as stream:
                body = json.load(stream)
            if not isinstance(body, dict) or type(body.get('tick')) is not int or body['tick'] != day * 2400:
                raise ValueError(f'{path}: tick inválido en día {day}')
            reparto = body.get('repartoTiempoPorAccion')
            fracciones = reparto.get('fracciones') if isinstance(reparto, dict) else None
            persona_ticks = reparto.get('personaTicks') if isinstance(reparto, dict) else None
            if (not isinstance(fracciones, dict) or type(persona_ticks) is not int or persona_ticks < 0
                    or any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 or v > 1
                           for v in fracciones.values())
                    or any(not isinstance(k, str) for k in fracciones)
                    or (persona_ticks > 0 and (not fracciones or
                        not math.isclose(sum(fracciones.values()), 1, rel_tol=0, abs_tol=1e-9)))
                    or (persona_ticks == 0 and bool(fracciones))):
                raise ValueError(f'{path}: repartoTiempoPorAccion inválido en día {day}')
            if 'diversidadConductaVentana' not in body or (body['diversidadConductaVentana'] is not None
                    and (type(body['diversidadConductaVentana']) not in (int, float)
                         or not math.isfinite(body['diversidadConductaVentana']))):
                raise ValueError(f'{path}: diversidad de ventana ausente o inválida en día {day}')


def pub2_paths(base, archived_partials, require_complete, use_hedge=False):
    """Reúne PUB2 por host fijo sin permitir dobles de una misma semilla."""
    if archived_partials and use_hedge:
        raise ValueError('el corte histórico no admite fuentes hedge vivas')
    paths = []
    for host, (directory, seeds) in PUB2_SOURCES.items():
        root = os.path.join(base, directory)
        observed = {os.path.basename(path): path for path in glob.glob(os.path.join(root, 'PUB2-*'))
                    if os.path.isdir(path)}
        expected = {f'PUB2-{seed}' for seed in seeds}
        if extra := set(observed) - expected:
            raise ValueError(f'PUB2 {host}: directorios fuera del reparto: {sorted(extra)}')
        required_original = {'PUB2-505'} if use_hedge and host == 'portatil' else expected
        if require_complete and (missing := required_original - set(observed)):
            raise ValueError(f'PUB2 {host}: faltan corridas: {sorted(missing)}')
        if archived_partials:
            archived = {os.path.basename(path): path for path in
                        glob.glob(os.path.join(root, 'parciales-20260924', 'PUB2-*'))
                        if os.path.isdir(path)}
            required_archives = {f'PUB2-{seed}' for seed in seeds if seed in PUB2_ARCHIVED_SEEDS}
            if missing_archives := required_archives - set(archived):
                raise ValueError(f'PUB2 {host}: faltan parciales históricos requeridos: {sorted(missing_archives)}')
            observed.update({name: path for name, path in archived.items() if name in expected})
            if missing_historical := expected - set(observed):
                raise ValueError(f'PUB2 {host}: faltan corridas en corte histórico: {sorted(missing_historical)}')
        if use_hedge and host == 'portatil':
            hedge_root = os.path.join(base, HEDGE_DIR)
            hedge = {os.path.basename(path): path for path in
                     glob.glob(os.path.join(hedge_root, 'PUB2-*')) if os.path.isdir(path)}
            expected_hedge = {f'PUB2-{seed}' for seed in PUB2_HEDGE_SEEDS}
            if extra_hedge := set(hedge) - expected_hedge:
                raise ValueError(f'PUB2 hedge: directorios ajenos: {sorted(extra_hedge)}')
            if require_complete and (missing_hedge := expected_hedge - set(hedge)):
                raise ValueError(f'PUB2 hedge: faltan corridas: {sorted(missing_hedge)}')
            observed.update(hedge)
        paths.extend(observed.values())
    return sorted(paths)


def ctrl2_hedge_paths(base, require_complete):
    """Selecciona las nueve copias como bloque y los tres controles originales."""
    original_root = os.path.join(base, 'c8panel', 'portatil')
    hedge_root = os.path.join(base, HEDGE_DIR)
    originals = {os.path.basename(path): path for path in
                 glob.glob(os.path.join(original_root, 'CTRL2-*')) if os.path.isdir(path)}
    hedge = {os.path.basename(path): path for path in
             glob.glob(os.path.join(hedge_root, 'CTRL2-*')) if os.path.isdir(path)}
    expected_hedge = {f'CTRL2-{seed}' for seed in CTRL2_HEDGE_SEEDS}
    if extra := set(hedge) - expected_hedge:
        raise ValueError(f'CTRL2 hedge: directorios ajenos: {sorted(extra)}')
    if require_complete and (missing := expected_hedge - set(hedge)):
        raise ValueError(f'CTRL2 hedge: faltan corridas: {sorted(missing)}')
    selected = {name: path for name, path in originals.items()
                if name in {'CTRL2-2001', 'CTRL2-2003', 'CTRL2-2005'}}
    selected.update(hedge)
    if require_complete and (missing := {f'CTRL2-{seed}' for seed in range(2001, 2013)} - set(selected)):
        raise ValueError(f'CTRL2 hedge: faltan controles seleccionados: {sorted(missing)}')
    return sorted(selected.values())


def verify_selected_provenance(base, use_hedge):
    """Exige cotejo completo de identidad y solapes para el balance final."""
    from hedge_provenance import verify_hedge, verify_laptop, verify_pub2_tower

    checks = {'pub2Torre': verify_pub2_tower(Path(base), require_complete=True)}
    if use_hedge:
        checks['hedgeTorre'] = verify_hedge(Path(base), require_complete=True)
    else:
        checks['portatil'] = verify_laptop(Path(base), Path(BALANCE), require_complete=True)
    for name, check in checks.items():
        if check.get('estado') != 'completo':
            raise ValueError(f'{name}: cotejo de identidad y solapes incompleto: {check.get("estado")}')
    return checks


def summarise(runs, key):
    per_run = []
    for r in runs:
        d = r['dias']
        e, m, l = (window(d, w, key) for w in (EARLY, MID, LATE))
        per_run.append({'id': r['id'], 'seed': r['seed'], 'early': e, 'mid': m, 'late': l,
                        'delta_mid_early': m-e if e is not None and m is not None else None,
                        'delta_late_mid': l-m if l is not None and m is not None else None,
                        'delta_late_early': l-e if e is not None and l is not None else None})
    summary = {}
    for field in ('early', 'mid', 'late', 'delta_mid_early', 'delta_late_mid', 'delta_late_early'):
        vals = [row[field] for row in per_run if row[field] is not None]
        summary[field] = {'n': len(vals), 'median': median(vals)}
    return {'resumen': summary, 'semillas': per_run}


def five_day_panel(runs):
    result = {}
    for label, days in WINDOWS_5_DAYS:
        metrics = {}
        for key in WINDOW_KEYS:
            per_seed = [{'seed': run['seed'], 'mediana': window(run['dias'], days, key)} for run in runs]
            values = [entry['mediana'] for entry in per_seed if entry['mediana'] is not None]
            metrics[key] = {'n': len(values), 'mediana': median(values), 'semillas': per_seed}
        result[label] = {'dias': [days.start, days.stop - 1], 'metricas': metrics}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default=BASE)
    parser.add_argument('--archived-partials', action='store_true',
                        help='Usar parciales-20260924 cuando existan; congela el corte anterior a las relanzadas')
    parser.add_argument('--require-complete', action='store_true',
                        help='Exige inventario, 60 días, ticks y manifiesto congelado en las cuatro campañas')
    parser.add_argument('--fecha-corte',
                        help='Fecha y hora ISO 8601 del corte final con desplazamiento UTC numérico no nulo (AAAA-MM-DDTHH:MM:SS±HH:MM)')
    parser.add_argument('--usar-hedge-torre', action='store_true',
                        help='Usar juntas 9 CTRL2 y 5 PUB2 duplicadas en la torre para el corte corriente')
    args = parser.parse_args()
    if args.require_complete and args.fecha_corte is None:
        parser.error('--require-complete exige --fecha-corte')
    if args.fecha_corte is not None:
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}', args.fecha_corte):
            parser.error('--fecha-corte debe incluir un desplazamiento UTC numérico (AAAA-MM-DDTHH:MM:SS±HH:MM)')
        try:
            fecha_corte = datetime.fromisoformat(args.fecha_corte)
        except ValueError:
            parser.error('--fecha-corte no es una fecha y hora válida')
        if fecha_corte.utcoffset() is None or fecha_corte.utcoffset().total_seconds() == 0:
            parser.error('--fecha-corte exige un desplazamiento UTC numérico no nulo')
    if args.require_complete and args.archived_partials:
        parser.error('--require-complete no admite --archived-partials')
    if args.usar_hedge_torre and args.archived_partials:
        parser.error('--usar-hedge-torre no admite --archived-partials')
    output = {'metodo': {'ventanas_dias': {'temprana': [5, 14], 'media': [26, 35], 'tardia': [51, 60]},
                         'ventanas_cinco_dias_ctrlv4': [[days.start, days.stop - 1] for _, days in WINDOWS_5_DAYS],
                         'agregacion': 'todos los dias de cada ventana presentes y finitos; mediana diaria por replica, despues mediana entre replicas',
                         'corte': ('cuatro campañas completas verificadas a día 60' if args.require_complete else
                                   'parciales archivados del 24-09 tienen prioridad' if args.archived_partials else
                                   'directorios corrientes, incluidas relanzadas en curso'),
                         'seleccion_hedge_torre': args.usar_hedge_torre,
                         'hacer': 'suma de fracciones persona-tick gather+build+craft+hunt; no es tasa de eventos'}}
    if args.fecha_corte is not None:
        output['metodo']['fecha_corte'] = args.fecha_corte
    for campaign, pattern in {**CAMPAIGNS, 'PUB2': None}.items():
        paths = (pub2_paths(args.base, args.archived_partials, args.require_complete,
                            args.usar_hedge_torre)
                 if campaign == 'PUB2' else
                 ctrl2_hedge_paths(args.base, args.require_complete)
                 if campaign == 'CTRL2' and args.usar_hedge_torre else
                 sorted(path for path in glob.glob(os.path.join(args.base, pattern)) if os.path.isdir(path)))
        if campaign == 'CTRL2':
            if args.require_complete and not args.usar_hedge_torre:
                expected_all = {f'CTRL2-{seed}' for seed in range(2001, 2017)}
                observed_all = {os.path.basename(path) for path in paths}
                if observed_all != expected_all:
                    raise ValueError(f'CTRL2: inventario bruto 2001..2016 distinto; faltan={sorted(expected_all-observed_all)}, extra={sorted(observed_all-expected_all)}')
            paths = [p for p in paths if 2001 <= int(os.path.basename(p).split('-')[-1]) <= 2012]
        if args.archived_partials and campaign != 'PUB2':
            archived = [path for path in glob.glob(os.path.join(args.base, os.path.dirname(pattern),
                                                                'parciales-20260924', os.path.basename(pattern)))
                        if os.path.isdir(path)]
            by_id = {os.path.basename(p): p for p in paths}
            by_id.update({os.path.basename(p): p for p in archived})
            paths = [by_id[k] for k in sorted(by_id)]
            if campaign == 'CTRL2':
                paths = [p for p in paths if 2001 <= int(os.path.basename(p).split('-')[-1]) <= 2012]
        if args.require_complete:
            require_complete_campaign(campaign, paths)
        runs = [r for p in paths if (r := load_run(p))]
        keys = ['hacer', 'diversidadConductaVentana', 'fraccionComida', 'gini', 'faunaTotal', 'maderaMediaAdultos',
                'piedraMediaAdultos', 'poblacion', 'nacimientos', 'recetasDistintasEnUso',
                'recetasDistintasFabricadas', 'usosUtiles', 'beneficioUso', 'distanciaAgua',
                'accion:approach', 'accion:research', 'accion:gather', 'accion:build',
                'accion:craft', 'accion:hunt', 'actividad:gather', 'actividad:build',
                'actividad:craft', 'actividad:hunt', 'natalidad:nacimientosDia']
        metrics = {key: summarise(runs, key) for key in keys}
        pairs = [(a['delta_mid_early'], b['delta_mid_early']) for a, b in
                 zip(metrics['hacer']['semillas'], metrics['diversidadConductaVentana']['semillas'])
                 if a['delta_mid_early'] is not None and b['delta_mid_early'] is not None]
        late_pairs = [(a['delta_late_mid'], b['delta_late_mid']) for a, b in
                      zip(metrics['hacer']['semillas'], metrics['diversidadConductaVentana']['semillas'])
                      if a['delta_late_mid'] is not None and b['delta_late_mid'] is not None]
        material_pairs = {}
        for material in ('maderaMediaAdultos', 'piedraMediaAdultos'):
            material_pairs[material] = {}
            for phase in ('delta_mid_early', 'delta_late_mid'):
                rows = [(a[phase], b[phase]) for a, b in
                        zip(metrics[material]['semillas'], metrics['diversidadConductaVentana']['semillas'])
                        if a[phase] is not None and b[phase] is not None]
                material_pairs[material][phase] = {
                    'n': len(rows),
                    'pearson': pearson([p[0] for p in rows], [p[1] for p in rows]),
                }
        output[campaign] = {
            'fuentes': [{'id': r['id'], 'origen': os.path.relpath(r['path'], args.base),
                         'host': ('torre' if HEDGE_DIR in r['path'] or 'f21b-torre' in r['path'] else 'portatil')
                         if campaign in ('PUB2', 'CTRL2') else None,
                         'seed': r['seed'], 'sha': r['sha'],
                         'replica_sha256': r['replica_sha256'], 'primer_dia': r['day_first'],
                         'ultimo_dia': r['day_last'], 'cantidad_dias': r['day_count'],
                         'completa_1_60': r['complete']} for r in runs],
            'auditoria_campos_estado': {key: sum(key in day for r in runs for day in r['dias'].values())
                                      for key in ('tiles', 'people', 'communities', 'technology',
                                                  'blueprints', 'structures', 'animals')},
            'metricas': metrics,
            'correlacion_cambios_temprana_media': {'n': len(pairs), 'pearson': pearson([p[0] for p in pairs], [p[1] for p in pairs])}
        }
        output[campaign]['correlacion_cambios_media_tardia'] = {
            'n': len(late_pairs), 'pearson': pearson([p[0] for p in late_pairs], [p[1] for p in late_pairs])}
        output[campaign]['correlacion_material_adulto_diversidad'] = material_pairs
        if campaign == 'CTRLV4':
            output[campaign]['ventanas_cinco_dias'] = five_day_panel(runs)
    if args.require_complete:
        output['metodo']['verificacion_procedencia'] = verify_selected_provenance(
            args.base, args.usar_hedge_torre)
    print(json.dumps(output, indent=2, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main()
