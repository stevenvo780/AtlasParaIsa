"""Tabla antes/después del navegador real (`navegador.ts`): lo que ve Steven en pantalla.

Uso: python3 scripts/ws-wan/comparar-navegador.py <dir antes> <dir después>
"""
import json
import sys
from pathlib import Path


def cargar(d):
    return {p.stem: json.loads(p.read_text()) for p in Path(d).glob('nav-*.json')}


antes, despues = cargar(sys.argv[1]), cargar(sys.argv[2])
print('| escenario | | live | «Sin conexión» | «Conectando» | WS abiertos | states/s | state KiB p50 | enlace Mbit/s | GET /api/world |')
print('|---|---|---|---|---|---|---|---|---|---|')
for etiqueta in sorted(set(antes) | set(despues), key=lambda e: (e.split('-')[1] != 'lanM', -float(e.split('-')[1][:-1]) if e.split('-')[1] != 'lanM' else 0, e)):
    for nombre, datos in (('antes', antes), ('después', despues)):
        r = datos.get(etiqueta)
        if not r:
            print(f"| {etiqueta if nombre == 'antes' else ''} | {nombre} | — | — | — | — | — | — | — | — |")
            continue
        pct = r['pctPorAviso']
        gets = ' '.join((f"{h['ms'] / 1000:.1f}s" if 'fallo' not in h or not h['fallo'] else f"✗{h['ms'] / 1000:.1f}s") for h in r['http'] if h['url'].startswith('/api/world'))
        mbps = r['enlaceMiB'] * 1048576 * 8 / r['duracionS'] / 1e6
        print(f"| {etiqueta if nombre == 'antes' else ''} | {nombre} | {pct.get('live', 0):.0f} % | {pct.get('sin-conexion', 0):.0f} % | {pct.get('conectando', 0):.0f} % | {r['wsAbiertos']} | {r['statesPorS']:.2f} | {r['stateKiBp50'] or 0:.0f} | {mbps:.2f} | {gets} |")
