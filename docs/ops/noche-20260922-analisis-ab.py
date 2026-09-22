#!/usr/bin/env python3
"""Análisis por día emparejado del A/B de ciencia: para cada brazo y semilla, métricas en el día D
(el mayor día alcanzado por TODAS las réplicas comparadas, o --dia fijo). Salida: tabla + JSON."""
import json, glob, os, sys, statistics
D = sys.argv[1] if len(sys.argv) > 1 else '/tmp/claude-1000/-datos-workspaces-personal-AtlasParaIsa/71b6da8a-24fe-445a-abe9-a2469c7538ac/scratchpad/lab-ciencia'
dia_fijo = int(sys.argv[2]) if len(sys.argv) > 2 else None
runs = {}
for d in sorted(glob.glob(f'{D}/*/')):
    name = os.path.basename(d.rstrip('/')); arm, seed = name.rsplit('-', 1)
    days = {}
    for f in sorted(glob.glob(d + 'dia-*.json')):
        j = json.load(open(f)); days[int(os.path.basename(f)[4:7])] = j
    if days: runs.setdefault(arm, {})[seed] = days
seeds = sorted({s for a in runs.values() for s in a})
arms = sorted(runs)
def metrics(j):
    c = j.get('cooperacionAcumuladaPorTipo', {})
    return {'pob': j['poblacion'], 'nac': j['nacimientos'], 'gen': j['generacionesVivas'], 'div': j['diversidadConducta'],
            'ens': c.get('teaching', 0), 'trueque': c.get('trade', 0), 'ayuda': c.get('constructionHelp', 0), 'confl': j.get('conflictosAcumulados', 0),
            'ajeno': j.get('fraccionUsoAjeno', 0), 'varG': j.get('varianzaGenetica', 0), 'muertes': sum(j['muertesPorCausa'].values()), 'sed': j['muertesPorCausa'].get('dehydration', 0)}
out = {}
for seed in seeds:
    avail = [a for a in arms if seed in runs[a]]
    dia = dia_fijo or min(max(runs[a][seed]) for a in avail)
    print(f'\n== semilla {seed} · día {dia} ==')
    print('brazo   pob  nac gen  div   ens trueq ayuda confl ajeno  varG muertes sed')
    for a in avail:
        if dia not in runs[a][seed]: print(f'{a:7} (no llegó al día {dia})'); continue
        m = metrics(runs[a][seed][dia]); out.setdefault(a, {})[seed] = {'dia': dia, **m}
        print(f"{a:7} {m['pob']:4} {m['nac']:4} {m['gen']:3} {m['div']:.3f} {m['ens']:5} {m['trueque']:5} {m['ayuda']:5} {m['confl']:5} {m['ajeno']:.3f} {m['varG']:.4f} {m['muertes']:5} {m['sed']:3}")
print('\n== medias por brazo (semillas comunes) ==')
common = [s for s in seeds if all(s in out.get(a, {}) for a in arms)]
print('semillas comunes:', common)
for a in arms:
    if not common: break
    vals = [out[a][s] for s in common]
    print(f"{a:7} pob {statistics.mean(v['pob'] for v in vals):6.1f} nac {statistics.mean(v['nac'] for v in vals):6.1f} div {statistics.mean(v['div'] for v in vals):.3f} ajeno {statistics.mean(v['ajeno'] for v in vals):.3f} confl {statistics.mean(v['confl'] for v in vals):6.1f} muertes {statistics.mean(v['muertes'] for v in vals):5.1f} minPob {min(v['pob'] for v in vals)}")
json.dump(out, open(f'{D}/analisis-ab.json', 'w'), indent=1)
