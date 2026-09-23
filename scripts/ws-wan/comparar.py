"""Tabla antes/después del banco WS-WAN: une los JSON por escenario de dos corridas de `banco.ts`
(misma etiqueta = mismo ancho de banda, retardo, cámara y modo).

Uso: python3 scripts/ws-wan/comparar.py <dir antes> <dir después> [etiquetas en orden...]
"""
import json
import sys
from pathlib import Path


def cargar(directorio):
    return {p.stem: json.loads(p.read_text()) for p in Path(directorio).glob('*.json')}


def mbps(r):
    e = r.get('enlace', {})
    if 'bajadaMbps' in e:
        return e['bajadaMbps']
    return e.get('bajadaMiB', 0) * 1048576 * 8 / max(1e-9, r.get('duracionS', 1)) / 1e6


def f(n, d=0):
    return '—' if n is None else f'{n:.{d}f}'


def celda(r):
    if r is None:
        return ['—'] * 9
    s = r['servidor']
    gets = ' '.join(('' if g['ok'] else '✗') + f"{g['ms'] / 1000:.1f}s" for g in r['getWorld'])
    return [
        f"{f(r['pctLive'])} %",
        f"{r['silencios8s']}/{r['reconexiones']}",
        f(r['statesPorS'], 2),
        f"{f(r['edadStateMs']['p50'])} / {f(r['edadStateMs']['max'])}",
        f"{s['descartados']}" + (f" · {s.get('aplazados', 0)}" if 'aplazados' in s else ''),
        str(s['cortes2MiB']),
        f(r['kernelSendQKiB']['max']),
        f(mbps(r), 2),
        gets,
    ]


antes, despues = cargar(sys.argv[1]), cargar(sys.argv[2])
orden = sys.argv[3:] or sorted(set(antes) | set(despues))
cols = ['live', 'silencios/reconex.', 'states/s', 'edad state ms p50/máx', 'descartados · aplazados', 'cortes', 'Send-Q máx KiB', 'enlace Mbit/s', 'GET /api/world']
print('| escenario | | ' + ' | '.join(cols) + ' |')
print('|---|---|' + '---|' * len(cols))
for etiqueta in orden:
    for nombre, datos in (('antes', antes), ('después', despues)):
        print(f"| {etiqueta if nombre == 'antes' else ''} | {nombre} | " + ' | '.join(celda(datos.get(etiqueta))) + ' |')
