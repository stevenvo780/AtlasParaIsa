#!/usr/bin/env python3
"""Página de estado de la noche (solo lectura, LAN). Sin secretos: journal del workflow,
réplicas del laboratorio, worktrees, carga y bitácora. Puerto 8790."""
import html, json, os, subprocess, time, glob
from http.server import HTTPServer, BaseHTTPRequestHandler

SP = os.path.dirname(os.path.abspath(__file__))
WF = '/home/stev/.claude/projects/-datos-workspaces-personal-AtlasParaIsa/71b6da8a-24fe-445a-abe9-a2469c7538ac/subagents/workflows/wf_e404d699-7fb/journal.jsonl'
WT_ROOT = '/datos/workspaces/personal'
MAIN = f'{WT_ROOT}/AtlasParaIsa'
LAB_DIRS = [f'{SP}/lab-gob-25d', f'{SP}/lab-ciencia']

def sh(cmd, cwd=None):
    try: return subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, timeout=20).stdout.strip()
    except Exception as e: return f'error: {e}'

keymap = {}
def workflow2():
    rows = {}
    if not os.path.exists(WF): return rows
    for line in open(WF, encoding='utf-8'):
        try: d = json.loads(line)
        except Exception: continue
        if d.get('type') == 'started':
            keymap[d.get('key')] = d['label']; rows[d['label']] = {'label': d['label'], 'estado': 'en curso', 'detalle': ''}
        elif d.get('type') == 'result':
            lab = keymap.get(d.get('key'), d.get('label', '?')); r = d.get('result')
            if isinstance(r, dict):
                if 'approved' in r: est = 'APROBADA' if r['approved'] else 'NO aprobada'; det = (r.get('summary') or '')[:500]
                else: est = r.get('status', '?'); det = f"commit {str(r.get('commit',''))[:9]} · tests {'ok' if r.get('testsPassed') else 'NO'} · {(r.get('notes') or '')[:400]}"
            else: est, det = 'sin resultado (null)', ''
            rows[lab] = {'label': lab, 'estado': est, 'detalle': det}
    return rows

def lab():
    out = []
    for base in LAB_DIRS:
        for d in sorted(glob.glob(f'{base}/*/')):
            log = os.path.join(d, 'log.txt'); last = ''
            if os.path.exists(log):
                lines = [l for l in open(log, encoding='utf-8', errors='replace') if l.startswith('dia')]
                last = lines[-1].strip() if lines else '(sin días aún)'
            fin = os.path.exists(os.path.join(d, 'replica.json'))
            out.append({'grupo': os.path.basename(base), 'replica': os.path.basename(d.rstrip('/')), 'ultimo': last, 'terminada': fin})
    return out

def worktrees():
    out = []
    for d in sorted(glob.glob(f'{WT_ROOT}/AtlasParaIsa-n-*')):
        n = sh('git log --oneline main..HEAD | wc -l', d); dirty = sh('git status --short | wc -l', d)
        last = sh('git log -1 --format="%h %cr · %s"', d)
        out.append({'wt': os.path.basename(d), 'commits': n, 'dirty': dirty, 'ultimo': last})
    return out

def replica_page(grupo, nombre):
    e = html.escape
    base = next((b for b in LAB_DIRS if os.path.basename(b) == grupo), None)
    if not base: return '<p>grupo desconocido</p>'
    d = os.path.join(base, nombre)
    files = sorted(glob.glob(os.path.join(d, 'dia-*.json')))
    keys = ['dia', 'poblacion', 'mortales', 'vecinosMortales', 'nacimientos', 'nacimientosDia', 'muertesDia', 'generacionesVivas', 'reproduccionActivaFraccion', 'techo', 'diversidadConducta', 'diversidadOficios', 'cooperaciones', 'conflictosAcumulados', 'fraccionUsoAjeno', 'varianzaGenetica', 'comunidades', 'p95Ms']
    rows = []
    for f in files:
        try: j = json.load(open(f, encoding='utf-8'))
        except Exception: continue
        j.setdefault('dia', int(os.path.basename(f)[4:7]))
        rows.append(j)
    present = [k for k in keys if any(k in r for r in rows)]
    h = [f'<!doctype html><html lang="es"><head><meta charset="utf-8"><meta http-equiv="refresh" content="60"><title>{e(nombre)}</title><style>body{{font:13px/1.4 system-ui,sans-serif;margin:16px;background:#111;color:#ddd}}table{{border-collapse:collapse}}td,th{{border:1px solid #333;padding:3px 6px;text-align:right}}th{{background:#222}}a{{color:#9cf}}</style></head><body><p><a href="/">← estado</a></p><h1>{e(grupo)} / {e(nombre)}</h1><table><tr>' + ''.join(f'<th>{e(k)}</th>' for k in present) + '</tr>']
    for r in rows:
        cells = []
        for k in present:
            v = r.get(k, '')
            if isinstance(v, float): v = f'{v:.3f}'
            elif isinstance(v, (dict, list)): v = json.dumps(v, ensure_ascii=False)[:60]
            cells.append(f'<td>{e(str(v))}</td>')
        h.append('<tr>' + ''.join(cells) + '</tr>')
    h.append('</table></body></html>')
    return ''.join(h)

def page():
    load = open('/proc/loadavg').read().split()[:3]
    wf = workflow2(); l = lab(); w = worktrees()
    bit = open(f'{SP}/bitacora.md', encoding='utf-8').read() if os.path.exists(f'{SP}/bitacora.md') else ''
    plan = open(f'{SP}/PLAN-NOCHE.md', encoding='utf-8').read() if os.path.exists(f'{SP}/PLAN-NOCHE.md') else ''
    e = html.escape
    h = [f'<!doctype html><html lang="es"><head><meta charset="utf-8"><meta http-equiv="refresh" content="30"><title>Atlas · noche</title>',
         '<style>body{font:14px/1.4 system-ui,sans-serif;margin:16px;background:#111;color:#ddd}table{border-collapse:collapse;margin:8px 0 20px}td,th{border:1px solid #333;padding:4px 8px;text-align:left;vertical-align:top}th{background:#222}h2{margin-top:28px}pre{white-space:pre-wrap;background:#181818;padding:10px;border:1px solid #333}.ok{color:#8c8}.bad{color:#e88}.run{color:#cc8}</style></head><body>',
         f'<h1>Una Carta Para Isa · estado de la noche</h1><p>{e(time.strftime("%Y-%m-%d %H:%M:%S"))} · carga {e(" ".join(load))} · se refresca cada 30 s</p>']
    h.append('<h2>Workflow Etapa A (implementar → revisar → corregir)</h2><table><tr><th>Agente</th><th>Estado</th><th>Detalle</th></tr>')
    for r in wf.values():
        cls = 'ok' if r['estado'] in ('done', 'APROBADA', 'approved') else 'bad' if r['estado'] in ('blocked', 'NO aprobada') else 'run'
        h.append(f'<tr><td>{e(r["label"])}</td><td class="{cls}">{e(r["estado"])}</td><td>{e(r["detalle"])}</td></tr>')
    h.append('</table><h2>Laboratorio (réplicas en marcha)</h2><table><tr><th>Grupo</th><th>Réplica</th><th>Último día</th><th>Fin</th></tr>')
    for r in l: h.append(f'<tr><td>{e(r["grupo"])}</td><td><a href="/replica/{e(r["grupo"])}/{e(r["replica"])}" style="color:#9cf">{e(r["replica"])}</a></td><td>{e(r["ultimo"])}</td><td>{"sí" if r["terminada"] else ""}</td></tr>')
    h.append('</table><h2>Worktrees</h2><table><tr><th>Worktree</th><th>Commits sobre main</th><th>Ficheros sucios</th><th>Último commit</th></tr>')
    for r in w: h.append(f'<tr><td>{e(r["wt"])}</td><td>{e(r["commits"])}</td><td>{e(r["dirty"])}</td><td>{e(r["ultimo"])}</td></tr>')
    h.append(f'</table><h2>Bitácora</h2><pre>{e(bit)}</pre><h2>Plan</h2><pre>{e(plan)}</pre></body></html>')
    return ''.join(h)

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.startswith('/replica/'):
            parts = self.path.split('/')
            body = replica_page(parts[2], parts[3].split('?')[0]).encode() if len(parts) >= 4 else b'?'; ct = 'text/html; charset=utf-8'
        elif self.path.startswith('/api'):
            body = json.dumps({'workflow': workflow2(), 'lab': lab(), 'worktrees': worktrees(), 'load': open('/proc/loadavg').read().split()[:3]}, ensure_ascii=False).encode()
            ct = 'application/json; charset=utf-8'
        else: body = page().encode(); ct = 'text/html; charset=utf-8'
        self.send_response(200); self.send_header('Content-Type', ct); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)

if __name__ == '__main__':
    import sys
    HTTPServer(('0.0.0.0', int(sys.argv[1]) if len(sys.argv) > 1 else 8790), H).serve_forever()
