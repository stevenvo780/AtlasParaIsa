#!/usr/bin/env python3
"""Evalúa F2.1 al día 60 con PUB2 sin techo y l60v3/B con techo 100.

Prerregistro: datos-lab/bitacora.md, 23-09 17:40. No escribe salidas si falta
alguno de los ocho PUB2 completos. No interpola diversidad nula ni extinción.
"""

import argparse
import hashlib
import itertools
import json
import math
from pathlib import Path
import statistics
import subprocess
import sys


SEEDS = (5, 29, 101, 202, 404, 505, 606, 707)
FIRST_DAY, LAST_DAY = 5, 60
TICKS_PER_DAY = 2400
TIE_TOLERANCE = 1e-9  # criterio-terminado.mts: TOLERANCIA_PLANA para índice en [0, 1]
DEFAULT_BASE = Path('/datos/tmp-atlas-lab/datos-lab')
DEFAULT_BALANCE = Path('/datos/tmp-atlas-lab/balance')
# Huellas de replica.json de las campañas congeladas: PUB2-505 y las ocho B
# concordantes, verificadas frente a bitácora 23-09 y audit-codex-campaigns.py.
EXPECTED = {
    'PUB2': {'sha': 'd2ebf11d51c3221477d88c7045faeafa2a229683',
             'digest': '63d4fc53b1a4c92e9c10bebed763958183ac22f246d8af744ba6a6ebfc840f0a',
             'paramsSha256': '3d7a05d5d1d2ee6ee0ee6feaeb18bbc8a2599db1b64c7365a6569bfec7e43b36'},
    'B': {'sha': '1710b350a1801910718afb8214cfe787cd5e0a8e',
          'digest': '9fc876125e804b9d601f546b2423d142ddd112fa089efe3e36226580f6d39d16',
          'paramsSha256': 'e8eff161e688c7fe8c2a26ec948fc83a6de10939b23a3ddde1509b78e851cbd8'},
}
B_GOVERNOR = 'techo de laboratorio fijo en 100; política techo del servidor sin reloj (reproductionEnabled = población < 100 antes de cada paso)'
PUB_GOVERNOR = 'no-ejecutado; replica de leyes, no del servidor'


def read_json(path):
    with path.open(encoding='utf-8') as stream:
        return json.load(stream)


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def params_sha256(params):
    if not isinstance(params, dict):
        raise ValueError('params no es objeto')
    canonical = json.dumps(params, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()


def read_arm(root, prefix, seed, techo):
    folder = root / f'{prefix}-{seed}'
    meta_path = folder / 'replica.json'
    missing = [day for day in range(1, LAST_DAY + 1)
               if not (folder / f'dia-{day:03}.json').is_file()]
    if missing or not meta_path.is_file():
        return None, {'ruta': str(folder), 'faltanDias': missing,
                      'faltaReplica': not meta_path.is_file()}
    meta = read_json(meta_path)
    if not isinstance(meta, dict):
        raise ValueError(f'{meta_path}: no es objeto')
    if meta.get('seed') != seed or meta.get('dias') != LAST_DAY:
        raise ValueError(f'{meta_path}: seed/dias no coinciden con {seed}/60')
    expected = EXPECTED[prefix]
    for key in ('sha', 'digest'):
        if meta.get(key) != expected[key]:
            raise ValueError(f'{meta_path}: {key} no corresponde a {prefix} congelado')
    if params_sha256(meta.get('params')) != expected['paramsSha256']:
        raise ValueError(f'{meta_path}: parámetros distintos del manifiesto {prefix} congelado')
    if techo:
        if meta.get('techoLab') != 100 or meta.get('gobernador') != B_GOVERNOR:
            raise ValueError(f'{meta_path}: no acredita techo de laboratorio 100')
        detail = meta.get('techoLabDetalle')
        fraction = detail.get('reproduccionActivaFraccion') if isinstance(detail, dict) else None
        if not finite_number(fraction) or not 0 <= fraction <= 1:
            raise ValueError(f'{meta_path}: techoLabDetalle.reproduccionActivaFraccion inválida')
    elif 'techoLab' in meta or 'techoLabDetalle' in meta or meta.get('gobernador') != PUB_GOVERNOR:
        raise ValueError(f'{meta_path}: PUB2 no acredita ausencia de techo y gobernador')
    days = {}
    for day in range(1, LAST_DAY + 1):
        path = folder / f'dia-{day:03}.json'
        body = read_json(path)
        if not isinstance(body, dict):
            raise ValueError(f'{path}: no es objeto')
        if body.get('tick') != day * TICKS_PER_DAY:
            raise ValueError(f'{path}: tick incorrecto')
        if techo:
            if body.get('techoLab') != 100:
                raise ValueError(f'{path}: techoLab diario no es 100')
        elif 'techoLab' in body or 'reproduccionActivaFraccion' in body:
            raise ValueError(f'{path}: PUB2 contiene campos de techo/gobernador incompatibles con modo sin techo')
        if day >= FIRST_DAY:
            value = body.get('diversidadConductaVentana')
            if 'diversidadConductaVentana' not in body or (value is not None and
                    (not finite_number(value) or not 0 <= value <= 1)):
                raise ValueError(f'{path}: diversidadConductaVentana ausente o fuera de [0, 1]')
            mortals = body.get('vecinosMortales')
            if type(mortals) is not int or mortals < 0:
                raise ValueError(f'{path}: vecinosMortales ausente o inválido')
        if day == LAST_DAY:
            for field in ('poblacion', 'nacimientos'):
                value = body.get(field)
                if type(value) is not int or value < 0:
                    raise ValueError(f'{path}: {field} ausente o inválido')
        days[day] = body
    return {'ruta': str(folder), 'replica': meta, 'dias': days}, None


def sen_increase(arm):
    values = []
    null_days = []
    extinct_days = []
    for day in range(FIRST_DAY, LAST_DAY + 1):
        body = arm['dias'][day]
        if body.get('vecinosMortales') == 0:
            extinct_days.append(day)
        value = body.get('diversidadConductaVentana')
        if not finite_number(value):
            null_days.append(day)
        else:
            values.append((day, value))
    # Una serie con huecos no corresponde al tramo preregistrado 5..60.
    if null_days or extinct_days:
        return {'subidaSen': None, 'pendienteSenPorDia': None,
                'diasValidos': len(values), 'diasNulos': null_days,
                'diasExtincion': extinct_days}
    # Mismas clases de empate por enlace simple que pendienteSen del evaluador
    # congelado: diferencias <= 1e-9 entre valores vecinos de la serie ordenada.
    classes = {}
    previous = None
    group = -1
    for day, value in sorted(values, key=lambda point: point[1]):
        if previous is None or value - previous > TIE_TOLERANCE:
            group += 1
        classes[day] = group
        previous = value
    slopes = sorted(0 if classes[da] == classes[db] else (b - a) / (db - da)
                    for (da, a), (db, b) in itertools.combinations(values, 2))
    slope = statistics.median(slopes)
    return {'subidaSen': slope * (LAST_DAY - FIRST_DAY),
            'pendienteSenPorDia': slope, 'diasValidos': len(values),
            'diasNulos': [], 'diasExtincion': []}


def flatten(data, prefix=''):
    out = {}
    for key, value in data.items():
        path = f'{prefix}.{key}' if prefix else key
        if isinstance(value, dict):
            out.update(flatten(value, path))
        else:
            out[path] = value
    return out


def parameter_differences(a, b):
    left = flatten(a['replica']['params'])
    right = flatten(b['replica']['params'])
    return [{'parametro': key, 'pub2': left.get(key), 'b': right.get(key)}
            for key in sorted(left.keys() | right.keys()) if left.get(key) != right.get(key)]


def chronological_evidence(a, b):
    """Ubica la divergencia observable; igualdad de métricas no prueba identidad del mundo."""
    excluded = {'p50Ms', 'p95Ms', 'rss'}
    first_difference = None
    first_cap = None
    for day in range(1, LAST_DAY + 1):
        left, right = a['dias'][day], b['dias'][day]
        common = left.keys() & right.keys() - excluded
        if first_difference is None and any(left[key] != right[key] for key in common):
            first_difference = day
        if first_cap is None and right['reproduccionActivaFraccion'] < 1:
            first_cap = day
    return {
        'primerDiaDiferenciaMetricasComunes': first_difference,
        'primerDiaReproduccionBMenorQueUno': first_cap,
        'excluidosDeComparacion': sorted(excluded),
        'alcance': 'igualdad de campos diarios comunes; no acredita identidad de estado interno ni equivalencia dinámica',
    }


def code_differences(pairs):
    """Inventario Git de cambios potencialmente dinámicos; no presupone su efecto."""
    repo = Path(__file__).resolve().parents[2]
    comparisons = []
    for pub_sha, b_sha in sorted({(pair['pub2']['sha'], pair['b']['sha']) for pair in pairs}):
        if pub_sha == b_sha:
            comparisons.append({'pub2Sha': pub_sha, 'bSha': b_sha,
                                'archivosDinamicaModificados': [], 'error': None})
            continue
        command = ['git', '-C', str(repo), 'diff', '--name-only', b_sha, pub_sha,
                   '--', 'src/world', 'scripts/lab/instrumentos.ts']
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        comparisons.append({'pub2Sha': pub_sha, 'bSha': b_sha,
                            'archivosDinamicaModificados': result.stdout.splitlines() if result.returncode == 0 else None,
                            'error': None if result.returncode == 0 else result.stderr.strip()})
    return comparisons


def evaluate(pub_root, b_root):
    pairs, pending = [], []
    for seed in SEEDS:
        pub, problem_pub = read_arm(pub_root, 'PUB2', seed, False)
        b, problem_b = read_arm(b_root, 'B', seed, True)
        if problem_pub or problem_b:
            pending.append({'semilla': seed, 'pub2': problem_pub, 'b': problem_b})
            continue
        pub_sen, b_sen = sen_increase(pub), sen_increase(b)
        pa, ba = pub_sen['subidaSen'], b_sen['subidaSen']
        delta = pa - ba if pa is not None and ba is not None else None
        fraction = [b['dias'][day].get('reproduccionActivaFraccion')
                    for day in range(1, LAST_DAY + 1)]
        if not all(finite_number(value) and 0 <= value <= 1 for value in fraction):
            raise ValueError(f'{b["ruta"]}: reproducción activa B incompleta o inválida')
        fraction_global = b['replica']['techoLabDetalle']['reproduccionActivaFraccion']
        if not math.isclose(statistics.mean(fraction), fraction_global, rel_tol=0, abs_tol=1e-12):
            raise ValueError(f'{b["ruta"]}: fracción global B no coincide con los 60 días')
        differences = parameter_differences(pub, b)
        same_sha = pub['replica']['sha'] == b['replica']['sha']
        pairs.append({
            'semilla': seed,
            'pub2': {'ruta': pub['ruta'], 'sha': pub['replica']['sha'],
                     'digestCodigo': pub['replica']['digest'],
                     'sha256Parametros': params_sha256(pub['replica']['params']),
                     'subidaSen': pub_sen, 'poblacionDia60': pub['dias'][60]['poblacion'],
                     'vecinosMortalesDia60': pub['dias'][60]['vecinosMortales'],
                     'nacimientosDia60': pub['dias'][60]['nacimientos'],
                     'reproduccionActivaFraccionObservada': None,
                     'reproduccionActivaFraccionDeducida': 1},
            'b': {'ruta': b['ruta'], 'sha': b['replica']['sha'],
                  'digestCodigo': b['replica']['digest'],
                  'sha256Parametros': params_sha256(b['replica']['params']),
                  'subidaSen': b_sen, 'poblacionDia60': b['dias'][60]['poblacion'],
                  'vecinosMortalesDia60': b['dias'][60]['vecinosMortales'],
                  'nacimientosDia60': b['dias'][60]['nacimientos'],
                  'reproduccionActivaFraccionGlobal': fraction_global,
                  'reproduccionActivaFraccionDia60': fraction[-1]},
            'diferenciaSubida': delta,
            'sinTechoMayor': None if delta is None else delta > 0,
            'shaIgual': same_sha,
            'diferenciasParametros': differences,
            'equivalenciaConfiguracionAcreditada': same_sha and not differences,
            'evidenciaCronologica': chronological_evidence(pub, b),
        })
    if pending:
        return {'estado': 'pendiente', 'paresCompletos': len(pairs), 'faltantes': pending}
    yes = sum(pair['sinTechoMayor'] is True for pair in pairs)
    unknown = sum(pair['sinTechoMayor'] is None for pair in pairs)
    direction = 'cumple' if yes >= 6 else 'refutada' if yes + unknown < 6 else 'indeterminada'
    return {
        'estado': 'completo',
        'prediccionDireccional': {'estado': direction,
            'criterio': 'subida Sen de diversidadConductaVentana 5..60 PUB2 > B en al menos 6/8'},
        'prediccionConjunta': {
            'estado': 'refutada' if direction == 'refutada' else
                      'indeterminada' if direction == 'indeterminada' else 'no_demostrada_empiricamente',
            'motivo': 'la dirección se mide; reproduccionActivaFraccion=1 en PUB2 se infiere del modo congelado y no tiene observación diaria',
        },
        'atribucionCausalTecho': {
            'estado': 'no_identificada',
            'condicion': 'para atribuir causalmente se requiere equivalencia dinámica demostrada además del pareado',
            'motivo': 'PUB2 y B tienen SHA, digest de código y parámetros distintos; la concordancia inicial de métricas no demuestra equivalencia dinámica',
        },
        'semillasMayor': yes, 'semillasIndeterminadas': unknown, 'semillas': list(SEEDS),
        'reproduccionActivaFraccionPUB2': {'observada': None, 'deducida': 1,
            'alcance': 'inferencia del modo de ejecución congelado, no medición ni prueba empírica de la conjunción del prerregistro',
            'fundamento': 'replica.ts d2ebf11 inicializa reproductionEnabled=true; PUB2 sin --techo-lab y con gobernador no-ejecutado; no se escribe fraccion diaria'},
        'advertenciaCausal': 'El contraste pareado responde a la predicción direccional. Con SHA o parámetros distintos no identifica el efecto aislado del techo.',
        'auditoriaCodigo': code_differences(pairs),
        'pares': pairs,
    }


def markdown(result):
    rows = ['# Veredicto F2.1 — día 60', '',
            'Fuente: bitácora del laboratorio, 23-09 17:40; PUB2 sin techo frente a l60v3/B con techo 100.',
            f'Predicción direccional preregistrada: **{result["prediccionDireccional"]["estado"]}**. PUB2 mayor en {result["semillasMayor"]}/8; '
            f'{result["semillasIndeterminadas"]} semilla(s) indeterminada(s).', '',
            f'Predicción conjunta: **{result["prediccionConjunta"]["estado"]}**. '
            f'{result["prediccionConjunta"]["motivo"]}.', '',
            f'Atribución causal al techo: **{result["atribucionCausalTecho"]["estado"]}**. '
            f'{result["atribucionCausalTecho"]["motivo"]}.', '',
            '| Semilla | Sen PUB2 | Sen B | Diferencia | Mayor | Repro B global | Repro B día 60 |',
            '|---:|---:|---:|---:|:---:|---:|---:|']
    fmt = lambda value: 'null' if value is None else repr(value)
    for pair in result['pares']:
        pub, b = pair['pub2'], pair['b']
        rows.append(f'| {pair["semilla"]} | {fmt(pub["subidaSen"]["subidaSen"])} | '
                    f'{fmt(b["subidaSen"]["subidaSen"])} | {fmt(pair["diferenciaSubida"])} | '
                    f'{pair["sinTechoMayor"]} | {fmt(b["reproduccionActivaFraccionGlobal"])} | '
                    f'{fmt(b["reproduccionActivaFraccionDia60"])} |')
    rows += ['', 'La subida es la mediana de todas las pendientes entre pares de días 5..60, multiplicada por 55; '
             'empates de la serie a tolerancia 1e-9 siguen el evaluador congelado. '
             'La comparación es estricta (>); no se redondea para decidir.',
             'Un día con diversidad null o sin vecinos mortales deja esa semilla indeterminada; no se interpola.',
             'PUB2 no registra `reproduccionActivaFraccion`: 1 se deduce del modo sin gobernador ni techo. '
             'No es una medición ni una prueba empírica de esa conjunción del prerregistro. B sí la registra.',
             result['advertenciaCausal'],
             'Las diferencias exactas de SHA y parámetros, poblaciones, nacimientos y el primer día de '
             'divergencia observable constan en el JSON. Una coincidencia de métricas antes de ese día '
             'no demuestra equivalencia del estado interno.', '']
    for audit in result['auditoriaCodigo']:
        files = audit['archivosDinamicaModificados']
        rows.append(f'Comparación de código {audit["bSha"][:7]} → {audit["pub2Sha"][:7]}: '
                    + (f'{len(files)} archivos cambiados en `src/world/` e instrumentos; lista en JSON.'
                       if files is not None else f'Git no pudo listar los cambios ({audit["error"]}); equivalencia no acreditada.'))
    rows.append('')
    return '\n'.join(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pub2-root', type=Path, default=DEFAULT_BASE / 'f21b-portatil')
    parser.add_argument('--b-root', type=Path, default=DEFAULT_BASE / 'l60v3')
    parser.add_argument('--salida', type=Path, default=DEFAULT_BALANCE)
    args = parser.parse_args()
    result = evaluate(args.pub2_root, args.b_root)
    if result['estado'] == 'pendiente':
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2
    args.salida.mkdir(parents=True, exist_ok=True)
    (args.salida / 'veredicto-f21.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (args.salida / 'veredicto-f21.md').write_text(markdown(result), encoding='utf-8')
    print(f'F2.1 direccional: {result["prediccionDireccional"]["estado"]}; '
          f'causal: {result["atribucionCausalTecho"]["estado"]}; '
          f'PUB2 mayor en {result["semillasMayor"]}/8; salidas en {args.salida}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
