#!/usr/bin/env python3
"""Prepara directorios reales para el evaluador C8 congelado, sin ejecutarlo.

Uso:
    python3 scripts/analysis/prepare-c8-decision-input.py --preflight  # solo lectura
    python3 scripts/analysis/prepare-c8-decision-input.py --preflight --permitir-hog-2010-fallo
    python3 scripts/analysis/prepare-c8-decision-input.py --build      # crea la entrada
    python3 scripts/analysis/prepare-c8-decision-input.py --verify     # solo lectura

Verificación posterior: inspeccionar MANIFIESTO.json en la entrada y comprobar que
`find /datos/tmp-atlas-lab/balance/decision-c8-entrada-20260926 -mindepth 1
-maxdepth 1 -type l` no devuelve nada. El script comprueba además todos los
dirents y hardlinks antes de anunciar éxito. Para evaluar, pasar esa entrada a
`decision-c8-linaje.mts --corte 60`; este script nunca ejecuta el evaluador.
Después de sincronizar CTRL2, correr `--corte 20` sobre esta entrada y comparar
con balance/decision-c8-d20.json: VOC 7/12 seguras y DETENER, VOCHOG 7/12 y
DETENER, HOG 11/12 y CONTINUAR. Luego correr `--corte 60` como salida roja
documental. Con HOG-2010 parcial, la salida del evaluador no es un veredicto
válido de C8; conservar DATOS_INCOMPLETOS literal si aparece.

No modifica ni borra fuentes. Si falla tras crear el destino, conserva el
directorio parcial para inspección y una nueva ejecución falla por existencia.
Los hardlinks comparten inode con la fuente: tratar ambos lados como solo lectura
y ejecutar `--verify` antes y después de evaluar. El manifiesto registra SHA-256
de todos los archivos enlazados, no solo de una muestra.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


SOURCE = Path('/datos/tmp-atlas-lab/datos-lab/c8panel')
DEST = Path('/datos/tmp-atlas-lab/balance/decision-c8-entrada-20260926')
ARMS = ('CTRL', 'CTRL2', 'HOG', 'VOC', 'VOCHOG')
SEEDS = range(2001, 2017)
PANEL = range(2001, 2013)
DAY_PATTERN = re.compile(r'dia-(\d{3})\.json\Z')
TICKS_PER_DAY = 2400
# Contrato de HOG y CTRL2 en audit-codex-campaigns.py (T2).
SHA_C8 = 'd2ebf11d51c3221477d88c7045faeafa2a229683'
LIMITS = {'teselasActivas': 1303552, 'chunks': 5092, 'fauna': 7821312}
HOG_FAILURE_VERIFIER = Path(__file__).with_name('verificar-hog-2010.py')
RED_CRITERION = ('Entrada roja: HOG-2010 solo días 001..024, sin replica.json, '
                 'fallo repetido acreditado por verificar-hog-2010.py; '
                 'otros HOG y CTRL2 2001..2012: 60 días 001..060 + replica.json; dirents reales')
STRICT_CRITERION = 'HOG y CTRL2 2001..2012: 60 días 001..060 + replica.json; dirents reales'


def hog_failure_evidence():
    """Recalcula evidencia sin ejecutar el main ni crear bytecode en el worktree."""
    namespace = {'__name__': 'verificar_hog_2010', '__file__': str(HOG_FAILURE_VERIFIER)}
    source = HOG_FAILURE_VERIFIER.read_bytes()
    exec(compile(source, str(HOG_FAILURE_VERIFIER), 'exec'), namespace)
    result = namespace['verificar']()
    if result.get('veredicto') != 'fallo_repetido_acreditado' or not all(result.get('comprobaciones', {}).values()):
        raise ValueError('HOG-2010: fallo repetido no acreditado por verificar-hog-2010.py')
    return result


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def real_regular_file(path):
    mode = path.lstat().st_mode
    if not stat.S_ISREG(mode):
        raise ValueError(f'Archivo no regular o enlace simbólico: {path}')


def source_for(arm, seed):
    name = f'{arm}-{seed}'
    alias = SOURCE / name
    if arm == 'CTRL2':
        canonical = SOURCE / 'portatil' / name
        if not os.path.lexists(canonical):
            if os.path.lexists(alias):
                raise FileNotFoundError(f'{alias}: falta el destino real {canonical}')
            return None
        source = canonical.resolve(strict=True)
        if os.path.lexists(alias) and alias.resolve(strict=True) != source:
            raise ValueError(f'{alias}: no resuelve al directorio de portatil esperado')
        if not source.is_relative_to((SOURCE / 'portatil').resolve(strict=True)):
            raise ValueError(f'{source}: CTRL2 debe quedar bajo c8panel/portatil')
    else:
        if not os.path.lexists(alias):
            return None
        if arm in ('HOG', 'VOC', 'VOCHOG') and not stat.S_ISDIR(alias.lstat().st_mode):
            raise ValueError(f'{alias}: el brazo debe ser directorio real, no symlink')
        source = alias.resolve(strict=True)
        if arm == 'CTRL':
            # Los CTRL históricos son symlinks hacia el directorio hermano ctrl/.
            ctrl_root = (SOURCE.parent / 'ctrl').resolve(strict=True)
            expected = (SOURCE.parent / 'ctrl' / name).resolve(strict=True)
            if source != expected or not source.is_relative_to(ctrl_root):
                raise ValueError(f'{alias}: CTRL no resuelve al origen histórico esperado {expected}')
        elif not source.is_relative_to(SOURCE.resolve(strict=True)):
            raise ValueError(f'{alias}: origen fuera de c8panel: {source}')
    if not source.is_dir():
        raise ValueError(f'{source}: no es directorio')
    return {'nombre': name, 'alias': str(alias) if os.path.lexists(alias) else None,
            'origen': source, 'brazo': arm, 'semilla': seed}


def inspect_replica(replica, seed, arm, required):
    if replica is None:
        if required:
            raise ValueError(f'Semilla {seed}: falta replica.json en brazo obligatorio')
        return None
    with replica.open(encoding='utf-8') as stream:
        metadata = json.load(stream)
    if not isinstance(metadata, dict) or metadata.get('seed') != seed:
        raise ValueError(f'{replica}: seed incorrecta o JSON no objeto')
    if required and metadata.get('dias') != 60:
        raise ValueError(f'{replica}: dias != 60')
    if required:
        if metadata.get('sha') != SHA_C8:
            raise ValueError(f'{replica}: SHA incorrecto (esperado {SHA_C8})')
        if metadata.get('gobernador') != 'no-ejecutado; replica de leyes, no del servidor':
            raise ValueError(f'{replica}: gobernador debe ser no-ejecutado')
        if 'techoLab' in metadata or 'techoLabDetalle' in metadata:
            raise ValueError(f'{replica}: contiene claves de techo de laboratorio')
        params = metadata.get('params')
        if not isinstance(params, dict):
            raise ValueError(f'{replica}: faltan parámetros')
        persistencia = params.get('persistencia')
        limites = params.get('limites')
        social = params.get('social')
        conducta = params.get('conducta')
        if not isinstance(persistencia, dict) or persistencia.get('cadaTicks') != 300:
            raise ValueError(f'{replica}: persistencia.cadaTicks != 300')
        if not isinstance(limites, dict):
            raise ValueError(f'{replica}: faltan límites')
        for key, value in LIMITS.items():
            if limites.get(key) != value:
                raise ValueError(f'{replica}: limites.{key} != {value}')
        expected_hog = 1 if arm == 'HOG' else 0
        if not isinstance(social, dict) or social.get('hogarTrabajo') != expected_hog:
            raise ValueError(f'{replica}: social.hogarTrabajo != {expected_hog}')
        if not isinstance(conducta, dict) or conducta.get('vocacion') != 0:
            raise ValueError(f'{replica}: conducta.vocacion != 0')
    return metadata


def inspect_source(item, permitir_hog_2010_fallo=False):
    source = item['origen']
    entries = list(os.scandir(source))
    malformed = sorted(entry.name for entry in entries
                       if entry.name.startswith('dia-') and entry.name.endswith('.json')
                       and not DAY_PATTERN.fullmatch(entry.name))
    if malformed:
        raise ValueError(f'{source}: archivos de día con nombre no canónico: {malformed}')
    names = sorted(entry.name for entry in entries if DAY_PATTERN.fullmatch(entry.name))
    days = [int(DAY_PATTERN.fullmatch(name).group(1)) for name in names]
    if len(set(days)) != len(days) or any(day < 1 or day > 60 for day in days):
        raise ValueError(f'{source}: numeración de días fuera de 1..60 o duplicada')
    required = item['brazo'] in ('HOG', 'CTRL2') and item['semilla'] in PANEL
    partial_hog = permitir_hog_2010_fallo and item['nombre'] == 'HOG-2010'
    expected_days = list(range(1, 25)) if partial_hog else list(range(1, 61))
    if required and days != expected_days:
        missing = sorted(set(expected_days) - set(days))
        raise ValueError(f'{source}: faltan días para brazo obligatorio: {missing}')
    files = [source / name for name in names]
    replica = source / 'replica.json'
    if os.path.lexists(replica):
        files.append(replica)
    else:
        replica = None
    if partial_hog and replica is not None:
        raise ValueError(f'{source}: HOG-2010 rojo debe carecer de replica.json')
    for path in files:
        real_regular_file(path)
    metadata = inspect_replica(replica, item['semilla'], item['brazo'], required and not partial_hog)
    if required:
        for day, path in zip(days, files):
            if day > 60:
                break
            with path.open(encoding='utf-8') as stream:
                body = json.load(stream)
            if not isinstance(body, dict) or body.get('tick') != day * TICKS_PER_DAY:
                raise ValueError(f'{path}: tick incorrecto o JSON no objeto')
    record = {**item, 'archivos': files, 'dias': days, 'replica': metadata}
    return record


def preflight(permitir_hog_2010_fallo=False):
    if os.path.lexists(DEST):
        raise FileExistsError(f'El destino ya existe; no se modifica: {DEST}')
    if not DEST.parent.is_dir():
        raise FileNotFoundError(f'Falta el directorio balance: {DEST.parent}')
    if permitir_hog_2010_fallo:
        hog = source_for('HOG', 2010)
        if hog is None:
            raise FileNotFoundError('Falta HOG-2010 obligatorio')
        inspect_source(hog, True)
        hog_failure_evidence()
    items = []
    for arm in ARMS:
        for seed in SEEDS:
            item = source_for(arm, seed)
            if item is None:
                if arm in ('HOG', 'CTRL2') and seed in PANEL:
                    raise FileNotFoundError(f'Falta {arm}-{seed} obligatorio')
                continue
            inspected = inspect_source(item, permitir_hog_2010_fallo)
            for path in inspected['archivos']:
                if path.stat().st_dev != DEST.parent.stat().st_dev:
                    raise OSError(f'No se puede crear hardlink entre dispositivos: {path} -> {DEST}')
            items.append(inspected)
    return items


def evidence(path, linked):
    source_stat, dest_stat = path.stat(), linked.stat()
    if (source_stat.st_dev, source_stat.st_ino) != (dest_stat.st_dev, dest_stat.st_ino):
        raise ValueError(f'No son hardlinks del mismo inode: {path} -> {linked}')
    return {'archivo': path.name, 'dispositivo': source_stat.st_dev,
            'inode': source_stat.st_ino, 'bytes': source_stat.st_size,
            'sha256': sha256(path)}


def verify_hardlink(path, linked):
    source_stat, dest_stat = path.stat(), linked.lstat()
    if not stat.S_ISREG(dest_stat.st_mode) or (source_stat.st_dev, source_stat.st_ino) != (dest_stat.st_dev, dest_stat.st_ino):
        raise ValueError(f'Archivo de destino no regular o no hardlink: {path} -> {linked}')


def build(items, permitir_hog_2010_fallo=False):
    # mkdir exclusivo falla también ante un destino creado tras el preflight.
    DEST.mkdir(exist_ok=False)
    manifest = {'creadoUTC': datetime.now(timezone.utc).isoformat(),
                'entrada': str(DEST), 'fuente': str(SOURCE),
                'criterioEntrada': RED_CRITERION if permitir_hog_2010_fallo else STRICT_CRITERION,
                'entradaRoja': permitir_hog_2010_fallo,
                'hog2010Parcial': {'dias': list(range(1, 25)), 'replicaJson': False,
                                   'verificacion': hog_failure_evidence()}
                if permitir_hog_2010_fallo else None,
                'replicas': []}
    for item in items:
        target = DEST / item['nombre']
        target.mkdir(exist_ok=False)
        for source_file in item['archivos']:
            linked = target / source_file.name
            os.link(source_file, linked, follow_symlinks=False)
            verify_hardlink(source_file, linked)
        if {entry.name for entry in os.scandir(target)} != {path.name for path in item['archivos']}:
            raise ValueError(f'{target}: contiene archivos ajenos a la lista inspeccionada')
        manifest['replicas'].append({
            'nombre': item['nombre'], 'brazo': item['brazo'], 'semilla': item['semilla'],
            'aliasEnPanel': item['alias'], 'origenReal': str(item['origen']),
            'numeroDias': len(item['dias']), 'dias': item['dias'],
            'replicaJson': item['replica'] is not None,
            'shaReplica': item['replica'].get('sha') if item['replica'] else None,
            'archivosEnlazados': len(item['archivos']),
            'huellasArchivos': [evidence(path, target / path.name) for path in item['archivos']],
        })
    # Verificación final equivalente a Dirent.isDirectory: nunca basta Path.is_dir()
    # porque sigue symlinks. Ningún archivo de log ni subdirectorio entra en la vista.
    actual = {entry.name for entry in os.scandir(DEST) if entry.is_dir(follow_symlinks=False)}
    expected = {item['nombre'] for item in items}
    if actual != expected:
        raise ValueError(f'Dirents reales distintos de lo esperado: {sorted(expected ^ actual)}')
    for entry in os.scandir(DEST):
        if entry.is_symlink():
            raise ValueError(f'Enlace simbólico inesperado en la entrada: {entry.path}')
    (DEST / 'MANIFIESTO.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    verify()
    return len(items)


def verify():
    """Relee todas las huellas y la identidad inode fuente/destino sin escribir."""
    if not os.path.lexists(DEST) or not stat.S_ISDIR(DEST.lstat().st_mode):
        raise ValueError(f'{DEST}: falta el directorio real de entrada')
    manifest_path = DEST / 'MANIFIESTO.json'
    real_regular_file(manifest_path)
    with manifest_path.open(encoding='utf-8') as stream:
        manifest = json.load(stream)
    if manifest.get('entrada') != str(DEST) or not isinstance(manifest.get('replicas'), list):
        raise ValueError(f'{manifest_path}: formato o ruta de entrada incorrectos')
    red = manifest.get('entradaRoja')
    if not isinstance(red, bool) or manifest.get('criterioEntrada') != (RED_CRITERION if red else STRICT_CRITERION):
        raise ValueError(f'{manifest_path}: criterio de entrada roja/estricta inconsistente')
    if red:
        partial = manifest.get('hog2010Parcial')
        if not isinstance(partial, dict) or partial.get('dias') != list(range(1, 25)) or partial.get('replicaJson') is not False:
            raise ValueError(f'{manifest_path}: excepción HOG-2010 incompleta')
        if partial.get('verificacion') != hog_failure_evidence():
            raise ValueError(f'{manifest_path}: evidencia HOG-2010 cambió')
    elif manifest.get('hog2010Parcial') is not None:
        raise ValueError(f'{manifest_path}: excepción HOG-2010 no permitida')
    expected_dirs = {item['nombre'] for item in manifest['replicas']}
    if len(expected_dirs) != len(manifest['replicas']):
        raise ValueError(f'{manifest_path}: directorios duplicados')
    required_dirs = {f'{arm}-{seed}' for arm in ('HOG', 'CTRL2') for seed in PANEL}
    if not required_dirs.issubset(expected_dirs):
        raise ValueError(f'{manifest_path}: faltan réplicas obligatorias: {sorted(required_dirs - expected_dirs)}')
    root_entries = list(os.scandir(DEST))
    actual_dirs = {entry.name for entry in root_entries if entry.is_dir(follow_symlinks=False)}
    if actual_dirs != expected_dirs or {entry.name for entry in root_entries if not entry.is_dir(follow_symlinks=False)} != {'MANIFIESTO.json'}:
        raise ValueError(f'{DEST}: dirents distintos de los declarados o symlink inesperado')
    total = 0
    for item in manifest['replicas']:
        name = item['nombre']
        if not re.fullmatch(r'(CTRL|CTRL2|HOG|VOC|VOCHOG)-20(?:0[1-9]|1[0-6])', name):
            raise ValueError(f'Nombre de réplica inesperado en manifiesto: {name}')
        arm, seed_text = name.split('-')
        if item['brazo'] != arm or item['semilla'] != int(seed_text):
            raise ValueError(f'{name}: identidad de brazo o semilla inconsistente')
        current = source_for(arm, int(seed_text))
        source = Path(item['origenReal'])
        target = DEST / name
        if current is None or source != current['origen']:
            raise ValueError(f'{name}: cambió la ruta real de origen')
        inspected = inspect_source(current, red)
        expected_days = inspected['dias']
        if (item['dias'] != expected_days or item['numeroDias'] != len(expected_days)
                or item['replicaJson'] != (inspected['replica'] is not None)
                or item['shaReplica'] != (inspected['replica'].get('sha') if inspected['replica'] else None)
                or item['aliasEnPanel'] != inspected['alias']):
            raise ValueError(f'{name}: inventario o metadatos difieren de la fuente')
        if not stat.S_ISDIR(target.lstat().st_mode) or not stat.S_ISDIR(source.lstat().st_mode):
            raise ValueError(f'{name}: directorio fuente o destino no válido')
        fingerprints = item['huellasArchivos']
        expected_files = {row['archivo'] for row in fingerprints}
        if expected_files != {path.name for path in inspected['archivos']}:
            raise ValueError(f'{name}: archivos declarados difieren de la fuente inspeccionada')
        if len(expected_files) != len(fingerprints) or item['archivosEnlazados'] != len(fingerprints):
            raise ValueError(f'{name}: conteo o nombres duplicados en manifiesto')
        actual_files = {entry.name for entry in os.scandir(target)}
        if actual_files != expected_files:
            raise ValueError(f'{name}: archivos de destino distintos del manifiesto')
        for row in fingerprints:
            filename = row['archivo']
            if filename != 'replica.json' and not DAY_PATTERN.fullmatch(filename):
                raise ValueError(f'{name}: archivo no permitido en manifiesto: {filename}')
            original, linked = source / filename, target / filename
            real_regular_file(original)
            real_regular_file(linked)
            verify_hardlink(original, linked)
            original_stat = original.stat()
            if (original_stat.st_dev, original_stat.st_ino, original_stat.st_size) != (row['dispositivo'], row['inode'], row['bytes']):
                raise ValueError(f'{name}/{filename}: inode o tamaño cambió')
            if sha256(original) != row['sha256'] or sha256(linked) != row['sha256']:
                raise ValueError(f'{name}/{filename}: SHA-256 cambió')
            total += 1
    return {'estado': 'verificado', 'entrada': str(DEST),
            'directoriosReales': len(expected_dirs), 'hardlinksVerificados': total}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--preflight', action='store_true', help='solo inspecciona; nunca crea directorios')
    action.add_argument('--build', action='store_true', help='crea la entrada tras el preflight')
    action.add_argument('--verify', action='store_true', help='revalida manifiesto, SHA-256 e inodes sin escribir')
    parser.add_argument('--permitir-hog-2010-fallo', action='store_true',
                        help='solo preflight/build: admite HOG-2010 rojo acreditado con días 001..024')
    args = parser.parse_args()
    if args.verify and args.permitir_hog_2010_fallo:
        parser.error('--permitir-hog-2010-fallo solo se admite con --preflight o --build')
    if args.verify:
        print(json.dumps(verify(), ensure_ascii=False, indent=2))
        return 0
    if args.preflight:
        try:
            items = preflight(args.permitir_hog_2010_fallo)
        except Exception as exc:
            print(json.dumps({'estado': 'pendiente', 'destino': str(DEST),
                              'destinoExiste': os.path.lexists(DEST), 'motivo': str(exc)},
                             ensure_ascii=False, indent=2))
            return 2
        counts = {arm: sum(item['brazo'] == arm for item in items) for arm in ARMS}
        print(json.dumps({'estado': 'listo', 'destino': str(DEST),
                          'destinoExiste': False, 'entradaRoja': args.permitir_hog_2010_fallo,
                          'directoriosPorBrazo': counts},
                         ensure_ascii=False, indent=2))
        return 0
    items = preflight(args.permitir_hog_2010_fallo)
    count = build(items, args.permitir_hog_2010_fallo)
    print(f'Entrada lista: {DEST} ({count} directorios reales).')
    print(f'Manifiesto: {DEST / "MANIFIESTO.json"}')
    print('Validación: revisar el manifiesto y confirmar que `find ENTRADA -mindepth 1 -maxdepth 1 -type l` no devuelve entradas.')
    print('Tras sincronizar CTRL2, control de regresión: npx tsx scripts/lab/decision-c8-linaje.mts --entrada ENTRADA --corte 20 --salida RUTA_CORTE20; comparar con balance/decision-c8-d20.json: VOC 7/12 DETENER, VOCHOG 7/12 DETENER, HOG 11/12 CONTINUAR.')
    print('Luego salida roja documental: npx tsx scripts/lab/decision-c8-linaje.mts --entrada ENTRADA --corte 60 --salida RUTA_CORTE60')
    print('La salida del evaluador congelado no es un veredicto C8 válido si HOG-2010 está parcial; conservar DATOS_INCOMPLETOS literal si aparece.')
    print('Hardlinks: fuente y entrada comparten inode; mantener ambas en solo lectura y ejecutar --verify antes y después de evaluar.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        print(f'Entrada C8 no preparada: {exc}', file=sys.stderr)
        sys.exit(2)
