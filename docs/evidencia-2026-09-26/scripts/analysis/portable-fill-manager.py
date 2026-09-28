#!/usr/bin/env python3
"""Rellena hasta 19 réplicas del portátil sin intervenir en las ya existentes.

`status` es estrictamente de solo lectura. `run` vive en la torre, se conecta por
SSH y solo lanza semillas CTRLV4-100001+ en el SSD del portátil. Cada intento
queda como INTENCION duradera antes de crear el proceso: si no aparece LANZADA,
el gestor pausa y muestra la semilla para auditoría manual, sin inferir éxito.
Se detiene con
`touch /datos/tmp-atlas-lab/datos-lab/codex-portable-pool-STOP` o codex-FIN;
los hijos quedan intactos. No se inicia automáticamente al importar el módulo.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
import urllib.request


BASE = Path('/datos/tmp-atlas-lab/datos-lab')
REMOTE = 'stev@100.64.0.2'
KEY = Path.home() / '.ssh/id_ed25519'
SSD = '/run/media/stev/datos/atlas-lab'
POOL = f'{SSD}/ctrlv4pool'
TMP = f'{SSD}/tmp'
WORKTREE = f'{SSD}/lab-v4'
SHA = '667454d5e0232885d78c37775d6a5619f516872d'
PARAMS = ('persistencia.cadaTicks=300,limites.teselasActivas=1303552,'
          'limites.chunks=5092,limites.fauna=7821312')
TARGET = 19
FIRST_SEED = 100001
BLOCK = 40
HEADER = 'hora\treplica\testado\tinfo\n'


# Se ejecuta con `python3 -c` al otro lado de SSH. Ningún modo señala procesos.
# status no escribe; reconcile y launch solo afectan a ctrlv4pool en el SSD.
REMOTE_PROGRAM = r'''
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time

SSD = Path('/run/media/stev/datos/atlas-lab')
HOME_LAB = Path('/home/stev/atlas-lab')
POOL = SSD / 'ctrlv4pool'
TMP = SSD / 'tmp'
WORKTREE = SSD / 'lab-v4'
SHA = '667454d5e0232885d78c37775d6a5619f516872d'
PARAMS = ('persistencia.cadaTicks=300,limites.teselasActivas=1303552,'
          'limites.chunks=5092,limites.fauna=7821312')
TARGET = 19
HEADER = 'hora\treplica\testado\tinfo\n'
TSV = POOL / 'codex-ctrlv4pool-portatil-20260927.tsv'
REPLICA = re.compile(r'(?:CTRLV4|CTRL2|PUB2|HOG)-\d+\Z')

def stamp():
    return dt.datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S%z')

def real_file(path):
    return path.is_file() and not path.is_symlink()

def group_alive(pgid):
    # Un zombie no ocupa CPU ni almacén activo; killpg(0) también lo ve.
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            stat = (entry / 'stat').read_text()
            fields = stat[stat.rfind(')') + 2:].split()
            if int(fields[2]) == pgid and fields[0] != 'Z':
                return True
        except (OSError, ValueError, IndexError):
            continue
    return False

def recognized(args):
    if args and args[0].startswith(b'npm exec tsx '):
        args = [os.fsencode(x) for x in shlex.split(os.fsdecode(args[0]))]
    if b'scripts/lab/replica.ts' not in args or b'--salida' not in args:
        return None
    try:
        output = Path(os.fsdecode(args[args.index(b'--salida') + 1]))
    except (ValueError, IndexError):
        return None
    if (not output.is_absolute() or output.parent.parent not in (SSD, HOME_LAB)
            or not REPLICA.fullmatch(output.name)):
        return None
    return output

def proc_groups():
    groups = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        pid = int(entry.name)
        try:
            stat = (entry / 'stat').read_text()
            pgid = int(stat[stat.rfind(')') + 2:].split()[2])
            args = (entry / 'cmdline').read_bytes().split(b'\0')
            output = recognized(args)
        except (OSError, ValueError, IndexError):
            continue
        if output is None:
            continue
        prior = groups.get(pgid)
        if prior and prior[0] != output:
            raise RuntimeError(f'PGID {pgid} contiene dos salidas')
        if prior is None or pid == pgid or (prior[1] != pgid and pid < prior[1]):
            groups[pgid] = (output, pid)
    return groups

def ps_groups():
    rows = subprocess.check_output(['ps', '-eww', '-o', 'pgid=,args='], text=True)
    groups = set()
    for line in rows.splitlines():
        parts = line.strip().split(maxsplit=1)
        if len(parts) != 2 or not parts[0].isdigit() or 'scripts/lab/replica.ts' not in parts[1]:
            continue
        match = re.search(r'--salida\s+(/(?:run/media/stev/datos|home/stev)/atlas-lab/[^\s/]+/((?:CTRLV4|CTRL2|PUB2|HOG)-\d+))(?=\s|$)', parts[1])
        if match:
            groups.add(int(parts[0]))
    return groups

def checked_groups():
    for _ in range(3):
        groups = proc_groups()
        independent = ps_groups()
        if set(groups) == independent:
            return groups
        time.sleep(0.2)
    raise RuntimeError(f'inventarios distintos: proc={sorted(groups)} ps={sorted(independent)}')

def ledger(write=False):
    if not TSV.exists():
        if not write:
            return {}, {}, set(), set(), {}
        if POOL.exists() or POOL.is_symlink():
            if POOL.is_symlink() or not POOL.is_dir():
                raise RuntimeError('pool ausente como directorio regular')
        else:
            POOL.mkdir()
        with TSV.open('x') as file:
            file.write(HEADER)
            file.flush()
            os.fsync(file.fileno())
    if not real_file(TSV):
        raise RuntimeError('TSV no regular')
    lines = TSV.read_text().splitlines()
    if not lines or lines[0] != HEADER.rstrip('\n'):
        raise RuntimeError('cabecera TSV incompatible')
    launched, witnessed, finalized, failed, intentions = {}, {}, set(), set(), {}
    for line in lines[1:]:
        cols = line.split('\t')
        if len(cols) != 4:
            raise RuntimeError('fila TSV malformada')
        name, state, info = cols[1:]
        if name == 'GESTOR':
            continue
        if not re.fullmatch(r'CTRLV4-\d+', name):
            raise RuntimeError('réplica TSV inesperada')
        seed = int(name[7:])
        if state == 'INTENCION':
            expected = f'sha={SHA} params={PARAMS} salida={POOL / name} log={POOL / (name + ".log")}'
            if info != expected or seed in intentions:
                raise RuntimeError(f'INTENCION inválida/duplicada: {name}')
            intentions[seed] = info
        elif state == 'LANZADA':
            pattern = (rf'pid=([1-9]\d*) pgid=\1 worker=([1-9]\d*) sha={SHA} '
                       rf'params={re.escape(PARAMS)} nice=19 afinidad=0-19 '
                       rf'TMPDIR={re.escape(str(TMP))} salida={re.escape(str(POOL / name))}')
            match = re.fullmatch(pattern, info)
            if not match or seed in launched or seed not in intentions:
                raise RuntimeError(f'LANZADA inválida/duplicada: {name}')
            launched[seed] = int(match[1])
        elif state == 'IDENTIDAD':
            match = re.fullmatch(r'dia=([123]) sha256canon=[a-f0-9]{64} tick=(2400|4800|7200)', info)
            if not match or int(match[2]) != int(match[1]) * 2400 or (seed, int(match[1])) in witnessed:
                raise RuntimeError(f'IDENTIDAD inválida/duplicada: {name}')
            witnessed[(seed, int(match[1]))] = info.split(' sha256canon=')[1].split(' ')[0]
        elif state in ('MANIFIESTO_VERIFICADO', 'FALLO'):
            if seed in finalized or seed in failed:
                raise RuntimeError(f'cierre duplicado: {name}')
            (finalized if state == 'MANIFIESTO_VERIFICADO' else failed).add(seed)
        elif state != 'FALLO_LANZAMIENTO':
            raise RuntimeError(f'estado TSV inesperado: {state}')
    if any(seed not in launched for seed, _ in witnessed) or any(seed not in launched for seed in finalized | failed):
        raise RuntimeError('evento sin lanzamiento')
    return launched, witnessed, finalized, failed, intentions

def append(name, state, info=''):
    with TSV.open('a') as file:
        file.write(f'{stamp()}\t{name}\t{state}\t{info}\n')
        file.flush()
        os.fsync(file.fileno())

def canonical(value):
    if isinstance(value, dict):
        return {k: canonical(v) for k, v in value.items()
                if k not in {'p50Ms', 'p95Ms', 'rss'} and not k.endswith('Ms')}
    if isinstance(value, list):
        return [canonical(v) for v in value]
    return value

def fingerprint(day):
    return hashlib.sha256(json.dumps(canonical(day), sort_keys=True,
                       separators=(',', ':')).encode()).hexdigest()

def verify_end(output, seed):
    if output.is_symlink() or not output.is_dir():
        raise ValueError('salida ausente o symlink')
    days = []
    for number in range(1, 61):
        path = output / f'dia-{number:03}.json'
        if not real_file(path):
            raise ValueError(f'día {number} ausente')
        day = json.loads(path.read_text())
        if type(day) is not dict or day.get('tick') != 2400 * number:
            raise ValueError(f'tick día {number} inválido')
        days.append(day)
    path = output / 'replica.json'
    if not real_file(path):
        raise ValueError('manifiesto ausente')
    manifest = json.loads(path.read_text())
    ref_path = SSD / 'ctrlv4c/CTRLV4-6042/replica.json'
    if not real_file(ref_path):
        raise ValueError('referencia CTRLV4-6042 ausente')
    ref = json.loads(ref_path.read_text())
    for key, expected in (('seed', seed), ('dias', 60), ('sha', SHA),
                          ('digest', ref['digest']), ('params', ref['params']),
                          ('metricasVersion', ref['metricasVersion']),
                          ('instrumentos', ref['instrumentos']), ('gobernador', ref['gobernador'])):
        if manifest.get(key) != expected:
            raise ValueError(f'manifiesto {key} incompatible')
    population = days[-1].get('poblacion')
    if not isinstance(manifest.get('resumen'), dict) or manifest['resumen'].get('poblacionFinal') != population:
        raise ValueError('resumen final incompatible')
    log = POOL / f'CTRLV4-{seed}.log'
    ending = f'Réplica completa: 60 día(s), población final {population}. Salida: {output}'
    if not real_file(log) or log.read_text().count(ending) != 1:
        raise ValueError('log sin terminación normal única')
    return hashlib.sha256(path.read_bytes()).hexdigest()

def snapshot():
    groups = checked_groups()
    launched, _, finalized, failed, intentions = ledger()
    active_pool = {output.name for output, _ in groups.values() if output.parent == POOL}
    orphan, unsafe = [], []
    for seed, pgid in launched.items():
        if seed in finalized | failed:
            continue
        name = f'CTRLV4-{seed}'
        if name not in active_pool and group_alive(pgid):
            orphan.append(pgid)
        elif name in active_pool and not attest_group(pgid, POOL / name)[0]:
            unsafe.append(pgid)
    if real_file(TSV):
        for line in TSV.read_text().splitlines()[1:]:
            cols = line.split('\t')
            if len(cols) == 4 and cols[2] == 'FALLO_LANZAMIENTO':
                match = re.fullmatch(r'pid=(\d+) sin acreditar; revisar sin señalar', cols[3])
                if match and group_alive(int(match[1])):
                    orphan.append(int(match[1]))
    info = next(line for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))
    available = int(info.split()[1]) / 2**20
    stat = os.statvfs(SSD)
    disk = stat.f_bavail * stat.f_frsize / 2**30
    used_pool = set(intentions)
    if POOL.is_dir():
        for item in POOL.iterdir():
            match = re.fullmatch(r'CTRLV4-(\d+)(?:\.log)?', item.name)
            if match:
                used_pool.add(int(match[1]))
    return {'fecha': stamp(), 'activas': len(groups), 'objetivo': TARGET,
            'grupos': [{'pgid': pgid, 'replica': output.name, 'salida': str(output)}
                       for pgid, (output, _) in sorted(groups.items())],
            'orphanOwnPGID': sorted(set(orphan)), 'unsafeOwnPGID': sorted(set(unsafe)),
            'memAvailableGiB': round(available, 2),
            'ssdLibreGiB': round(disk, 2), 'lanzadasPool': len(launched),
            'finalesPool': len(finalized), 'fallosPool': len(failed),
            'usedPoolSeeds': sorted(used_pool),
            'pendingIntentions': sorted(set(intentions) - set(launched))}

def preflight():
    if subprocess.check_output(['git', '-C', str(WORKTREE), 'rev-parse', 'HEAD'], text=True).strip() != SHA:
        raise RuntimeError('SHA de lab-v4 incorrecto')
    if subprocess.check_output(['git', '-C', str(WORKTREE), 'status', '--porcelain',
                                '--untracked-files=all'], text=True).strip():
        raise RuntimeError('lab-v4 tiene cambios o archivos no rastreados')
    if not (WORKTREE / 'node_modules/.bin/tsx').is_file():
        raise RuntimeError('tsx ausente')
    if not TMP.is_dir() or TMP.is_symlink() or not os.access(TMP, os.W_OK):
        raise RuntimeError('TMPDIR del SSD ausente')
    if not POOL.is_dir() or POOL.is_symlink():
        raise RuntimeError('pool del SSD ausente o symlink')
    if (SSD / 'ctrlv4c/brazo.txt').read_text().strip() != (
            f'CTRLV4|{PARAMS}|{SHA}|reglas 11 por defecto, sin leyes; control para calibrar la lectura v4 de C8'):
        raise RuntimeError('brazo CTRLV4 incompatible')

def attest_group(pgid, output, correct_priority=False):
    """Acredita raíz tsx y worker Node del grupo propio; nunca toca otros grupos."""
    root, worker = None, None
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        pid = int(entry.name)
        try:
            stat = (entry / 'stat').read_text()
            fields = stat[stat.rfind(')') + 2:].split()
            if int(fields[2]) != pgid or fields[0] == 'Z':
                continue
            args = (entry / 'cmdline').read_bytes()
            if recognized(args.split(b'\0')) != output:
                continue
            if pid == pgid and os.fsencode(str(WORKTREE / 'node_modules/.bin/tsx')) in args:
                root = pid
            elif (pid != pgid and b'/tsx/dist/preflight.cjs' in args
                  and b'/tsx/dist/loader.mjs' in args
                  and Path(os.readlink(entry / 'exe')).name.startswith('node')):
                worker = pid
        except (OSError, ValueError, IndexError):
            continue
    if root is None or worker is None:
        return False, None
    for pid in (root, worker):
        try:
            if correct_priority:
                # ananicy puede reemplazar nice=19 por 16 al nacer un Node.
                os.setpriority(os.PRIO_PROCESS, pid, 19)
            valid = (os.getpriority(os.PRIO_PROCESS, pid) == 19
                     and os.sched_getaffinity(pid) == set(range(20))
                     and os.fsencode(f'TMPDIR={TMP}') + b'\0' in Path(f'/proc/{pid}/environ').read_bytes())
            if not valid:
                return False, worker
        except (OSError, ProcessLookupError):
            return False, worker
    return True, worker

def reconcile():
    groups = checked_groups()
    launched, witnessed, finalized, failed, intentions = ledger(write=True)
    live_pool = {output.name for output, _ in groups.values() if output.parent == POOL}
    for seed, pgid in sorted(launched.items()):
        if seed in finalized | failed:
            continue
        name = f'CTRLV4-{seed}'
        output = POOL / name
        for day in (1, 2, 3):
            if (seed, day) in witnessed:
                continue
            path = output / f'dia-{day:03}.json'
            if not real_file(path):
                continue
            try:
                data = json.loads(path.read_text())
                if type(data) is not dict or data.get('tick') != day * 2400:
                    continue
            except (OSError, ValueError, TypeError):
                continue
            digest = fingerprint(data)
            append(name, 'IDENTIDAD', f'dia={day} sha256canon={digest} tick={day * 2400}')
            witnessed[(seed, day)] = digest
        if name in live_pool:
            attest_group(pgid, output, correct_priority=True)
        if name in live_pool or group_alive(pgid):
            continue
        try:
            if any((seed, day) not in witnessed for day in (1, 2, 3)):
                raise ValueError('faltan testigos días 1–3')
            for day in (1, 2, 3):
                current = json.loads((output / f'dia-{day:03}.json').read_text())
                if witnessed[(seed, day)] != fingerprint(current):
                    raise ValueError(f'identidad día {day} divergente del TSV')
            digest = verify_end(output, seed)
        except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
            append(name, 'FALLO', str(exc).replace('\t', ' '))
        else:
            append(name, 'MANIFIESTO_VERIFICADO', f'sha256={digest}')
    return snapshot()

def launch(seed):
    if POOL.exists() or POOL.is_symlink():
        if POOL.is_symlink() or not POOL.is_dir():
            raise RuntimeError('pool no regular')
    else:
        POOL.mkdir()
    with (POOL / '.portable-fill.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        preflight()
        current = snapshot()
        if (current['activas'] >= TARGET or current['orphanOwnPGID']
                or current['unsafeOwnPGID'] or current['pendingIntentions']):
            return {'lanzada': False, 'motivo': 'cupo, grupo inseguro o intención pendiente', 'estado': current}
        if current['memAvailableGiB'] < 7 or current['ssdLibreGiB'] < 46:
            return {'lanzada': False, 'motivo': 'margen de RAM o SSD', 'estado': current}
        launched, _, _, _, intentions = ledger(write=True)
        name = f'CTRLV4-{seed}'
        output, log_path = POOL / name, POOL / f'{name}.log'
        if (seed in intentions or output.exists() or output.is_symlink()
                or log_path.exists() or log_path.is_symlink()):
            raise RuntimeError(f'semilla/salida/log ya usados: {seed}')
        append(name, 'INTENCION',
               f'sha={SHA} params={PARAMS} salida={output} log={log_path}')
        cmd = [str(WORKTREE / 'node_modules/.bin/tsx'), 'scripts/lab/replica.ts',
               '--seed', str(seed), '--dias', '60', '--params', PARAMS,
               '--salida', str(output)]
        def child_setup():
            os.sched_setaffinity(0, set(range(20)))
            os.nice(19)
        with log_path.open('x') as log:
            child = subprocess.Popen(cmd, cwd=WORKTREE,
                                     env=dict(os.environ, TMPDIR=str(TMP)),
                                     stdin=subprocess.DEVNULL, stdout=log,
                                     stderr=subprocess.STDOUT,
                                     start_new_session=True, preexec_fn=child_setup)
        valid, worker = False, None
        for _ in range(100):
            valid, worker = attest_group(child.pid, output, correct_priority=True)
            if valid or child.poll() is not None:
                break
            time.sleep(0.1)
        if not valid:
            append(name, 'FALLO_LANZAMIENTO', f'pid={child.pid} sin acreditar; revisar sin señalar')
            raise RuntimeError(f'raíz/worker de {child.pid} sin cmdline/nice/CPU/TMPDIR acreditados')
        append(name, 'LANZADA',
               f'pid={child.pid} pgid={child.pid} worker={worker} sha={SHA} params={PARAMS} '
               f'nice=19 afinidad=0-19 TMPDIR={TMP} salida={output}')
        return {'lanzada': True, 'pid': child.pid, 'worker': worker,
                'seed': seed, 'salida': str(output)}

mode = sys.argv[1]
if mode == 'status':
    result = snapshot()
elif mode == 'reconcile':
    result = reconcile()
elif mode == 'launch':
    result = launch(int(sys.argv[2]))
else:
    raise SystemExit(f'modo remoto inválido: {mode}')
print(json.dumps(result, ensure_ascii=False))
'''


def stamp() -> str:
    return dt.datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S%z')


def remote(mode: str, *args: object) -> dict:
    command = shlex.join(['python3', '-c', REMOTE_PROGRAM, mode, *(str(x) for x in args)])
    try:
        process = subprocess.run(
            ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-i', str(KEY),
             REMOTE, command], capture_output=True, text=True, timeout=35)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f'SSH {mode} agotó 35 s: resultado incierto; '
                           'reconciliar INTENCION antes de otro lanzamiento') from exc
    except subprocess.SubprocessError as exc:
        raise RuntimeError(f'SSH {mode} falló: resultado incierto; '
                           'reconciliar INTENCION antes de otro lanzamiento') from exc
    if process.returncode:
        raise RuntimeError(f'SSH {mode} falló ({process.returncode}): {process.stderr.strip()[:500]}')
    return json.loads(process.stdout)


def stop_requested(base: Path) -> bool:
    return (base / 'codex-FIN').exists() or (base / 'codex-portable-pool-STOP').exists()


def public_healthy() -> bool:
    request = urllib.request.Request('http://100.64.0.1:3000/health',
                                     headers={'Host': 'atlas.humanizar.tech'})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status == 200 and json.load(response).get('status') == 'ok'
    except (OSError, ValueError):
        return False


def preregister(base: Path, seed: int) -> None:
    first = FIRST_SEED + (seed - FIRST_SEED) // BLOCK * BLOCK
    marker = f'PORTATIL POOL BLOQUE {first}-{first + BLOCK - 1}'
    with (base / 'bitacora.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        bit = base / 'bitacora.md'
        previous = bit.read_text(encoding='utf-8')
        if marker in previous:
            return
        now = dt.datetime.now().astimezone()
        note = (f'\n## {now:%H:%M} — PRERREGISTRO {marker} ({now:%d-%m})\n'
                f'- Antes del primer lanzamiento declaro CTRLV4-{first}..CTRLV4-{first + BLOCK - 1} '
                'como rango portátil separado del pool secuencial de torre y control '
                f'suplementario descriptivo de T4: 60 días, código congelado {SHA} '
                f'en `{WORKTREE}`, parámetros literales `{PARAMS}`, nice 19, afinidad 0–19, '
                f'TMPDIR `{TMP}`, salida `{POOL}/CTRLV4-<semilla>`; '
                'estos datos no sustituyen los paneles obligatorios de 20 y 40 semillas. '
                f'Hora real {stamp()}.\n')
        with bit.open('a', encoding='utf-8') as output:
            output.write(note)
            output.flush()
            os.fsync(output.fileno())


def status(base: Path) -> dict:
    remote_state = remote('status')
    remote_state['altoSolicitado'] = stop_requested(base)
    return remote_state


def run(base: Path) -> None:
    base = base.resolve(strict=True)
    lock = (base / 'codex-portable-pool.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if not (base / 'bitacora.md').is_file():
        raise RuntimeError('bitácora no regular')
    last_pause = ''
    while not stop_requested(base):
        try:
            state = remote('reconcile')
            reason = ('INTENCION sin LANZADA: auditoría manual requerida' if state['pendingIntentions']
                      else 'orphan propio en portátil' if state['orphanOwnPGID']
                      else 'raíz o worker propio sin acreditar' if state['unsafeOwnPGID']
                      else 'MemAvailable <7 GiB de margen para suelo 4 GiB'
                      if state['memAvailableGiB'] < 7
                      else 'SSD <46 GiB de margen para suelo 40 GiB'
                      if state['ssdLibreGiB'] < 46
                      else 'público sin health ok' if not public_healthy() else '')
            while state['activas'] < TARGET and not reason and not stop_requested(base):
                if not public_healthy():
                    reason = 'público sin health ok antes del lanzamiento'
                    break
                # La contabilidad remota y el disco deciden la próxima semilla.
                # Un bloque preregistrado contiene reservas, no lanzamientos.
                used = set(state['usedPoolSeeds'])
                seed = next(s for s in range(FIRST_SEED, max(used | {FIRST_SEED}) + 2)
                            if s not in used)
                preregister(base, seed)
                result = remote('launch', seed)
                if not result['lanzada']:
                    reason = result['motivo']
                    break
                print(json.dumps({'hora': stamp(), **result}, ensure_ascii=False), flush=True)
                state = remote('reconcile')
                if (state['memAvailableGiB'] < 7 or state['ssdLibreGiB'] < 46
                        or state['orphanOwnPGID'] or state['unsafeOwnPGID']
                        or state['pendingIntentions']):
                    reason = 'margen, huérfano o INTENCION pendiente tras lanzamiento'
            if reason != last_pause:
                if reason:
                    print(json.dumps({'hora': stamp(), 'pausa': reason, 'estado': state},
                                     ensure_ascii=False), flush=True)
                last_pause = reason
        except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
            print(json.dumps({'hora': stamp(), 'pausa': str(exc)}, ensure_ascii=False),
                  file=sys.stderr, flush=True)
            time.sleep(10)
            continue
        time.sleep(10)
    print(json.dumps({'hora': stamp(), 'detenido': 'codex-FIN o codex-portable-pool-STOP; hijos intactos'},
                     ensure_ascii=False), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('status', 'run'))
    parser.add_argument('--base', type=Path, default=BASE)
    args = parser.parse_args()
    if args.mode == 'status':
        print(json.dumps(status(args.base.resolve(strict=True)), ensure_ascii=False, indent=2))
    else:
        run(args.base)
    return 0


if __name__ == '__main__':
    sys.exit(main())
