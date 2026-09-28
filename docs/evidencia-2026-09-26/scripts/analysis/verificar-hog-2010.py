#!/usr/bin/env python3
"""Acredita el fallo repetido de HOG-2010 sin modificar datos del laboratorio.

Lee los dos parciales y sus logs. Solo crea el JSON de balance indicado abajo;
si ya existe, exige que su contenido sea idéntico para permitir repetir la prueba.
"""

import hashlib
import json
import os
from pathlib import Path
import re


BASE = Path('/datos/tmp-atlas-lab/datos-lab/c8panel')
ARCHIVADO = BASE / 'parciales-20260924/HOG-2010'
NUEVO = BASE / 'HOG-2010'
LOG_ARCHIVADO = BASE / 'parciales-20260924/HOG-2010.log'
LOG_NUEVO = BASE / 'HOG-2010.log'
SALIDA = Path('/datos/tmp-atlas-lab/balance/verificacion-fallo-hog-2010.json')
MENSAJE = 'Invalid contained water state or receipt.'
PATRON_DIA = re.compile(r'dia-(\d{3})\.json\Z')
DIAS_ESPERADOS = list(range(1, 25))
CLAVES_OMITIDAS = {'p50Ms', 'p95Ms', 'rss'}


def sha256(body):
    return hashlib.sha256(body).hexdigest()


def canonico(value):
    if isinstance(value, dict):
        return {key: canonico(item) for key, item in value.items()
                if key not in CLAVES_OMITIDAS and not key.endswith('Ms')}
    if isinstance(value, list):
        return [canonico(item) for item in value]
    return value


def huella_dia(path, day):
    body = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(body, dict) or body.get('tick') != day * 2400:
        raise ValueError(f'{path}: JSON o tick no corresponde al día {day}')
    packed = json.dumps(canonico(body), sort_keys=True, separators=(',', ':')).encode('utf-8')
    return sha256(packed)


def inventario(folder):
    if not folder.is_dir():
        raise FileNotFoundError(f'Falta directorio de réplica: {folder}')
    names = [path.name for path in folder.iterdir() if path.name.startswith('dia-') and path.name.endswith('.json')]
    malformed = sorted(name for name in names if not PATRON_DIA.fullmatch(name))
    days = sorted(int(PATRON_DIA.fullmatch(name).group(1)) for name in names if PATRON_DIA.fullmatch(name))
    return {'dias': days, 'nombresMalFormados': malformed,
            'dia025Ausente': not os.path.lexists(folder / 'dia-025.json'),
            'dia060Ausente': not os.path.lexists(folder / 'dia-060.json'),
            'replicaFinalAusente': not os.path.lexists(folder / 'replica.json')}


def huella_log(path):
    body = path.read_bytes()
    return {'ruta': str(path), 'sha256': sha256(body), 'bytes': len(body),
            'mensajeLiteralPresente': MENSAJE.encode('utf-8') in body}


def verificar():
    old_inventory, new_inventory = inventario(ARCHIVADO), inventario(NUEVO)
    rows = []
    for day in DIAS_ESPERADOS:
        old_path = ARCHIVADO / f'dia-{day:03}.json'
        new_path = NUEVO / f'dia-{day:03}.json'
        if not old_path.is_file() or not new_path.is_file():
            rows.append({'dia': day, 'sha256Archivado': None, 'sha256Nuevo': None,
                         'iguales': False})
            continue
        old_hash, new_hash = huella_dia(old_path, day), huella_dia(new_path, day)
        rows.append({'dia': day, 'sha256Archivado': old_hash, 'sha256Nuevo': new_hash,
                     'iguales': old_hash == new_hash})
    logs = {'archivado': huella_log(LOG_ARCHIVADO), 'nuevo': huella_log(LOG_NUEVO)}
    checks = {
        'conjuntosDiasIguales': old_inventory['dias'] == new_inventory['dias'],
        'ambosExactamenteDias001a024': all(inv['dias'] == DIAS_ESPERADOS and not inv['nombresMalFormados']
                                           for inv in (old_inventory, new_inventory)),
        'diasCanonicos001a024Iguales': all(row['iguales'] for row in rows),
        'ambosSinDia025Dia060NiReplicaFinal': all(inv['dia025Ausente'] and inv['dia060Ausente']
                                                  and inv['replicaFinalAusente']
                                                  for inv in (old_inventory, new_inventory)),
        'ambosLogsConMensajeLiteral': all(log['mensajeLiteralPresente'] for log in logs.values()),
    }
    repeated = all(checks.values())
    return {
        'tipo': 'verificacion_fallo_hog_2010',
        'estado': 'rojo',
        'veredicto': 'fallo_repetido_acreditado' if repeated else 'evidencia_inconsistente',
        'fuentes': {'archivado': str(ARCHIVADO), 'nuevo': str(NUEVO)},
        'normalizacion': 'Quita recursivamente p50Ms, p95Ms, rss y toda clave terminada en Ms; JSON con claves ordenadas y separadores compactos; SHA-256 de UTF-8.',
        'inventarios': {'archivado': old_inventory, 'nuevo': new_inventory},
        'comprobaciones': checks,
        'huellasDias': rows,
        'huellasLogs': logs,
        'advertencia': 'El mensaje genérico no identifica el predicado de validación ni el tick exacto del fallo; la coincidencia de métricas diarias no prueba identidad completa del estado interno.',
    }


def main():
    result = verificar()
    encoded = (json.dumps(result, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    if SALIDA.exists():
        if SALIDA.read_bytes() != encoded:
            raise FileExistsError(f'{SALIDA}: ya existe con contenido distinto; no se sobrescribe')
    else:
        with SALIDA.open('xb') as stream:
            stream.write(encoded)
    print(f'{SALIDA}: {result["veredicto"]}; días iguales={sum(row["iguales"] for row in result["huellasDias"])}/24')
    return 0 if result['veredicto'] == 'fallo_repetido_acreditado' else 2


if __name__ == '__main__':
    raise SystemExit(main())
