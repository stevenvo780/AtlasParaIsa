#!/usr/bin/env python3
"""Auditoría estructural y de procedencia de CTRLV4b; solo lectura.

No prueba identidad de contenido de los días nuevos sin huella independiente.
La salida JSON distingue un corte parcial de un panel completo estructuralmente íntegro.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import stat
import sys


DEFAULT_ROOT = Path('/datos/tmp-atlas-lab/datos-lab/ctrlv4b')
SHA = '667454d5e0232885d78c37775d6a5619f516872d'
REFERENCE_SHA256 = '611c5a313431448f57fbed984f2534e0a62327cbed200fac26aaeaab287d5446'
REFERENCE_DAY_SHA256 = '875ac907e4e1f377fb146291ba7de8d923efc030afd6be43601b3bbf3eee1764'
CODE_DIGEST = 'd896b52065e33463ecb824137431e896432da83d14be01a1233443325c5f0b74'
PARAMS_TEXT = ('persistencia.cadaTicks=300,limites.teselasActivas=1303552,'
               'limites.chunks=5092,limites.fauna=7821312')
BRAZO_TEXT = (f'CTRLV4|{PARAMS_TEXT}|{SHA}|reglas 11 por defecto, sin leyes; '
              'control para calibrar la lectura v4 de C8')
SEEDS = range(6021, 6041)
DAY_RE = re.compile(r'dia-(\d{3})\.json\Z')
DEATH_CAUSES = {'starvation', 'dehydration', 'exposure', 'senescence'}
SUMMARY_FIELDS = {
    'poblacion': 'poblacionFinal', 'nacimientos': 'nacimientosTotal',
    'muertesPorCausa': 'muertesPorCausaTotal',
    'fundadoresVivos': 'fundadoresVivosFinal',
    'generacionesVivas': 'generacionesVivasFinal',
    'diversidadOficios': 'diversidadOficiosFinal',
    'recetasDistintasEnUso': 'recetasDistintasEnUsoFinal',
    'cooperaciones': 'cooperacionesTotal', 'gini': 'gini',
    'fraccionComida': 'fraccionComida', 'distanciaAgua': 'distanciaAgua',
    'regionesSinAgua': 'regionesSinAgua',
}


def real_file(path: Path) -> bool:
    try:
        return stat.S_ISREG(path.lstat().st_mode)
    except FileNotFoundError:
        return False


def real_dir(path: Path) -> bool:
    try:
        return stat.S_ISDIR(path.lstat().st_mode)
    except FileNotFoundError:
        return False


def read_json(path: Path) -> dict:
    if not real_file(path):
        raise ValueError(f'{path}: archivo regular ausente')
    value = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        raise ValueError(f'{path}: JSON no es objeto')
    return value


def pinned_json(path: Path, expected_sha256: str) -> dict:
    if not real_file(path):
        raise ValueError(f'{path}: referencia regular ausente')
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError(f'{path}: SHA256 de referencia congelada distinto')
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError(f'{path}: referencia no es objeto')
    return value


def canonical(value):
    # Contrato de launch-codex-campaigns.py: solo métricas de tiempo/RSS.
    if isinstance(value, dict):
        return {key: canonical(item) for key, item in value.items()
                if key not in {'p50Ms', 'p95Ms', 'rss'} and not key.endswith('Ms')}
    if isinstance(value, list):
        return [canonical(item) for item in value]
    return value


def fingerprint(day: dict) -> str:
    packed = json.dumps(canonical(day), sort_keys=True,
                        separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(packed).hexdigest()


def inventory(folder: Path, errors: list[str]) -> dict[int, Path]:
    if not real_dir(folder):
        errors.append(f'{folder}: directorio canónico ausente o symlink')
        return {}
    days = {}
    for path in folder.iterdir():
        if not path.name.startswith('dia-'):
            continue
        match = DAY_RE.fullmatch(path.name)
        if not match or not real_file(path):
            errors.append(f'{path}: nombre o tipo de día inválido')
            continue
        number = int(match.group(1))
        if not 1 <= number <= 60 or number in days:
            errors.append(f'{path}: día fuera de panel o duplicado')
        else:
            days[number] = path
    if days and sorted(days) != list(range(1, max(days) + 1)):
        errors.append(f'{folder}: secuencia de días con huecos')
    return days


def check_day(day: dict, number: int, seed: int, schema: set[str],
              errors: list[str]) -> None:
    name = f'CTRLV4-{seed}/dia-{number:03d}'
    def bounded(value, low=0, high=1):
        return type(value) in (int, float) and math.isfinite(value) and low <= value <= high
    missing = schema - day.keys()
    extra = day.keys() - schema
    if missing or extra:
        errors.append(f'{name}: esquema distinto (faltan {sorted(missing)}, sobran {sorted(extra)})')
    if type(day.get('tick')) is not int or day['tick'] != number * 2400:
        errors.append(f'{name}: tick inválido')
    for key in ('poblacion', 'nacimientos', 'cooperaciones', 'vecinosMortales',
                'personasVentana', 'conflictosAcumulados'):
        value = day.get(key)
        if type(value) is not int or value < 0:
            errors.append(f'{name}: {key} inválido')
    deaths = day.get('muertesPorCausa')
    if not isinstance(deaths, dict) or set(deaths) != DEATH_CAUSES or any(
        type(value) is not int or value < 0 for value in deaths.values()
    ):
        errors.append(f'{name}: causas de muerte incompletas o inválidas')
    for key in ('diversidadConductaTiempo', 'diversidadConductaActiva',
                'diversidadConducta', 'gini', 'fraccionComida',
                'regionesSinAgua'):
        value = day.get(key)
        if not bounded(value):
            errors.append(f'{name}: {key} inválido')
    distancia_agua = day.get('distanciaAgua')
    if not (bounded(distancia_agua, 0, math.inf) or bounded(distancia_agua, -1, -1)):
        errors.append(f'{name}: distanciaAgua inválida')
    for key in ('diversidadConductaVentana', 'diversidadConductaVentanaGen1'):
        value = day.get(key)
        if value is not None and not bounded(value):
            errors.append(f'{name}: {key} inválido')
    for key in ('diversidadConductaTiempoComponentes',
                'diversidadConductaActivaComponentes',
                'diversidadConductaComponentes'):
        value = day.get(key)
        if not isinstance(value, dict) or set(value) != {'conducta', 'oficios'} or any(
            not bounded(v) for v in value.values()
        ):
            errors.append(f'{name}: {key} inválido')
    window = day.get('diversidadConductaVentanaComponentes')
    if (window is None) != (day.get('diversidadConductaVentana') is None) or (
        window is not None and (not isinstance(window, dict) or
                                set(window) != {'conducta', 'oficios'} or
                                any(not bounded(v) for v in window.values()))
    ):
        errors.append(f'{name}: componentes de ventana inválidos')
    activity_window = day.get('ventanaActividad')
    if (not isinstance(activity_window, dict) or
        set(activity_window) != {'desdeTickExclusivo', 'hastaTickInclusivo'} or
        activity_window.get('desdeTickExclusivo') != (number - 1) * 2400 or
        activity_window.get('hastaTickInclusivo') != number * 2400):
        errors.append(f'{name}: ventanaActividad inválida')
    for key in ('repartoTiempoPorAccion', 'repartoActividadPorAccion'):
        value = day.get(key)
        count_key = 'personaTicks' if key == 'repartoTiempoPorAccion' else 'incrementos'
        if (not isinstance(value, dict) or set(value) != {count_key, 'fracciones'} or
            type(value.get(count_key)) is not int or value[count_key] < 0 or
            not isinstance(value.get('fracciones'), dict)):
            errors.append(f'{name}: {key} inválido')
            continue
        fractions = value['fracciones']
        if (bool(fractions) != (value[count_key] > 0) or
            any(not isinstance(action, str) or not bounded(share)
                for action, share in fractions.items()) or
            (fractions and not math.isclose(sum(fractions.values()), 1, abs_tol=1e-9))):
            errors.append(f'{name}: fracciones de {key} inválidas')


def check_reference(root: Path, errors: list[str]) -> tuple[dict, set[str]]:
    source = root.parent / 'ctrlv4/CTRLV4-6001'
    reference = pinned_json(source / 'replica.json', REFERENCE_SHA256)
    reference_day = pinned_json(source / 'dia-001.json', REFERENCE_DAY_SHA256)
    brazo = root / 'brazo.txt'
    if not real_file(brazo):
        raise ValueError(f'{brazo}: brazo ausente o symlink')
    if brazo.read_text(encoding='utf-8').strip() != BRAZO_TEXT:
        errors.append('brazo.txt incompatible con CTRLV4b esperado')
    if (reference.get('seed'), reference.get('sha'), reference.get('dias')) != (6001, SHA, 60):
        errors.append('CTRLV4-6001: identidad de referencia inválida')
    params = reference.get('params')
    if not isinstance(params, dict):
        errors.append('CTRLV4-6001: params ausentes')
        return reference, set(reference_day)
    for group, key, value in [('persistencia', 'cadaTicks', 300),
                              ('limites', 'teselasActivas', 1303552),
                              ('limites', 'chunks', 5092), ('limites', 'fauna', 7821312),
                              ('poblacion', 'natalidadLocal', 0),
                              ('conducta', 'vocacion', 0), ('social', 'hogarTrabajo', 0)]:
        if params.get(group, {}).get(key) != value:
            errors.append(f'CTRLV4-6001: params.{group}.{key} inválido')
    if reference.get('digest') != CODE_DIGEST:
        errors.append('CTRLV4-6001: digest inválido')
    return reference, set(reference_day)


def check_manifest(manifest: dict, seed: int, reference: dict, last: dict,
                   errors: list[str]) -> None:
    name = f'CTRLV4-{seed}'
    for key, expected in [('seed', seed), ('dias', 60), ('sha', SHA),
                          ('digest', reference.get('digest')),
                          ('params', reference.get('params')),
                          ('metricasVersion', reference.get('metricasVersion')),
                          ('instrumentos', reference.get('instrumentos')),
                          ('gobernador', reference.get('gobernador'))]:
        if manifest.get(key) != expected:
            errors.append(f'{name}: replica.json {key} distinto de referencia')
    if 'techoLab' in manifest or manifest.get('metricasVersion') != 2 or not str(manifest.get('instrumentos', '')).startswith('si;'):
        errors.append(f'{name}: modo de instrumentos inválido')
    summary = manifest.get('resumen')
    if not isinstance(summary, dict):
        errors.append(f'{name}: resumen ausente')
        return
    for day_key, summary_key in SUMMARY_FIELDS.items():
        if day_key not in last or summary_key not in summary or last[day_key] != summary[summary_key]:
            errors.append(f'{name}: día 60 difiere de resumen.{summary_key}')


def check_balance(days: dict[int, dict], initial: object, seed: int,
                  errors: list[str]) -> None:
    name = f'CTRLV4-{seed}'
    if type(initial) is not int or initial < 0:
        errors.append(f'{name}: población inicial inválida')
        return
    births_previous = cooperation_previous = 0
    deaths_previous: dict[str, int] = {}
    for number, day in sorted(days.items()):
        births, cooperation = day.get('nacimientos'), day.get('cooperaciones')
        deaths = day.get('muertesPorCausa')
        if type(births) is not int or births < births_previous:
            errors.append(f'{name}: nacimientos acumulados inválidos día {number}')
            continue
        if type(cooperation) is not int or cooperation < cooperation_previous:
            errors.append(f'{name}: cooperaciones acumuladas inválidas día {number}')
            continue
        if not isinstance(deaths, dict) or (deaths_previous and set(deaths) != set(deaths_previous)) or any(
            type(value) is not int or value < deaths_previous.get(cause, 0)
            for cause, value in deaths.items()
        ):
            errors.append(f'{name}: muertes acumuladas inválidas día {number}')
            continue
        if day.get('poblacion') != initial + births - sum(deaths.values()):
            errors.append(f'{name}: balance poblacional inválido día {number}')
        births_previous, cooperation_previous = births, cooperation
        deaths_previous = deaths


def check_log(path: Path, seed: int, population: object, errors: list[str]) -> None:
    if not real_file(path):
        errors.append(f'CTRLV4-{seed}: log canónico ausente o symlink')
        return
    body = path.read_text(encoding='utf-8')
    command = (f'replica.ts --seed {seed} --dias 60 --params {PARAMS_TEXT} '
               f'--salida {path.with_suffix("")}')
    if command not in body:
        errors.append(f'CTRLV4-{seed}: comando del log no corresponde')
    if not re.search(rf'Réplica completa: 60 día\(s\), población final {re.escape(str(population))}\. Salida: {re.escape(str(path.with_suffix("")))}(?:\n|\Z)', body):
        errors.append(f'CTRLV4-{seed}: terminación normal del log ausente')


def check_reruns(root: Path, days_by_seed: dict[int, dict[int, dict]],
                 errors: list[str]) -> int:
    archive = root / 'parciales-margen-ram-20260927-0031'
    tsv = root / 'codex-ctrlv4b-20260927.tsv'
    if not real_file(tsv):
        errors.append('TSV de eventos ausente o symlink')
        return 0
    lines = tsv.read_text(encoding='utf-8').splitlines()
    if not lines or lines[0] != 'hora\treplica\testado\tinfo':
        errors.append('TSV: cabecera inválida')
    events = {}
    launched: dict[int, int] = {}
    identities: dict[tuple[int, int], list[str]] = {}
    for line_number, line in enumerate(lines[1:], 2):
        cols = line.split('\t')
        if len(cols) != 4:
            errors.append(f'TSV línea {line_number}: cuatro columnas requeridas')
            continue
        seed_match = re.fullmatch(r'CTRLV4-(\d+)', cols[1])
        if cols[2] not in {'RELANZAMIENTO_IDENTICO', 'LANZADA', 'IDENTIDAD'}:
            continue
        if not seed_match or int(seed_match[1]) not in SEEDS:
            errors.append(f'TSV línea {line_number}: réplica de evento inválida')
            continue
        seed = int(seed_match[1])
        if cols[2] == 'LANZADA':
            launched[seed] = launched.get(seed, 0) + 1
            if (f'sha={SHA} params={PARAMS_TEXT} ' not in cols[3] or
                    f'salida={root / f"CTRLV4-{seed}"}' not in cols[3]):
                errors.append(f'TSV línea {line_number}: lanzamiento incompatible')
        elif cols[2] == 'IDENTIDAD':
            m = re.fullmatch(r'dia=([123]) sha256canon=([a-f0-9]{64}) tick=(2400|4800|7200)', cols[3])
            if not m or int(m[3]) != 2400 * int(m[1]):
                errors.append(f'TSV línea {line_number}: IDENTIDAD malformada')
            else:
                identities.setdefault((seed, int(m[1])), []).append(m[2])
        else:
            m = re.fullmatch(r'dia=([123]) sha256canon=([a-f0-9]{64}) '
                             r'fuente_archivada=parciales-margen-ram-20260927-0031/'
                             rf'CTRLV4-{seed}/dia-00([123])\.json', cols[3])
            if seed not in (6033, 6034) or not m or m[1] != m[3]:
                errors.append(f'TSV línea {line_number}: RELANZAMIENTO_IDENTICO malformado')
            else:
                events.setdefault((seed, int(m[1])), []).append(m[2])
    for seed in SEEDS:
        if launched.get(seed) != 1:
            errors.append(f'CTRLV4-{seed}: LANZADA inicial ausente o duplicada')
        for day in (1, 2, 3):
            entry = days_by_seed[seed].get(day)
            expected = fingerprint(entry) if entry else None
            if identities.get((seed, day)) != [expected]:
                errors.append(f'CTRLV4-{seed}: IDENTIDAD inicial día {day} ausente, duplicada o distinta')
    verified = 0
    for seed in (6033, 6034):
        for day in (1, 2, 3):
            label = f'CTRLV4-{seed}/dia-{day:03d}'
            try:
                old = read_json(archive / f'CTRLV4-{seed}' / f'dia-{day:03d}.json')
                new = days_by_seed[seed][day]
                if old.get('tick') != day * 2400 or new.get('tick') != day * 2400:
                    errors.append(f'{label}: tick del solape inválido')
                    continue
                old_hash, new_hash = fingerprint(old), fingerprint(new)
                if old_hash != new_hash:
                    errors.append(f'{label}: solape archivado distinto')
                elif events.get((seed, day)) != [new_hash]:
                    errors.append(f'{label}: hash ausente, repetido o distinto en TSV')
                else:
                    verified += 1
            except (KeyError, ValueError, OSError, json.JSONDecodeError) as exc:
                errors.append(f'{label}: solape ilegible: {exc}')
    return verified


def audit(root: Path) -> dict:
    errors: list[str] = []
    reference, schema = check_reference(root, errors)
    rows = []
    days_by_seed = {}
    for seed in SEEDS:
        name = f'CTRLV4-{seed}'
        folder = root / name
        paths = inventory(folder, errors)
        days = {}
        for number, path in sorted(paths.items()):
            try:
                day = read_json(path)
                check_day(day, number, seed, schema, errors)
                days[number] = day
            except (ValueError, OSError, json.JSONDecodeError) as exc:
                errors.append(f'{name}: día {number} ilegible: {exc}')
        days_by_seed[seed] = days
        final = len(days) == 60 and set(days) == set(range(1, 61))
        manifest_path = folder / 'replica.json'
        if real_file(manifest_path):
            try:
                manifest = read_json(manifest_path)
                if final:
                    check_manifest(manifest, seed, reference, days[60], errors)
                    check_balance(days, manifest.get('resumen', {}).get('poblacionInicial')
                                  if isinstance(manifest.get('resumen'), dict) else None,
                                  seed, errors)
                else:
                    errors.append(f'{name}: replica.json presente con días incompletos')
            except (ValueError, OSError, json.JSONDecodeError) as exc:
                errors.append(f'{name}: manifiesto ilegible: {exc}')
        elif final:
            errors.append(f'{name}: falta replica.json')
        if final:
            check_log(root / f'{name}.log', seed, days[60].get('poblacion'), errors)
        rows.append({'seed': seed, 'dias': len(days), 'ultimoDia': max(days, default=0),
                     'final': final and real_file(manifest_path)})
    # Los parciales archivados son prueba de solape, nunca segunda fuente del panel.
    for path in root.iterdir():
        if re.fullmatch(r'CTRLV4-\d+', path.name) and path.name not in {f'CTRLV4-{s}' for s in SEEDS}:
            errors.append(f'fuente canónica extra: {path.name}')
    overlap = check_reruns(root, days_by_seed, errors)
    complete = all(row['final'] for row in rows) and not errors and overlap == 6
    return {'estado': 'completo' if complete else 'invalido' if errors else 'parcial',
            'alcance': 'estructura_y_procedencia; identidad_solo_6_solapes_y_60_identidades_dias_1_a_3',
            'completo': complete, 'replicas': len(rows),
            'replicasFinales': sum(row['final'] for row in rows),
            'diasPresentes': sum(row['dias'] for row in rows),
            'solapesVerificados': overlap, 'semillas': rows, 'errores': errors}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-complete', action='store_true')
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT,
                        help='raíz CTRLV4b (útil para auditoría de copias)')
    args = parser.parse_args()
    try:
        result = audit(args.root)
    except (ValueError, OSError, UnicodeError, json.JSONDecodeError) as exc:
        result = {'estado': 'invalido', 'completo': False, 'errores': [str(exc)]}
    print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
    return 0 if (result['completo'] or not args.require_complete and result['estado'] == 'parcial') else 1


if __name__ == '__main__':
    sys.exit(main())
