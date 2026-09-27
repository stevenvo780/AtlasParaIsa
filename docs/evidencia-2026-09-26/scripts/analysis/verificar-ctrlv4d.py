#!/usr/bin/env python3
"""Audita estructura y procedencia de CTRLV4d en solo lectura.

Las huellas del TSV son testigos del lanzamiento, no una prueba independiente
de identidad de los días: este brazo no tiene solapes archivados anteriores.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import re
import sys


SIBLING = Path(__file__).with_name('verificar-ctrlv4b.py')
spec = importlib.util.spec_from_file_location('verificar_ctrlv4b', SIBLING)
assert spec and spec.loader
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

DEFAULT_ROOT = Path('/datos/tmp-atlas-lab/datos-lab/ctrlv4d-portatil')
SEEDS = range(6049, 6057)
TSV = 'codex-ctrlv4d-20260927.tsv'
REMOTE_ROOT = Path('/run/media/stev/datos/atlas-lab/ctrlv4d')


def check_new_instruments(day: dict, number: int, seed: int,
                          errors: list[str]) -> None:
    """Comprueba B y C, que el validador original aún no inspecciona por dentro."""
    name = f'CTRLV4-{seed}/dia-{number:03d}'

    def finite_between(value: object, low: float, high: float) -> bool:
        return type(value) in (int, float) and math.isfinite(value) and low <= value <= high

    daily_uses = day.get('usosUtiles')
    uses_valid = type(daily_uses) is int and 0 <= daily_uses <= 2_400_000_000
    if not uses_valid:
        errors.append(f'{name}: usosUtiles inválido')
    repertoire = day.get('repertorioAbierto')
    if repertoire is None:
        if uses_valid and daily_uses >= 100:
            errors.append(f'{name}: repertorioAbierto ausente con 100 o más usosUtiles')
    else:
        if not isinstance(repertoire, dict) or set(repertoire) != {
            'usos', 'clasesR100', 'recetasR100', 'clasesHill2'
        }:
            errors.append(f'{name}: repertorioAbierto estructura inválida')
        else:
            uses = repertoire['usos']
            # 100 muestras; 64 máscaras de seis capacidades. El máximo de usos
            # admite hasta 10^6 personas por los 2400 ticks de un día.
            if type(uses) is not int or not 100 <= uses <= 2_400_000_000:
                errors.append(f'{name}: repertorioAbierto.usos inválido')
            if uses_valid and uses != daily_uses:
                errors.append(f'{name}: repertorioAbierto.usos difiere de usosUtiles')
            for key, upper in (('clasesR100', 64), ('recetasR100', 100),
                               ('clasesHill2', 64)):
                if not finite_between(repertoire[key], 1, upper + 1e-7):
                    errors.append(f'{name}: repertorioAbierto.{key} inválido')

    between = day.get('diversidadEntreGrupos')
    if not isinstance(between, dict) or set(between) != {'comunidades', 'linajes'}:
        errors.append(f'{name}: diversidadEntreGrupos estructura inválida')
    else:
        # La lectura C es una diferencia de fracciones; los null son legítimos
        # cuando faltan dos grupos con al menos dos miembros cada uno.
        for key in ('comunidades', 'linajes'):
            value = between[key]
            if value is not None and not finite_between(value, -2, 2):
                errors.append(f'{name}: diversidadEntreGrupos.{key} inválido')


def check_reference(root: Path, errors: list[str]) -> tuple[dict, set[str]]:
    reference, schema = b.check_reference(root, errors)
    # La etiqueta del brazo es CTRLV4, igual que en el control original.
    if not b.real_file(root / 'brazo.txt'):
        errors.append('brazo.txt ausente o symlink')
    return reference, schema


def check_events(root: Path, days: dict[int, dict[int, dict]],
                 completed_manifests: dict[int, Path],
                 errors: list[str]) -> set[int]:
    path = root / TSV
    if not b.real_file(path):
        errors.append('TSV de eventos ausente o symlink')
        return set()
    lines = path.read_text(encoding='utf-8').splitlines()
    if not lines or lines[0] != 'hora\treplica\testado\tinfo':
        errors.append('TSV: cabecera inválida')
    launches: dict[int, list[str]] = {}
    witnesses: dict[tuple[int, int], list[str]] = {}
    manifests: dict[int, list[str]] = {}
    for lineno, line in enumerate(lines[1:], 2):
        cols = line.split('\t')
        if (len(cols) != 4 or
                not re.fullmatch(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{4}', cols[0]) or
                not re.fullmatch(r'CTRLV4-\d+', cols[1])):
            errors.append(f'TSV línea {lineno}: cuatro columnas/evento inválidos')
            continue
        seed = int(cols[1][7:])
        if seed not in SEEDS or cols[2] not in {'LANZADA', 'IDENTIDAD', 'MANIFIESTO_VERIFICADO'}:
            errors.append(f'TSV línea {lineno}: semilla o estado inesperado')
            continue
        if cols[2] == 'LANZADA':
            launches.setdefault(seed, []).append(cols[3])
            pattern = (rf'pid=([1-9]\d*) pgid=\1 sha={b.SHA} '
                       rf'params={re.escape(b.PARAMS_TEXT)} nice=19 afinidad=0-19 '
                       rf'TMPDIR=/run/media/stev/datos/atlas-lab/tmp '
                       rf'salida={re.escape(str(REMOTE_ROOT / f"CTRLV4-{seed}"))}')
            if not re.fullmatch(pattern, cols[3]):
                errors.append(f'TSV línea {lineno}: lanzamiento incompatible')
        elif cols[2] == 'IDENTIDAD':
            m = re.fullmatch(r'dia=([123]) sha256canon=([a-f0-9]{64}) tick=(2400|4800|7200)', cols[3])
            if not m or int(m[3]) != int(m[1]) * 2400:
                errors.append(f'TSV línea {lineno}: IDENTIDAD malformada')
            else:
                witnesses.setdefault((seed, int(m[1])), []).append(m[2])
        else:
            m = re.fullmatch(r'sha256=([a-f0-9]{64})', cols[3])
            if not m:
                errors.append(f'TSV línea {lineno}: MANIFIESTO_VERIFICADO malformado')
            else:
                manifests.setdefault(seed, []).append(m[1])
    launched = set(launches)
    for seed in SEEDS:
        if len(launches.get(seed, [])) > 1:
            errors.append(f'CTRLV4-{seed}: LANZADA duplicada')
        if seed not in launched and any(key[0] == seed for key in witnesses):
            errors.append(f'CTRLV4-{seed}: IDENTIDAD sin LANZADA')
        if seed in launched:
            for number in (1, 2, 3):
                entry = days.get(seed, {}).get(number)
                expected = b.fingerprint(entry) if entry is not None else None
                if witnesses.get((seed, number)) != [expected]:
                    errors.append(f'CTRLV4-{seed}: IDENTIDAD día {number} ausente, duplicada o distinta')
        manifest_path = completed_manifests.get(seed)
        if manifest_path is None:
            if manifests.get(seed):
                errors.append(f'CTRLV4-{seed}: MANIFIESTO_VERIFICADO para réplica incompleta')
        else:
            expected = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
            if manifests.get(seed) != [expected]:
                errors.append(f'CTRLV4-{seed}: MANIFIESTO_VERIFICADO ausente, duplicado o distinto')
    return launched


def check_log(path: Path, seed: int, population: object,
              errors: list[str]) -> None:
    if not b.real_file(path):
        errors.append(f'CTRLV4-{seed}: log canónico ausente o symlink')
        return
    body = path.read_text(encoding='utf-8')
    output = REMOTE_ROOT / f'CTRLV4-{seed}'
    # El lanzador directo no imprime el comando; SHA, params y ruta se fijan en LANZADA.
    ending = (rf'Réplica completa: 60 día\(s\), población final '
              rf'{re.escape(str(population))}\. Salida: {re.escape(str(output))}(?:\n|\Z)')
    if len(re.findall(ending, body)) != 1:
        errors.append(f'CTRLV4-{seed}: terminación normal única del log ausente')


def audit(root: Path) -> dict:
    errors: list[str] = []
    if not b.real_dir(root):
        raise ValueError(f'{root}: raíz ausente o symlink')
    reference, schema = check_reference(root, errors)
    rows: list[dict] = []
    all_days: dict[int, dict[int, dict]] = {}
    completed_manifests: dict[int, Path] = {}
    for seed in SEEDS:
        name = f'CTRLV4-{seed}'
        folder = root / name
        if not b.real_dir(folder):
            if folder.is_symlink() or folder.exists():
                errors.append(f'{name}: directorio canónico inválido o symlink')
            all_days[seed] = {}
            rows.append({'seed': seed, 'dias': 0, 'ultimoDia': 0, 'final': False})
            continue
        paths = b.inventory(folder, errors)
        days: dict[int, dict] = {}
        for number, path in sorted(paths.items()):
            try:
                day = b.read_json(path)
                b.check_day(day, number, seed, schema, errors)
                check_new_instruments(day, number, seed, errors)
                days[number] = day
            except (ValueError, OSError, TypeError, KeyError, json.JSONDecodeError) as exc:
                errors.append(f'{name}: día {number} ilegible: {exc}')
        all_days[seed] = days
        final = set(days) == set(range(1, 61))
        manifest_path = folder / 'replica.json'
        if b.real_file(manifest_path):
            try:
                manifest = b.read_json(manifest_path)
                if final:
                    completed_manifests[seed] = manifest_path
                    b.check_manifest(manifest, seed, reference, days[60], errors)
                    summary = manifest.get('resumen')
                    initial = summary.get('poblacionInicial') if isinstance(summary, dict) else None
                    b.check_balance(days, initial, seed, errors)
                else:
                    errors.append(f'{name}: replica.json presente con días incompletos')
            except (ValueError, OSError, TypeError, KeyError, json.JSONDecodeError) as exc:
                errors.append(f'{name}: manifiesto ilegible: {exc}')
        elif final or manifest_path.is_symlink() or manifest_path.exists():
            errors.append(f'{name}: replica.json ausente o symlink')
        log_path = root / f'{name}.log'
        if final:
            check_log(log_path, seed, days[60].get('poblacion'), errors)
        elif log_path.is_symlink():
            errors.append(f'{name}: log symlink')
        rows.append({'seed': seed, 'dias': len(days), 'ultimoDia': max(days, default=0),
                     'final': final and b.real_file(manifest_path) and b.real_file(log_path)})
    allowed = {f'CTRLV4-{seed}' for seed in SEEDS}
    allowed_logs = {f'{name}.log' for name in allowed}
    for path in root.iterdir():
        if re.fullmatch(r'CTRLV4-\d+', path.name) and path.name not in allowed:
            errors.append(f'fuente canónica extra: {path.name}')
        if re.fullmatch(r'CTRLV4-\d+\.log', path.name) and path.name not in allowed_logs:
            errors.append(f'log canónico extra: {path.name}')
    launched = check_events(root, all_days, completed_manifests, errors)
    for seed, row in zip(SEEDS, rows):
        folder = root / f'CTRLV4-{seed}'
        if seed in launched and not b.real_dir(folder):
            errors.append(f'CTRLV4-{seed}: directorio de réplica lanzada ausente')
        if seed not in launched and b.real_dir(folder):
            errors.append(f'CTRLV4-{seed}: directorio sin LANZADA')
        log = root / f'CTRLV4-{seed}.log'
        if seed not in launched and (log.exists() or log.is_symlink()):
            errors.append(f'CTRLV4-{seed}: log sin LANZADA')
    complete = len(launched) == 8 and all(row['final'] for row in rows) and not errors
    return {'estado': 'completo' if complete else 'invalido' if errors else 'parcial',
            'alcance': 'estructura_y_procedencia; testigos_TSV_dias_1_a_3; sin_identidad_independiente_de_dias',
            'completo': complete, 'replicas': len(rows), 'lanzadas': len(launched),
            'replicasFinales': sum(row['final'] for row in rows),
            'diasPresentes': sum(row['dias'] for row in rows),
            'semillas': rows, 'errores': errors}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--require-complete', action='store_true')
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    args = parser.parse_args()
    try:
        result = audit(args.root)
    except (ValueError, OSError, UnicodeError, TypeError, KeyError, json.JSONDecodeError) as exc:
        result = {'estado': 'invalido', 'completo': False, 'errores': [str(exc)]}
    print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
    return 0 if result['completo'] or not args.require_complete and result['estado'] == 'parcial' else 1


if __name__ == '__main__':
    sys.exit(main())
