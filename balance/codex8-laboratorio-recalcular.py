#!/usr/bin/env python3
"""Reproduce las 42 series, ventanas y grupos descriptivos de Objetivo 8 A.

Algoritmo numérico conservado de la extracción que produjo
codex8-laboratorio-cifras.json (SHA256
c37dd1f725b0a32075c5cebd8e60f7531c5e4400256826afe1699f04a9be29c0).
Lee solamente las tres copias congeladas A/B/C. No copia datos, no consulta
fuentes vivas, no ejecuta simulaciones ni evaluadores. La salida contiene las
secciones numéricas counts/groups/replicas y la procedencia sources; el
inventario histórico y las guardas de ejecuciones anteriores no se regeneran.

Uso (salida NUEVA de revisión, fuera del directorio de copias):
  nice -n 19 taskset -c 6-31 env TMPDIR=/datos/tmp-atlas-lab \
    /datos/tmp-atlas-lab/codex8-runtime/codex8-python \
    /datos/tmp-atlas-lab/balance/codex8-laboratorio-recalcular.py \
    --output-json /datos/tmp-atlas-lab/balance/revision-laboratorio-scratch.json

Las guardas observan prioridad/afinidad al inicio, antes de escribir y después
de escribir; no acreditan vigilancia continua. Solo se fija nice del proceso
propio, después de darle un nombre distinto de python para evitar la regla
externa de prioridad. No se modifica el host ni sus servicios.
"""

import argparse
import ctypes
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import statistics


DEFAULT_DATA_ROOT = Path('/datos/tmp-atlas-lab/datos-lab')
SCRATCH_ROOT = Path('/datos/tmp-atlas-lab')
CANONICAL_OUTPUT = SCRATCH_ROOT / 'balance/codex8-laboratorio-cifras.json'
CODE_REFERENCE_COMMIT = 'bb483260b2489fe62b113d620e5f56e5f3676dbc'
REQUIRED_CPUS = set(range(6, 32))
FIELDS = [
    'poblacion',
    'vecinosMortales',
    'recetasCreadasAcumuladas',
    'recetasDistintasEnUso',
    'recetasDistintasFabricadas',
    'usosUtiles',
    'beneficioUso',
    'maderaMediaAdultos',
    'piedraMediaAdultos',
    'cambiosHogar.adopta',
    'cambiosHogar.pierde',
    'repertorioAbierto.clasesR100',
    'repertorioAbierto.recetasR100',
    'repertorioAbierto.clasesHill2',
    'approachHogar',
]
POINT_KEYS = [
    'day', 'tick', 'poblacion', 'vecinosMortales',
    'recetasCreadasAcumuladas', 'recetasDistintasEnUso', 'usosUtiles',
    'maderaMediaAdultos', 'piedraMediaAdultos', 'cambiosHogar',
    'repertorioAbierto',
]
DAILY_KEYS = list(POINT_KEYS)
ARMS = ['CDC', 'CDD', 'CUPO2', 'CUPO6', 'CUPO20', 'COM12', 'COM12C20']
STRUCTURAL_KEYS_ABSENT = [
    'structures', 'structure_condition', 'structure_uses',
    'structure_daily_uses', 'structure_builtAt', 'structure_water',
    'structure_food', 'structures_abandoned', 'ruins',
]
FORBIDDEN_DIARY_KEY_PARTS = [
    'structure', 'estructura', 'condition', 'builtat', 'granero',
    'cisterna', 'ruina',
]
EXPECTED_MANIFEST_SHA256 = {
    'A': '3a748c2bf15903c3014007225e6515e4b97909a494b39ef29021492dce47484d',
    'B': '722cf5cc263c6a9501c49dc545f9a134d71757ea0e5305e498ec91f105d12439',
    'C': '1a7d0ddbc49d1217fc11228c994838a46dd2d8a399da6cb7e28b3a26801966c4',
}


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def require(condition, message):
    # No depender de assert: también debe proteger bajo python -O.
    if not condition:
        raise RuntimeError(message)


def establish_own_priority():
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.prctl(15, b'c8-lab-recalc', 0, 0, 0) == 0,
            'No se pudo nombrar el proceso propio mediante prctl')
    os.setpriority(os.PRIO_PROCESS, 0, 19)


def priority_guard(stage):
    result = {
        'stage': stage,
        'utc': utc_now(),
        'nice': os.getpriority(os.PRIO_PROCESS, 0),
        'cpus': sorted(os.sched_getaffinity(0)),
        'scheduler': os.sched_getscheduler(0),
    }
    require(result['nice'] == 19, f'Guard nice falló: {result}')
    require(set(result['cpus']) == REQUIRED_CPUS,
            f'Guard CPUs 6-31 falló: {result}')
    return result


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path):
    with path.open('r', encoding='utf-8') as source:
        return json.load(source)


def numeric(value):
    return (isinstance(value, (int, float))
            and not isinstance(value, bool) and math.isfinite(value))


def mean(values):
    finite = [value for value in values if numeric(value)]
    return statistics.mean(finite) if finite else None


def field(row, key):
    value = row
    for part in key.split('.'):
        value = value.get(part) if isinstance(value, dict) else None
    return value


def stats(rows, key):
    values = [field(row, key) for row in rows if numeric(field(row, key))]
    return {
        'observed': len(values),
        'missing_or_null': len(rows) - len(values),
        'mean': mean(values),
        'median': statistics.median(values) if values else None,
        'min': min(values) if values else None,
        'max': max(values) if values else None,
        'sum': sum(values) if values else None,
    }


def window(rows):
    return {
        'days': [row['day'] for row in rows],
        'n': len(rows),
        'metrics': {key: stats(rows, key) for key in FIELDS},
    }


def manifest_records_by_copy(manifest, manifest_path, data_root):
    """Normaliza las dos formas de manifest sin abrir rutas source."""
    records = manifest.get('records', manifest.get('files'))
    require(isinstance(records, list), f'Manifest sin registros: {manifest_path}')
    by_file = {}
    for record in records:
        copied_path = Path(record['copy'])
        if not copied_path.is_absolute():
            copied_path = manifest_path.parent / copied_path
        elif data_root != DEFAULT_DATA_ROOT:
            # Permite reubicar las copias juntas conservando su manifest A,
            # que registró rutas absolutas de la ubicación original.
            copied_path = data_root / copied_path.relative_to(DEFAULT_DATA_ROOT)
        copied_path = copied_path.resolve()
        require(copied_path not in by_file,
                f'Entrada copy duplicada en manifest: {copied_path}')
        by_file[copied_path] = record
    return by_file


def verify_copied_file(path, by_file):
    require(path.resolve() in by_file, f'Archivo fuera de manifest: {path}')
    record = by_file[path.resolve()]
    require(sha256(path) == record['sha256'], f'SHA distinto del corte: {path}')
    return record


def extract_replicas(data_root):
    configurations = [
        ('A', 'com-d-panel/torre-primario',
         data_root / 'codex8-c8-copia/torre-primario',
         data_root / 'codex8-c8-copia/MANIFEST.json'),
        ('B', 'cupo-cribado/fix',
         data_root / 'codex8-cupo-copia',
         data_root / 'codex8-cupo-copia/MANIFEST.json'),
        ('C', 'cupo-canónicas-adicionales',
         data_root / 'codex8-cupo-copia-adicional',
         data_root / 'codex8-cupo-copia-adicional/MANIFEST.json'),
    ]
    replicas = []
    sources = []
    for label, name, base, manifest_path in configurations:
        manifest_sha = sha256(manifest_path)
        require(manifest_sha == EXPECTED_MANIFEST_SHA256[label],
                f'Manifest distinto del corte {label}: {manifest_path}')
        manifest = read_json(manifest_path)
        by_file = manifest_records_by_copy(manifest, manifest_path, data_root)
        verified = 0
        for replica in sorted(path for path in base.iterdir() if path.is_dir()):
            rows = []
            first_record = None
            for path in sorted(replica.glob('dia-*.json')):
                record = verify_copied_file(path, by_file)
                verified += 1
                if first_record is None:
                    first_record = record
                value = read_json(path)
                day = int(path.stem[4:])
                require(value['tick'] == day * 2400, f'Tick inválido: {path}')
                require(value['ventanaActividad'] == {
                    'desdeTickExclusivo': (day - 1) * 2400,
                    'hastaTickInclusivo': day * 2400,
                }, f'Ventana diaria inválida: {path}')
                require(not any(part in key.lower()
                                for key in value
                                for part in FORBIDDEN_DIARY_KEY_PARTS),
                        f'Cambio de observabilidad estructural: {path}')
                rows.append({'day': day, **value})

            require(bool(rows), f'Réplica vacía: {replica}')
            days = [row['day'] for row in rows]
            last_day = max(days)
            require(days == list(range(1, last_day + 1)),
                    f'Días incompletos o desordenados: {replica}')
            require(last_day <= 60, f'Corte supera 60d: {replica}')
            require(all(right['recetasCreadasAcumuladas']
                        >= left['recetasCreadasAcumuladas']
                        for left, right in zip(rows, rows[1:])),
                    f'Catálogo acumulado no monótono: {replica}')
            metadata_path = replica / 'replica.json'
            metadata = None
            if metadata_path.exists():
                verify_copied_file(metadata_path, by_file)
                verified += 1
                metadata = read_json(metadata_path)
                require(metadata['dias'] == last_day,
                        f'replica.json/diarios no coinciden: {replica}')

            last = rows[-1]
            missing = [day for day in range(1, 61) if day not in days]
            points = {
                str(day): next((row for row in rows if row['day'] == day), None)
                for day in [1, 20, last_day]
            }
            complete = not missing and metadata is not None and metadata['dias'] == 60
            info = {
                'source_group': name,
                'cut_label': label,
                'origin_directory': str(Path(first_record['source']).parent),
                'id': replica.name,
                'arm': replica.name.rsplit('-', 1)[0],
                'seed': int(replica.name.rsplit('-', 1)[1]),
                'copied_directory': str(replica),
                'observed_days': days,
                'n_days': len(days),
                'last_day': last_day,
                'last_tick': last['tick'],
                'missing_to_60': missing,
                'replica_json_present': metadata is not None,
                'status': 'completa_60d' if complete else 'parcial_al_corte',
                'metadata': None if metadata is None else {
                    key: metadata.get(key)
                    for key in ['dias', 'sha', 'digest', 'seed', 'metricasVersion', 'params']
                },
                'points': {
                    key: None if value is None else {
                        name: value.get(name) for name in POINT_KEYS
                    }
                    for key, value in points.items()
                },
                'first_10': window(rows[:10]),
                'last_10': window(rows[-10:]),
                'all_observed': window(rows),
                'last_day_distinct_used_over_lifetime_created': (
                    last['recetasDistintasEnUso'] / last['recetasCreadasAcumuladas']
                    if last['recetasCreadasAcumuladas'] else None
                ),
                'structural_metrics': {
                    'status': 'NO OBSERVABLE',
                    'value': None,
                    'absent_fields': list(STRUCTURAL_KEYS_ABSENT),
                },
                'daily_values': [
                    {key: value.get(key) for key in DAILY_KEYS} for value in rows
                ],
            }
            replicas.append(info)

        sources.append({
            'cut_label': label,
            'group': name,
            'copied_directory': str(base),
            'manifest': str(manifest_path),
            'manifest_sha256': manifest_sha,
            'copy_start_utc': manifest.get('startedUTC', manifest.get('cut_started_utc')),
            'copy_end_utc': manifest.get('completedUTC', manifest.get('cut_finished_utc')),
            'all_stable_at_copy': manifest.get(
                'allStableAtCopy', manifest.get('all_stable_at_copy')),
            'verified_files_used': verified,
            'n_replicas': sum(replica['source_group'] == name for replica in replicas),
        })
    return sources, replicas


def aggregate_groups(replicas):
    groups = []
    for arm in ARMS:
        selected = [replica for replica in replicas if replica['arm'] == arm]
        require(len(selected) == 6, f'Brazo sin seis identidades: {arm}')
        summaries = {}
        for key in FIELDS:
            summaries[key] = {}
            for name in ['first_10', 'last_10']:
                values = [replica[name]['metrics'][key]['mean'] for replica in selected]
                finite = [value for value in values if numeric(value)]
                summaries[key][name] = {
                    'replicas_with_value': len(finite),
                    'equal_replica_mean': mean(values),
                    'median_of_replica_means': (
                        statistics.median(finite) if finite else None
                    ),
                }
        groups.append({
            'arm': arm,
            'n_replicas': len(selected),
            'complete_60d': sum(replica['status'] == 'completa_60d' for replica in selected),
            'partial': sum(replica['status'] == 'parcial_al_corte' for replica in selected),
            'last_day_range': [
                min(replica['last_day'] for replica in selected),
                max(replica['last_day'] for replica in selected),
            ],
            'lifetime_created_last_mean': mean([
                replica['points'][str(replica['last_day'])]['recetasCreadasAcumuladas']
                for replica in selected
            ]),
            'last_used_over_created_mean': mean([
                replica['last_day_distinct_used_over_lifetime_created']
                for replica in selected
            ]),
            'metrics': summaries,
        })
    return groups


def verify_coverage(replicas):
    require(len(replicas) == 42 and len({replica['id'] for replica in replicas}) == 42,
            'Cobertura distinta de 42 identidades únicas')
    cupo = [replica for replica in replicas if replica['arm'] not in ['CDC', 'CDD']]
    expected_cupo = {
        f'{arm}-{seed}' for arm in ARMS[2:] for seed in range(8101, 8107)
    }
    expected_c8 = {
        f'{arm}-{seed}' for arm in ARMS[:2] for seed in range(9501, 9507)
    }
    require(len(cupo) == 30 and {replica['id'] for replica in cupo} == expected_cupo,
            'Identidades cupo distintas de los cinco brazos x seis semillas')
    require({replica['id'] for replica in replicas if replica['cut_label'] == 'A'}
            == expected_c8, 'Identidades primarias COM-D distintas del corte')
    require(sum(replica['n_days'] for replica in replicas) == 2428,
            'Número de diarios distinto de los cortes congelados')
    require({source: sum(replica['cut_label'] == source for replica in replicas)
             for source in ['A', 'B', 'C']} == {'A': 12, 'B': 13, 'C': 17},
            'Identidades por corte distintas de A12/B13/C17')
    for replica in replicas:
        for key in ['maderaMediaAdultos', 'piedraMediaAdultos']:
            require(replica['first_10']['metrics'][key]['observed'] == 8,
                    f'Observabilidad material temprana cambió: {replica["id"]}/{key}')
            require(replica['last_10']['metrics'][key]['observed'] == 10,
                    f'Observabilidad material final cambió: {replica["id"]}/{key}')
    return {
        'measured_replicas': len(replicas),
        'c8_replicas': 12,
        'cupo_canonical_replicas': len(cupo),
        'cupo_fix_replicas': sum(replica['cut_label'] == 'B' for replica in replicas),
        'cupo_additional_replicas': sum(replica['cut_label'] == 'C' for replica in replicas),
        'diary_files': sum(replica['n_days'] for replica in replicas),
        'cupo_diary_files': sum(replica['n_days'] for replica in cupo),
        'complete_60d': sum(replica['status'] == 'completa_60d' for replica in replicas),
        'partial': sum(replica['status'] == 'parcial_al_corte' for replica in replicas),
        'cupo_complete_60d': sum(replica['status'] == 'completa_60d' for replica in cupo),
        'cupo_partial': sum(replica['status'] == 'parcial_al_corte' for replica in cupo),
        'structural_state_observable_replicas': 0,
    }


def validate_output_path(output, data_root):
    resolved = output.resolve()
    require(resolved.is_relative_to(SCRATCH_ROOT),
            'La salida de revisión debe estar dentro de /datos/tmp-atlas-lab')
    require(not resolved.is_relative_to(data_root),
            'La salida no puede estar dentro del directorio de datos/cortes')
    require(not resolved.is_relative_to(SCRATCH_ROOT / 'codex8-runtime'),
            'La salida no puede estar dentro del runtime')
    require(resolved != CANONICAL_OUTPUT.resolve(),
            'El JSON canónico está protegido')
    require(not output.exists() and not output.is_symlink(),
            'La salida de revisión debe ser un archivo nuevo; no se sobrescribe')
    require(output.parent.is_dir(), 'El directorio de salida debe existir')
    return resolved


def main():
    establish_own_priority()
    initial_guard = priority_guard('initial')
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--data-root', type=Path, default=DEFAULT_DATA_ROOT,
                        help='Raíz que contiene juntas las tres copias congeladas')
    parser.add_argument('--output-json', type=Path, required=True,
                        help='Archivo NUEVO de revisión, fuera de las copias de datos')
    arguments = parser.parse_args()
    data_root = arguments.data_root.resolve()
    output = validate_output_path(arguments.output_json, data_root)
    sources, replicas = extract_replicas(data_root)
    counts = verify_coverage(replicas)
    groups = aggregate_groups(replicas)
    result = {
        'version': 2,
        'kind': 'objetivo8-A-descriptivo-sin-evaluadores-recalculo-scratch',
        'generated_utc': utc_now(),
        'code_reference_commit': CODE_REFERENCE_COMMIT,
        'sources': sources,
        'priority_guards': {
            'initial': initial_guard,
            'final': priority_guard('final'),
        },
        'counts': counts,
        'groups': groups,
        'replicas': replicas,
    }
    # Exclusivo: una ruta ya existente nunca se trunca ni reemplaza.
    with output.open('x', encoding='utf-8') as destination:
        json.dump(result, destination, ensure_ascii=False, indent=2, allow_nan=False)
        destination.write('\n')
    post_write = priority_guard('post_write')
    print(json.dumps({
        'output': str(output),
        'sha256': sha256(output),
        'counts': counts,
        'post_write_guard': post_write,
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
