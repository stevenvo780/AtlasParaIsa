#!/usr/bin/env python3
"""Acredita procedencia e identidad de relanzadas de torre, sin escribir datos.

Una corrida parcial es válida si sus días presentes son consecutivos y coinciden
con todos los días históricos disponibles. Solo ``estado=completo`` acredita los
60 días y el manifiesto final de cada réplica.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import stat


SHA = 'd2ebf11d51c3221477d88c7045faeafa2a229683'
DIGEST = '63d4fc53b1a4c92e9c10bebed763958183ac22f246d8af744ba6a6ebfc840f0a'
PARAMS_SHA = '3d7a05d5d1d2ee6ee0ee6feaeb18bbc8a2599db1b64c7365a6569bfec7e43b36'
HEDGE_LAST = {
    'CTRL2-2002': 36, 'CTRL2-2004': 38, 'CTRL2-2006': 44,
    'CTRL2-2007': 36, 'CTRL2-2008': 46, 'CTRL2-2009': 39,
    'CTRL2-2010': 36, 'CTRL2-2011': 51, 'CTRL2-2012': 31,
    'PUB2-5': 33, 'PUB2-29': 35, 'PUB2-101': 33,
    'PUB2-202': 45, 'PUB2-404': 47,
}
PUB2_LAST = {'PUB2-606': 35, 'PUB2-707': 36}
DAY_RE = re.compile(r'dia-(\d{3})\.json\Z')
IDENTITY_RE = re.compile(r'dia=([123]) sha256canon=([0-9a-f]{64}) tick=(2400|4800|7200)\Z')
LAUNCH_COMMON = ('params=persistencia.cadaTicks=300,limites.teselasActivas=1303552,'
                 'limites.chunks=5092,limites.fauna=7821312')


def _real_dir(path: Path) -> None:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError as exc:
        raise ValueError(f'Directorio ausente: {path}') from exc
    if not stat.S_ISDIR(mode):
        raise ValueError(f'Directorio no regular o symlink: {path}')


def _real_file(path: Path) -> None:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError as exc:
        raise ValueError(f'Archivo ausente: {path}') from exc
    if not stat.S_ISREG(mode):
        raise ValueError(f'Archivo no regular o symlink: {path}')


def _canonical(value):
    if isinstance(value, dict):
        return {key: _canonical(item) for key, item in value.items()
                if key not in {'p50Ms', 'p95Ms', 'rss'} and not key.endswith('Ms')}
    if isinstance(value, list):
        return [_canonical(item) for item in value]
    return value


def _fingerprint(path: Path, day: int) -> str:
    _real_file(path)
    body = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(body, dict) or type(body.get('tick')) is not int or body['tick'] != day * 2400:
        raise ValueError(f'Tick/JSON inválido: {path}')
    packed = json.dumps(_canonical(body), sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(packed).hexdigest()


def _days(folder: Path, allow_manifest: bool) -> dict[int, Path]:
    _real_dir(folder)
    days = {}
    for path in folder.iterdir():
        if allow_manifest and path.name == 'replica.json':
            _real_file(path)
            continue
        match = DAY_RE.fullmatch(path.name)
        if not match:
            raise ValueError(f'Entrada inesperada en {folder}: {path.name}')
        _real_file(path)
        day = int(match.group(1))
        if not 1 <= day <= 60 or day in days:
            raise ValueError(f'Día duplicado o fuera de rango: {path}')
        days[day] = path
    if sorted(days) != list(range(1, max(days, default=0) + 1)):
        raise ValueError(f'Días con huecos: {folder}')
    return days


def _manifest(folder: Path, name: str) -> str | None:
    path = folder / 'replica.json'
    if not path.exists() and not path.is_symlink():
        return None
    _real_file(path)
    raw = path.read_bytes()
    meta = json.loads(raw)
    if not isinstance(meta, dict):
        raise ValueError(f'Manifiesto no objeto: {path}')
    params = meta.get('params')
    if not isinstance(params, dict):
        raise ValueError(f'Parámetros ausentes: {path}')
    params_hash = hashlib.sha256(json.dumps(params, ensure_ascii=False, sort_keys=True,
                                           separators=(',', ':')).encode()).hexdigest()
    final_digest = meta.get('digestoMundoFinal')
    if (type(meta.get('seed')) is not int or meta['seed'] != int(name.split('-')[1])
            or type(meta.get('dias')) is not int or meta['dias'] != 60
            or meta.get('sha') != SHA or meta.get('digest') != DIGEST
            or params_hash != PARAMS_SHA or not isinstance(final_digest, str)
            or not re.fullmatch(r'[0-9a-f]{64}', final_digest)):
        raise ValueError(f'Manifiesto distinto del contrato congelado: {path}')
    return hashlib.sha256(raw).hexdigest()


def _events(path: Path, expected: set[str], launch_state: str, root: Path) -> dict[str, dict]:
    _real_file(path)
    lines = path.read_text(encoding='utf-8').splitlines()
    if not lines or lines[0] != 'hora\treplica\testado\tinfo':
        raise ValueError(f'Cabecera TSV inválida: {path}')
    rows = {name: {'launch': None, 'identities': {}, 'manifest_verified': None} for name in expected}
    for line in lines[1:]:
        parts = line.split('\t')
        if len(parts) != 4:
            raise ValueError(f'Fila TSV mal formada: {path}: {line}')
        _, name, state, info = parts
        if name not in rows:
            raise ValueError(f'Réplica ajena en TSV: {name}')
        row = rows[name]
        if state == launch_state:
            if row['launch'] is not None or f'sha={SHA}' not in info or LAUNCH_COMMON not in info:
                raise ValueError(f'Lanzamiento duplicado o distinto: {name}')
            if launch_state == 'LANZADA' and (f'salida={root / name}' not in info
                                                or ' nice=19 ' not in info
                                                or ' TMPDIR=/datos/tmp-atlas-lab ' not in info):
                raise ValueError(f'Ruta/entorno de lanzamiento hedge distinto: {name}')
            row['launch'] = info
        elif state == 'IDENTIDAD':
            match = IDENTITY_RE.fullmatch(info)
            if not match:
                raise ValueError(f'Identidad TSV inválida: {name} {info}')
            day, digest, tick = int(match.group(1)), match.group(2), int(match.group(3))
            if tick != day * 2400 or day in row['identities']:
                raise ValueError(f'Identidad duplicada o tick incorrecto: {name} día {day}')
            row['identities'][day] = digest
        elif state == 'MANIFIESTO_VERIFICADO' and launch_state == 'LANZADA_VERIFICADA':
            if row['manifest_verified'] is not None or not re.fullmatch(r'sha256manifest=[0-9a-f]{64}', info):
                raise ValueError(f'Manifiesto verificado duplicado: {name}')
            row['manifest_verified'] = info.split('=', 1)[1]
        else:
            raise ValueError(f'Estado TSV inesperado: {name} {state}')
    for name, row in rows.items():
        if row['launch'] is None or set(row['identities']) != {1, 2, 3}:
            raise ValueError(f'Faltan lanzamiento o tres identidades TSV: {name}')
    return rows


def _verify(base: Path, relative: str, last_days: dict[str, int], log_name: str,
            launch_state: str, require_manifest_event: bool = False) -> dict:
    root = base / relative
    archive_root = root / 'parciales-20260924'
    _real_dir(root)
    _real_dir(archive_root)
    rows = _events(root / log_name, set(last_days), launch_state, root)
    result = []
    for name, last in last_days.items():
        archived = _days(archive_root / name, False)
        current = _days(root / name, True)
        if sorted(archived) != list(range(1, last + 1)):
            raise ValueError(f'Archivo histórico incompleto o excedido: {name}')
        if not {1, 2, 3}.issubset(current):
            raise ValueError(f'Faltan días 1–3 actuales: {name}')
        current_hashes = {day: _fingerprint(path, day) for day, path in current.items()}
        common = sorted(archived.keys() & current.keys())
        for day in common:
            old_hash = _fingerprint(archived[day], day)
            new_hash = current_hashes[day]
            if old_hash != new_hash:
                raise ValueError(f'Solape divergente: {name} día {day}')
        for day in (1, 2, 3):
            if rows[name]['identities'][day] != current_hashes[day]:
                raise ValueError(f'Identidad TSV divergente: {name} día {day}')
        manifest = _manifest(root / name, name)
        complete = sorted(current) == list(range(1, 61)) and manifest and len(common) == last
        if rows[name]['manifest_verified'] is not None and (not complete or rows[name]['manifest_verified'] != manifest):
            raise ValueError(f'TSV afirma manifiesto inexistente o SHA distinto: {name}')
        if complete and require_manifest_event and rows[name]['manifest_verified'] is None:
            raise ValueError(f'Falta MANIFIESTO_VERIFICADO en TSV: {name}')
        result.append({'replica': name, 'diasActuales': len(current), 'diasArchivados': last,
                       'solapesComparados': len(common), 'manifiesto': bool(manifest),
                       'estado': 'completo' if complete else 'parcial'})
    return {'tipo': 'procedencia_torre', 'raiz': str(root),
            'estado': 'completo' if all(row['estado'] == 'completo' for row in result) else 'parcial',
            'replicas': result, 'identidadesTSV': len(result) * 3,
            'solapesComparados': sum(row['solapesComparados'] for row in result)}


def verify_hedge(base: Path, require_complete: bool = False) -> dict:
    """Valida 14 copias hedge; admite avance parcial, jamás divergencia."""
    result = _verify(Path(base), 'hedge-torre-20260926', HEDGE_LAST,
                     'codex-hedge-torre-20260926.tsv', 'LANZADA')
    if require_complete and result['estado'] != 'completo':
        raise ValueError('Las 14 copias hedge aún no tienen 60 días, manifiesto y solapes completos')
    return result


def verify_pub2_tower(base: Path, require_complete: bool = False,
                      require_manifest_event: bool = True) -> dict:
    """Valida PUB2-606/707; cierre exige evento real tras el manifiesto.

    Para prevalidar antes de añadir el evento usar ``require_complete=True,
    require_manifest_event=False`` y volver a validar con el valor por defecto
    después de registrar MANIFIESTO_VERIFICADO.
    """
    result = _verify(Path(base), 'f21b-torre', PUB2_LAST,
                     'codex-pub2-torre-20260926.tsv', 'LANZADA_VERIFICADA', require_manifest_event)
    if require_complete and result['estado'] != 'completo':
        raise ValueError('PUB2-606/707 aún no tienen 60 días, manifiesto y solapes completos')
    return result


def verify_laptop(base: Path, balance: Path, require_complete: bool = True) -> dict:
    """Valida las 14 relanzadas originales y su gestor interrumpido real.

    La ausencia de FIN/COMPLETA es parte del contrato histórico. No se infiere
    finalización del gestor: solo 60 JSON, manifiesto y todos los solapes prueban
    el cierre de cada hijo independiente.
    """
    base, balance = Path(base), Path(balance)
    log = balance / 'codex-laptop-20260926.tsv'
    _real_file(log)
    lines = log.read_text(encoding='utf-8').splitlines()
    if not lines or lines[0] != 'hora\treplica\testado\tinfo':
        raise ValueError(f'Cabecera TSV inválida: {log}')
    rows = {name: {'launch': None, 'identities': {}} for name in HEDGE_LAST}
    starts = 0
    identity_re = re.compile(r'día=([123]) sha256=([0-9a-f]{64})\Z')
    for line in lines[1:]:
        parts = line.split('\t')
        if len(parts) != 4:
            raise ValueError(f'Fila TSV mal formada: {log}: {line}')
        _, name, state, info = parts
        if (name, state, info) == ('GESTOR', 'INICIO', 'perfil=laptop jobs=16 concurrencia=14'):
            starts += 1
            continue
        if name not in rows:
            raise ValueError(f'Evento ajeno en gestor interrumpido: {name} {state}')
        row = rows[name]
        if state == 'LANZADA':
            if row['launch'] is not None or not re.fullmatch(r'pid=\d+ sha=d2ebf11', info):
                raise ValueError(f'Lanzamiento portátil duplicado o distinto: {name}')
            row['launch'] = info
        elif state == 'IDENTIDAD':
            match = identity_re.fullmatch(info)
            if not match or int(match.group(1)) in row['identities']:
                raise ValueError(f'Identidad portátil duplicada o distinta: {name}')
            row['identities'][int(match.group(1))] = match.group(2)
        else:
            raise ValueError(f'Estado inesperado en gestor interrumpido: {name} {state}')
    if starts != 1 or any(row['launch'] is None or set(row['identities']) != {1, 2, 3}
                          for row in rows.values()):
        raise ValueError('Bitácora portátil no acredita exactamente 14 lanzamientos y 42 identidades')
    result = []
    for name, last in HEDGE_LAST.items():
        root = base / ('c8panel/portatil' if name.startswith('CTRL2-') else 'f21b-portatil')
        _real_dir(root)
        archive_root = root / 'parciales-20260924'
        _real_dir(archive_root)
        old = _days(archive_root / name, False)
        new = _days(root / name, True)
        if sorted(old) != list(range(1, last + 1)) or not {1, 2, 3}.issubset(new):
            raise ValueError(f'Archivo histórico o días 1–3 incompletos: {name}')
        hashes = {day: _fingerprint(path, day) for day, path in new.items()}
        common = sorted(old.keys() & new.keys())
        for day in common:
            if _fingerprint(old[day], day) != hashes[day]:
                raise ValueError(f'Solape portátil divergente: {name} día {day}')
        for day in (1, 2, 3):
            if rows[name]['identities'][day] != hashes[day]:
                raise ValueError(f'TSV portátil divergente: {name} día {day}')
        manifest = _manifest(root / name, name)
        complete = sorted(new) == list(range(1, 61)) and bool(manifest) and len(common) == last
        result.append({'replica': name, 'diasActuales': len(new), 'diasArchivados': last,
                       'solapesComparados': len(common), 'manifiesto': bool(manifest),
                       'estado': 'completo' if complete else 'parcial'})
    outcome = {'tipo': 'procedencia_portatil_interrumpido', 'raiz': str(base),
               'estado': 'completo' if all(row['estado'] == 'completo' for row in result) else 'parcial',
               'replicas': result, 'identidadesTSV': 42,
               'solapesComparados': sum(row['solapesComparados'] for row in result)}
    if require_complete and outcome['estado'] != 'completo':
        raise ValueError('Las 14 relanzadas del portátil aún no tienen 60 días, manifiesto y solapes completos')
    return outcome
