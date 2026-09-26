#!/usr/bin/env python3
"""Resumen descriptivo, solo lectura, de las series diarias del laboratorio.

Uso: python3 scripts/analysis/diagnostico-economia-hacer.py [--base DIR]
No abre mundos, no inicia réplicas y no escribe en las carpetas de datos.
"""
import argparse
import glob
import json
import math
import os
import re
import statistics as st

BASE = '/datos/tmp-atlas-lab/datos-lab'
CAMPAIGNS = {
    'CTRLV4': 'ctrlv4/CTRLV4-*',
    'CTRL2': 'c8panel/portatil/CTRL2-*',
    'PUB2': 'f21b-portatil/PUB2-*',
    'l60v3': 'l60v3/B-*',
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
        return sum(time['fracciones'].get(a, 0) for a in ACTIONS) if time else None
    if key.startswith('accion:'):
        time = day.get('repartoTiempoPorAccion')
        return time['fracciones'].get(key.split(':', 1)[1], 0) if time else None
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
    meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
    name = os.path.basename(path)
    seed = int(re.search(r'(\d+)$', name).group(1))
    return {'id': name, 'path': path, 'dias': days, 'seed': seed,
            'sha': meta.get('sha'), 'day_first': min(days), 'day_last': max(days),
            'day_count': len(days), 'complete': all(d in days for d in range(1, 61))}


def summarise(runs, key):
    per_run = []
    for r in runs:
        d = r['dias']
        e, m, l = (window(d, w, key) for w in (EARLY, MID, LATE))
        per_run.append({'id': r['id'], 'seed': r['seed'], 'early': e, 'mid': m, 'late': l,
                        'delta_mid_early': m-e if e is not None and m is not None else None,
                        'delta_late_early': l-e if e is not None and l is not None else None})
    summary = {}
    for field in ('early', 'mid', 'late', 'delta_mid_early', 'delta_late_early'):
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
    args = parser.parse_args()
    output = {'metodo': {'ventanas_dias': {'temprana': [5, 14], 'media': [26, 35], 'tardia': [51, 60]},
                         'ventanas_cinco_dias_ctrlv4': [[days.start, days.stop - 1] for _, days in WINDOWS_5_DAYS],
                         'agregacion': 'todos los dias de cada ventana presentes y finitos; mediana diaria por replica, despues mediana entre replicas',
                         'corte': 'parciales archivados del 24-09 tienen prioridad' if args.archived_partials else 'directorios corrientes, incluidas relanzadas en curso',
                         'hacer': 'suma de fracciones persona-tick gather+build+craft+hunt; no es tasa de eventos'}}
    for campaign, pattern in CAMPAIGNS.items():
        paths = sorted(glob.glob(os.path.join(args.base, pattern)))
        if campaign == 'CTRL2':
            paths = [p for p in paths if 2001 <= int(os.path.basename(p).split('-')[-1]) <= 2012]
        if args.archived_partials:
            archived = glob.glob(os.path.join(args.base, os.path.dirname(pattern),
                                               'parciales-20260924', os.path.basename(pattern)))
            by_id = {os.path.basename(p): p for p in paths}
            by_id.update({os.path.basename(p): p for p in archived})
            paths = [by_id[k] for k in sorted(by_id)]
            if campaign == 'CTRL2':
                paths = [p for p in paths if 2001 <= int(os.path.basename(p).split('-')[-1]) <= 2012]
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
        output[campaign] = {
            'fuentes': [{'id': r['id'], 'origen': os.path.relpath(r['path'], args.base),
                         'seed': r['seed'], 'sha': r['sha'], 'primer_dia': r['day_first'],
                         'ultimo_dia': r['day_last'], 'cantidad_dias': r['day_count'],
                         'completa_1_60': r['complete']} for r in runs],
            'auditoria_campos_estado': {key: sum(key in day for r in runs for day in r['dias'].values())
                                      for key in ('tiles', 'people', 'communities', 'technology',
                                                  'blueprints', 'structures', 'animals')},
            'metricas': metrics,
            'correlacion_cambios_temprana_media': {'n': len(pairs), 'pearson': pearson([p[0] for p in pairs], [p[1] for p in pairs])}
        }
        if campaign == 'CTRLV4':
            output[campaign]['ventanas_cinco_dias'] = five_day_panel(runs)
    print(json.dumps(output, indent=2, ensure_ascii=False, allow_nan=False))


if __name__ == '__main__':
    main()
