#!/usr/bin/env python3
"""Resumen descriptivo de CTRLV4 6001..6040; lee datos, emite JSON a stdout.

Uso: python3 -B scripts/analysis/resumen-economia-ctrlv4-40.py [--base DATOS_LAB]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import stat
import statistics
import sys


DEFAULT_BASE = Path('/datos/tmp-atlas-lab/datos-lab')
SHA = '667454d5e0232885d78c37775d6a5619f516872d'
DIGEST = 'd896b52065e33463ecb824137431e896432da83d14be01a1233443325c5f0b74'
PARAMS_SHA256 = '5b1bbb549e7dec5bfd7fdac11dcf8e89b33d2bfea5d80ac0a5865d17871338bb'
GOVERNOR = 'no-ejecutado; replica de leyes, no del servidor'
INSTRUMENTS = ('si; solo lectura (scripts/lab/instrumentos.ts): conducta por tiempo, '
               'comida compartida, natalidad local y panel C8')
WINDOWS = {'temprana': range(5, 15), 'media': range(26, 36), 'tardia': range(51, 61)}
ACTIONS = ('gather', 'build', 'craft', 'hunt')
METRICS = ('hacer', 'diversidadConductaVentana')


def regular(path: Path, directory: bool = False) -> bool:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return False
    return stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode)


def read_object(path: Path) -> dict:
    if not regular(path):
        raise ValueError(f'{path}: falta archivo regular')
    value = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        raise ValueError(f'{path}: JSON debe ser objeto')
    return value


def fraction(value: object) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1


def read_seed(base: Path, seed: int) -> dict:
    campaign = 'ctrlv4' if seed <= 6020 else 'ctrlv4b'
    folder = base / campaign / f'CTRLV4-{seed}'
    if not regular(folder, directory=True):
        raise ValueError(f'{folder}: falta directorio real')
    expected = {'replica.json'} | {f'dia-{day:03d}.json' for day in range(1, 61)}
    actual = {entry.name for entry in folder.iterdir()}
    if actual != expected:
        raise ValueError(f'{folder}: inventario distinto; faltan={sorted(expected-actual)}, sobran={sorted(actual-expected)}')

    manifest = read_object(folder / 'replica.json')
    if (type(manifest.get('seed')) is not int or manifest['seed'] != seed or
            type(manifest.get('dias')) is not int or manifest['dias'] != 60 or
            manifest.get('sha') != SHA or manifest.get('digest') != DIGEST or
            manifest.get('metricasVersion') != 2 or manifest.get('gobernador') != GOVERNOR or
            manifest.get('instrumentos') != INSTRUMENTS or
            'techoLab' in manifest or 'techoLabDetalle' in manifest):
        raise ValueError(f'{folder}: contrato congelado de manifiesto inválido')
    params = manifest.get('params')
    if not isinstance(params, dict):
        raise ValueError(f'{folder}: params ausentes')
    packed = json.dumps(params, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    if hashlib.sha256(packed).hexdigest() != PARAMS_SHA256:
        raise ValueError(f'{folder}: params fuera del control homogéneo V4')

    daily: dict[int, dict[str, float | None]] = {}
    for number in range(1, 61):
        path = folder / f'dia-{number:03d}.json'
        body = read_object(path)
        if type(body.get('tick')) is not int or body['tick'] != number * 2400:
            raise ValueError(f'{path}: tick inválido')
        if 'techoLab' in body or 'reproduccionActivaFraccion' in body:
            raise ValueError(f'{path}: campos diarios de techo incompatibles con control sin techo')
        reparto = body.get('repartoTiempoPorAccion')
        if not isinstance(reparto, dict):
            raise ValueError(f'{path}: repartoTiempoPorAccion inválido')
        count, shares = reparto.get('personaTicks'), reparto.get('fracciones')
        if (type(count) is not int or count < 0 or not isinstance(shares, dict) or
                any(not isinstance(key, str) or not fraction(value) for key, value in shares.items()) or
                (count == 0 and bool(shares)) or
                (count > 0 and (not shares or not math.isclose(sum(shares.values()), 1, rel_tol=0, abs_tol=1e-9)))):
            raise ValueError(f'{path}: personaTicks/fracciones inválidos')
        if 'diversidadConductaVentana' not in body:
            raise ValueError(f'{path}: diversidadConductaVentana ausente')
        diversity = body['diversidadConductaVentana']
        if diversity is not None and not fraction(diversity):
            raise ValueError(f'{path}: diversidadConductaVentana inválida')
        daily[number] = {
            'hacer': sum(shares.get(action, 0) for action in ACTIONS) if count > 0 else None,
            'diversidadConductaVentana': diversity,
        }

    windows: dict[str, dict[str, float | None]] = {}
    for name, numbers in WINDOWS.items():
        windows[name] = {}
        for metric in METRICS:
            values = [daily[number][metric] for number in numbers]
            windows[name][metric] = statistics.median(values) if all(value is not None for value in values) else None
    return {'seed': seed, 'grupo': 'original20' if seed <= 6020 else 'nuevas20',
            'origen': f'{campaign}/CTRLV4-{seed}',
            'sha256Manifiesto': hashlib.sha256((folder / 'replica.json').read_bytes()).hexdigest(),
            'ventanas': windows}


def pearson(pairs: list[tuple[float, float]]) -> float | None:
    if len(pairs) < 3:
        return None
    xs, ys = zip(*pairs)
    mx, my = statistics.mean(xs), statistics.mean(ys)
    numerator = sum((x-mx) * (y-my) for x, y in pairs)
    denominator = math.sqrt(sum((x-mx)**2 for x in xs) * sum((y-my)**2 for y in ys))
    return numerator / denominator if denominator else None


def summary(rows: list[dict]) -> dict:
    windows = {}
    for name in WINDOWS:
        windows[name] = {}
        for metric in METRICS:
            values = [row['ventanas'][name][metric] for row in rows]
            valid = [value for value in values if value is not None]
            windows[name][metric] = {'mediana': statistics.median(valid) if valid else None, 'n': len(valid)}
    changes = {}
    for name, first, last in (('temprana_media', 'temprana', 'media'),
                              ('media_tardia', 'media', 'tardia')):
        pairs = []
        for row in rows:
            a = row['ventanas'][first]
            b = row['ventanas'][last]
            if all(a[metric] is not None and b[metric] is not None for metric in METRICS):
                pairs.append((b['hacer']-a['hacer'],
                              b['diversidadConductaVentana']-a['diversidadConductaVentana']))
        changes[name] = {'pearson': pearson(pairs), 'n': len(pairs)}
    return {'semillas': len(rows), 'ventanas': windows, 'correlacion_cambios': changes}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, default=DEFAULT_BASE,
                        help='directorio datos-lab que contiene ctrlv4/ y ctrlv4b/')
    args = parser.parse_args()
    for campaign, seeds in (('ctrlv4', range(6001, 6021)), ('ctrlv4b', range(6021, 6041))):
        folder = args.base / campaign
        if not regular(folder, directory=True):
            raise ValueError(f'{folder}: falta directorio real')
        expected = {f'CTRLV4-{seed}' for seed in seeds}
        actual = {entry.name for entry in folder.iterdir()
                  if entry.name.startswith('CTRLV4-') and regular(entry, directory=True)}
        if actual != expected:
            raise ValueError(f'{folder}: semillas distintas; faltan={sorted(expected-actual)}, sobran={sorted(actual-expected)}')
    rows = [read_seed(args.base, seed) for seed in range(6001, 6041)]
    result = {
        'metodo': {
            'fuentes': {'original20': 'ctrlv4/CTRLV4-6001..6020',
                        'nuevas20': 'ctrlv4b/CTRLV4-6021..6040'},
            'ventanas_dias': {key: [numbers.start, numbers.stop-1] for key, numbers in WINDOWS.items()},
            'hacer': 'suma de fracciones persona-tick gather+build+craft+hunt cuando personaTicks>0',
            'semilla': 'mediana de los diez días; un null diario excluye toda esa ventana para esa métrica',
            'grupo': 'mediana de las medianas válidas por semilla; n cuenta semillas válidas por métrica y ventana',
            'correlacion': 'Pearson entre cambios pareados de hacer y diversidadConductaVentana por semilla; n cuenta pares completos',
            'validacion': 'manifiestos seed/dias/SHA/digest/params/modo/instrumentos y huella SHA-256 por fila, 60 JSON diarios y tick=día*2400',
            'limitaciones': 'asociación descriptiva; no demuestra causalidad ni tasa de eventos; null no imputados; este script no acredita por sí solo logs, TSV o testigos de procedencia',
        },
        'resumenes': {
            'original20': summary(rows[:20]),
            'nuevas20': summary(rows[20:]),
            'juntas40': summary(rows),
        },
        'por_semilla': rows,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
