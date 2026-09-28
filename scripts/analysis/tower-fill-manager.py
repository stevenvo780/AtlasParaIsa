#!/usr/bin/env python3
"""Mantiene 22 réplicas propias de torre. No se ejecuta automáticamente.

Uso: python3 scripts/analysis/tower-fill-manager.py status|run [--base RUTA]
`status` es solo lectura. Iniciar `run` únicamente después de que el operador
termine la tanda manual 6066–6105 y su registro en bitacora.md.
`touch <base>/codex-pool-STOP` detiene nuevos lanzamientos sin señalar procesos.
"""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import select
import shlex
import subprocess
import sys
import time
import urllib.request


BASE = Path('/datos/tmp-atlas-lab/datos-lab')
WORKTREE = Path('/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/lab-v4')
SHA = '667454d5e0232885d78c37775d6a5619f516872d'
PARAMS = ('persistencia.cadaTicks=300,limites.teselasActivas=1303552,'
          'limites.chunks=5092,limites.fauna=7821312')
BRAZO = f'CTRLV4|{PARAMS}|{SHA}|reglas 11 por defecto, sin leyes; control para calibrar la lectura v4 de C8'
CPU = set(range(6, 32))
OWN_CAMPAIGNS = ('ctrlv4b', 'ctrlv4d-torre', 'ctrlv4e', 'ctrlv4f',
                 'ctrlv4pool', 'f21b-torre', 'hedge-torre-20260926')
HEADER = 'hora\treplica\testado\tinfo\n'
TARGET = 22


def stamp() -> str:
    return dt.datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S%z')


def available_gib() -> float:
    line = next(x for x in Path('/proc/meminfo').read_text().splitlines()
                if x.startswith('MemAvailable:'))
    return int(line.split()[1]) / 2**20


def disk_gib(path: Path) -> float:
    s = os.statvfs(path)
    return s.f_bavail * s.f_frsize / 2**30


def healthy() -> bool:
    request = urllib.request.Request('http://100.64.0.1:3000/health',
                                     headers={'Host': 'atlas.humanizar.tech'})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status == 200 and json.load(response).get('status') == 'ok'
    except (OSError, ValueError):
        return False


def real_file(path: Path) -> bool:
    return path.is_file() and not path.is_symlink()


def canonical(value):
    if isinstance(value, dict):
        return {k: canonical(v) for k, v in value.items()
                if k not in {'p50Ms', 'p95Ms', 'rss'} and not k.endswith('Ms')}
    if isinstance(value, list):
        return [canonical(v) for v in value]
    return value


def fingerprint(day: dict) -> str:
    body = json.dumps(canonical(day), sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(body).hexdigest()


def read_proc(pid: int, proc_root: Path = Path('/proc')) -> tuple[int, bytes] | None:
    try:
        stat = (proc_root / str(pid) / 'stat').read_text()
        pgid = int(stat[stat.rfind(')') + 2:].split()[2])
        cmd = (proc_root / str(pid) / 'cmdline').read_bytes()
        return pgid, cmd
    except (OSError, ValueError, IndexError):
        return None


def command_output(cmdline: bytes) -> Path | None:
    args = cmdline.split(b'\0')
    if args and args[0].startswith(b'npm exec tsx '):
        args = [os.fsencode(x) for x in shlex.split(os.fsdecode(args[0]))]
    if b'scripts/lab/replica.ts' not in args or b'--salida' not in args:
        return None
    try:
        return Path(os.fsdecode(args[args.index(b'--salida') + 1]))
    except (IndexError, ValueError):
        return None


def roots(base: Path, proc_root: Path = Path('/proc')) -> dict[int, tuple[int, Path]]:
    """Una plaza por PGID propio, incluso si murió su líder y queda un worker."""
    groups: dict[int, tuple[int, Path, int]] = {}
    for entry in proc_root.iterdir():
        if not entry.name.isdecimal():
            continue
        pid = int(entry.name)
        proc = read_proc(pid, proc_root)
        if proc is None:
            continue
        pgid = proc[0]
        output = command_output(proc[1])
        if output is None:
            continue
        if (output.parent.parent != base or output.parent.name not in OWN_CAMPAIGNS
                or not re.fullmatch(r'(?:CTRLV4|PUB2|HOG)-\d+', output.name)):
            continue
        seed = int(output.name.rsplit('-', 1)[1])
        previous = groups.get(pgid)
        if previous and previous[1] != output:
            raise RuntimeError(f'PGID {pgid} contiene dos salidas propias distintas')
        # Elegir líder vivo; si no existe, elegir el worker de menor PID.
        if previous is None or pid == pgid or (previous[2] != pgid and pid < previous[2]):
            groups[pgid] = (seed, output, pid)
    return {rep: (seed, output) for seed, output, rep in groups.values()}


def independent_roots(base: Path) -> set[int]:
    """Segundo inventario vía ps; si discrepa, no se lanza nada."""
    rows = subprocess.check_output(['ps', '-eww', '-o', 'pid=,pgid=,args='], text=True)
    groups: dict[int, tuple[Path, int]] = {}
    for line in rows.splitlines():
        fields = line.strip().split(maxsplit=2)
        if len(fields) != 3 or not fields[0].isdigit() or not fields[1].isdigit():
            continue
        pid, pgid = int(fields[0]), int(fields[1])
        match = re.search(r'--salida\s+(/datos/tmp-atlas-lab/datos-lab/([^\s/]+)/((?:CTRLV4|PUB2|HOG)-\d+))(?=\s|$)', fields[2])
        if (match and Path(match[1]).parent.parent == base
                and match[2] in OWN_CAMPAIGNS and 'scripts/lab/replica.ts' in fields[2]):
            output = Path(match[1])
            previous = groups.get(pgid)
            if previous and previous[0] != output:
                raise RuntimeError(f'ps: PGID {pgid} contiene dos salidas propias distintas')
            if previous is None or pid == pgid or (previous[1] != pgid and pid < previous[1]):
                groups[pgid] = (output, pid)
    return {rep for _, rep in groups.values()}


def checked_roots(base: Path) -> dict[int, tuple[int, Path]]:
    for _ in range(3):
        live = roots(base)
        independent = independent_roots(base)
        if set(live) == independent:
            return live
        time.sleep(0.2)  # una terminación entre dos lecturas no es divergencia estable
    raise RuntimeError(f'inventarios de raíces discrepan: proc={sorted(live)} ps={sorted(independent)}')


def group_alive(pgid: int) -> bool:
    """Señal 0 solo consulta existencia; nunca señala ni detiene el grupo."""
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def group_members(pgid: int) -> list[int]:
    members = []
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        pid = int(entry.name)
        try:
            stat = (entry / 'stat').read_text()
            if stat[stat.rfind(')') + 2:].split()[0] == 'Z':
                continue
            if os.getpgid(pid) == pgid:
                members.append(pid)
        except (OSError, ProcessLookupError, IndexError):
            continue
    return sorted(members)


def has_worker(pgid: int, output: Path, root_pid: int) -> bool:
    for pid in group_members(pgid):
        if pid == root_pid:
            continue
        try:
            cmdline = Path(f'/proc/{pid}/cmdline').read_bytes()
        except OSError:
            continue
        if (command_output(cmdline) == output
                and (b'--require\0' in cmdline or b'--import\0' in cmdline)):
            return True
    return False


def audit_group(pgid: int, output: Path, pool: Path) -> tuple[list[str], list[str]]:
    """Repara nice de todos los PID del grupo propio; acredita pool completo."""
    restored: list[str] = []
    problems: list[str] = []
    members = group_members(pgid)
    worker_seen = False
    # Dos pasadas: si un miembro es ambiguo no se modifica ningún PID del grupo.
    for pid in members:
        try:
            cmdline = Path(f'/proc/{pid}/cmdline').read_bytes()
            if command_output(cmdline) != output:
                problems.append(f'PGID {pgid} PID {pid}: comando/salida ambiguos')
                continue
            if b'--require\0' in cmdline or b'--import\0' in cmdline:
                worker_seen = True
            affinity = os.sched_getaffinity(pid)
            bad_affinity = (affinity != CPU if output.parent == pool
                            else not affinity.issubset(CPU))
            if bad_affinity:
                problems.append(f'PGID {pgid} PID {pid}: afinidad fuera del contrato')
            if b'TMPDIR=/datos/tmp-atlas-lab\0' not in Path(f'/proc/{pid}/environ').read_bytes():
                problems.append(f'PGID {pgid} PID {pid}: TMPDIR incompatible')
        except ProcessLookupError:
            continue  # terminó mientras se inspeccionaba
        except (OSError, PermissionError) as exc:
            problems.append(f'PGID {pgid} PID {pid}: lectura falló: {exc}')
    if members and not worker_seen:
        problems.append(f'PGID {pgid}: worker node real ausente')
    if problems:
        return restored, problems
    for pid in members:
        try:
            before = os.getpriority(os.PRIO_PROCESS, pid)
            if before == 19:
                continue
            after = before
            for _ in range(5):
                os.setpriority(os.PRIO_PROCESS, pid, 19)
                after = os.getpriority(os.PRIO_PROCESS, pid)
                if after == 19:
                    break
                time.sleep(0.1)
            if after == 19:
                restored.append(f'pgid={pgid} pid={pid} antes={before} despues=19')
            else:
                problems.append(f'PGID {pgid} PID {pid}: nice={after} tras restauración')
        except ProcessLookupError:
            continue
        except (OSError, PermissionError) as exc:
            problems.append(f'PGID {pgid} PID {pid}: restauración falló: {exc}')
    return restored, problems


def frozen_state() -> str:
    """Vacío solo si el checkout ejecutado sigue exactamente en el SHA limpio."""
    try:
        head = subprocess.check_output(
            ['git', '-C', str(WORKTREE), 'rev-parse', 'HEAD'], text=True).strip()
        if head != SHA:
            return 'lab-v4 HEAD distinto del SHA congelado'
        dirty = subprocess.check_output(
            ['git', '-C', str(WORKTREE), 'status', '--porcelain=v1', '--untracked-files=all'],
            text=True)
        if dirty:
            return 'lab-v4 tiene archivos rastreados o no rastreados modificados'
    except (OSError, subprocess.CalledProcessError):
        return 'lab-v4 no permite verificar SHA y limpieza'
    return ''


def used_seeds(base: Path, bitacora: str) -> set[int]:
    used = set()
    for directory in base.iterdir():
        if directory.is_dir():
            for item in directory.iterdir():
                match = re.fullmatch(r'CTRLV4-(\d+)(?:\.log)?', item.name)
                if match:
                    used.add(int(match[1]))
    used.update(int(x) for x in re.findall(r'CTRLV4-(\d+)', bitacora))
    return used


def registered(seed: int, bitacora: str) -> bool:
    if 6066 <= seed <= 6105:
        return bool(re.search(r'6066\s*[–-]\s*6105', bitacora))
    first = 6106 + ((seed - 6106) // 40) * 40
    return f'POOL BLOQUE {first}-{first + 39}' in bitacora


def preregister(base: Path, first: int) -> None:
    """Bloques nuevos: bitacora.lock compartido con el operador; append + fsync."""
    bit = base / 'bitacora.md'
    if first < 6106 or (first - 6106) % 40:
        raise ValueError('bloque prospectivo inválido')
    with (base / 'bitacora.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        text = bit.read_text(encoding='utf-8')
        if f'POOL BLOQUE {first}-{first + 39}' in text:
            return
        now = dt.datetime.now().astimezone()
        day = now.strftime('%d-%m')
        line = (f'\n## {now:%H:%M} — PRERREGISTRO POOL BLOQUE {first}-{first + 39} ({day})\n'
                f'- Antes del primer lanzamiento declaro CTRLV4-{first}..CTRLV4-{first + 39}: '
                f'60 días, SHA {SHA}, parámetros literales `{PARAMS}`, worktree `lab-v4`, '
                'CPU 6–31, nice 19, TMPDIR=/datos/tmp-atlas-lab, '
                f'salida `/datos/tmp-atlas-lab/datos-lab/ctrlv4pool/CTRLV4-<semilla>`. '
                f'Registro real {stamp()}; bloques anteriores intactos.\n')
        with bit.open('a', encoding='utf-8') as output:
            output.write(line)
            output.flush()
            os.fsync(output.fileno())


def record(tsv: Path, name: str, state: str, info: str = '') -> None:
    with tsv.open('a', encoding='utf-8') as output:
        output.write(f'{stamp()}\t{name}\t{state}\t{info}\n')
        output.flush()
        os.fsync(output.fileno())


def verified_end(output: Path, log: Path, seed: int, root_gone: bool) -> str:
    if not root_gone or not real_file(log) or not output.is_dir() or output.is_symlink():
        raise ValueError('raíz/log/directorio no acreditados')
    days = []
    for number in range(1, 61):
        path = output / f'dia-{number:03}.json'
        if not real_file(path):
            raise ValueError(f'día {number} ausente')
        day = json.loads(path.read_text())
        if day.get('tick') != 2400 * number:
            raise ValueError(f'tick de día {number} inválido')
        days.append(day)
    manifest_path = output / 'replica.json'
    if not real_file(manifest_path):
        raise ValueError('manifiesto ausente')
    manifest = json.loads(manifest_path.read_text())
    ref = json.loads((output.parent.parent / 'ctrlv4/CTRLV4-6001/replica.json').read_text())
    for key, expected in (('seed', seed), ('dias', 60), ('sha', SHA),
                          ('digest', ref['digest']), ('params', ref['params']),
                          ('metricasVersion', ref['metricasVersion']),
                          ('instrumentos', ref['instrumentos']), ('gobernador', ref['gobernador'])):
        if manifest.get(key) != expected:
            raise ValueError(f'manifiesto {key} incompatible')
    summary = manifest.get('resumen')
    if not isinstance(summary, dict) or summary.get('poblacionFinal') != days[-1].get('poblacion'):
        raise ValueError('resumen final incompatible')
    ending = (f'Réplica completa: 60 día(s), población final {days[-1]["poblacion"]}. '
              f'Salida: {output}')
    if log.read_text().count(ending) != 1:
        raise ValueError('log sin terminación normal única')
    return hashlib.sha256(manifest_path.read_bytes()).hexdigest()


def stop_requested(base: Path) -> bool:
    return (base / 'codex-FIN').exists() or (base / 'codex-pool-STOP').exists()


def pending_intentions(tsv: Path, pool: Path) -> list[int]:
    """Una intención sin LANZADA puede haber creado proceso; exige revisión humana."""
    if not tsv.exists():
        return []
    intended: dict[int, Path] = {}
    launched: set[int] = set()
    for line in tsv.read_text(encoding='utf-8').splitlines()[1:]:
        fields = line.split('\t')
        if len(fields) != 4 or not re.fullmatch(r'CTRLV4-(\d+)', fields[1]):
            continue
        seed = int(fields[1].split('-')[1])
        if fields[2] == 'INTENCION':
            expected = pool / f'CTRLV4-{seed}'
            if fields[3] != f'sha={SHA} params={PARAMS} salida={expected} log={pool / (expected.name + ".log")}':
                raise RuntimeError(f'INTENCION {seed} incompatible')
            if seed in intended:
                raise RuntimeError(f'INTENCION {seed} duplicada')
            intended[seed] = expected
        elif fields[2] == 'LANZADA':
            launched.add(seed)
    return sorted(intended.keys() - launched)


def status(base: Path) -> dict:
    live = checked_roots(base)
    pool = base / 'ctrlv4pool'
    return {'fecha': stamp(), 'raicesPropias': len(live), 'objetivo': TARGET,
            'raices': [{'pid': pid, 'replica': output.name} for pid, (_, output) in sorted(live.items())],
            'conteoIndependiente': len(independent_roots(base)),
            'intencionesSinLanzamiento': pending_intentions(pool / 'codex-ctrlv4pool-20260927.tsv', pool),
            'memAvailableGiB': round(available_gib(), 2),
            'datosLibreGiB': round(disk_gib(base), 2),
            'altoSolicitado': stop_requested(base)}


def run(base: Path) -> None:
    base = base.resolve(strict=True)
    pool = base / 'ctrlv4pool'
    pool.mkdir(exist_ok=True)
    lock = (base / 'codex-pool.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    tsv = pool / 'codex-ctrlv4pool-20260927.tsv'
    if not tsv.exists():
        with tsv.open('x') as output:
            output.write(HEADER)
            output.flush()
            os.fsync(output.fileno())
    elif not real_file(tsv) or not tsv.read_text().startswith(HEADER):
        raise RuntimeError('TSV existente incompatible')
    bit = (base / 'bitacora.md').read_text(encoding='utf-8')
    if not registered(6066, bit):
        raise RuntimeError('falta prerregistro inicial 6066–6105')
    frozen_error = frozen_state()
    if frozen_error:
        raise RuntimeError(frozen_error)
    if (base / 'ctrlv4/brazo.txt').read_text().strip() != BRAZO:
        raise RuntimeError('brazo CTRLV4 incompatible')
    if not CPU.issubset(os.sched_getaffinity(0)):
        raise RuntimeError('el gestor requiere afinidad CPU6–31')
    tsx = WORKTREE / 'node_modules/.bin/tsx'
    if not tsx.is_file():
        raise RuntimeError('tsx ausente en lab-v4')
    watched: dict[int, tuple[int, Path, int]] = {}
    children: dict[int, subprocess.Popen] = {}
    known_groups: dict[int, Path] = {}
    launched: dict[int, tuple[int, Path]] = {}
    witnessed: set[tuple[int, int]] = set()
    finalized: set[int] = set()
    for line in tsv.read_text(encoding='utf-8').splitlines()[1:]:
        fields = line.split('\t')
        if len(fields) != 4 or not re.fullmatch(r'CTRLV4-\d+', fields[1]):
            continue
        seed = int(fields[1].split('-')[1])
        if fields[2] == 'LANZADA':
            match = re.search(r'(?:^| )pid=(\d+) .* salida=(\S+)$', fields[3])
            expected = pool / f'CTRLV4-{seed}'
            if not match or Path(match[2]) != expected or seed in launched:
                raise RuntimeError(f'LANZADA inválida o duplicada para {seed}')
            launched[seed] = (int(match[1]), expected)
        if fields[2] == 'IDENTIDAD':
            match = re.fullmatch(r'dia=([123]) sha256canon=[a-f0-9]{64} tick=\d+', fields[3])
            if match:
                witnessed.add((seed, int(match[1])))
        if fields[2] in {'MANIFIESTO_VERIFICADO', 'FALLO'}:
            finalized.add(seed)
    for pid, output in launched.values():
        known_groups[pid] = output
    pending = pending_intentions(tsv, pool)
    if pending:
        record(tsv, 'GESTOR', 'PAUSA', f'INTENCION sin LANZADA, revisar sin señalar: {pending}')
        raise RuntimeError(f'INTENCION sin LANZADA: {pending}; nuevos lanzamientos detenidos')
    last_pause = ''
    while not stop_requested(base):
        live = checked_roots(base)
        visible_groups = set()
        audit_problems: list[str] = []
        for pid, (seed, output) in live.items():
            try:
                pgid = os.getpgid(pid)
            except ProcessLookupError:
                continue
            visible_groups.add(pgid)
            known_groups[pgid] = output
            restored, problems = audit_group(pgid, output, pool)
            for info in restored:
                record(tsv, output.name, 'PRIORIDAD', info)
            audit_problems.extend(problems)
            if pid not in watched:
                try:
                    watched[pid] = (seed, output, os.pidfd_open(pid))
                except ProcessLookupError:
                    continue
        # Primero se recuperan todos los testigos pendientes, incluso de una
        # réplica que terminó antes de arrancar este gestor o entre dos vueltas.
        for seed, (_, output) in sorted(launched.items()):
            if seed in finalized:
                continue
            for day in (1, 2, 3):
                if (seed, day) in witnessed:
                    continue
                path = output / f'dia-{day:03}.json'
                if not real_file(path):
                    continue
                try:
                    data = json.loads(path.read_text())
                    if data.get('tick') != 2400 * day:
                        raise ValueError('tick inicial inválido')
                except (OSError, ValueError, json.JSONDecodeError):
                    continue
                record(tsv, output.name, 'IDENTIDAD',
                       f'dia={day} sha256canon={fingerprint(data)} tick={2400 * day}')
                witnessed.add((seed, day))
        for pid, (seed, output, fd) in list(watched.items()):
            if pid not in live and select.select([fd], [], [], 0)[0]:
                os.close(fd)
                del watched[pid]
        live_pool_seeds = {seed for seed, output in live.values() if output.parent == pool}
        for seed, (pid, output) in sorted(launched.items()):
            if seed in finalized or seed in live_pool_seeds:
                continue
            if pid in watched or (pid not in children and Path(f'/proc/{pid}').exists()):
                continue  # no acreditar salida mientras el PID raíz pueda seguir vivo
            try:
                if pid in children and children.pop(pid).wait() != 0:
                    raise ValueError('código de salida de raíz distinto de cero')
                if any((seed, day) not in witnessed for day in (1, 2, 3)):
                    raise ValueError('faltan testigos de días 1–3')
                digest = verified_end(output, pool / f'CTRLV4-{seed}.log', seed, True)
            except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
                record(tsv, output.name, 'FALLO', str(exc))
            else:
                record(tsv, output.name, 'MANIFIESTO_VERIFICADO', f'sha256={digest}')
            finalized.add(seed)
        unresolved = [pgid for pgid in known_groups
                      if pgid not in visible_groups and group_alive(pgid)]
        for pgid in list(known_groups):
            if pgid not in visible_groups and pgid not in unresolved:
                del known_groups[pgid]
        if unresolved:
            reason = f'grupo propio huérfano sin cmdline acreditable: PGID {sorted(unresolved)}'
            if reason != last_pause:
                record(tsv, 'GESTOR', 'PAUSA', reason)
                last_pause = reason
            # Pausa de seguridad: no computar como libre una plaza con worker oculto.
            fds = [fd for _, _, fd in watched.values()]
            if fds:
                select.select(fds, [], [], 10)
            else:
                time.sleep(10)
            continue
        if audit_problems:
            reason = 'prioridad/afinidad/TMPDIR de grupo propio sin acreditar: ' + '; '.join(audit_problems)
            if reason != last_pause:
                record(tsv, 'GESTOR', 'PAUSA', reason)
                last_pause = reason
            fds = [fd for _, _, fd in watched.values()]
            if fds:
                select.select(fds, [], [], 10)
            else:
                time.sleep(10)
            continue
        while len(live) < TARGET and not stop_requested(base):
            mem, disk, health = available_gib(), disk_gib(base), healthy()
            reason = ('MemAvailable <35 GiB de margen para suelo 30 GiB' if mem < 35
                      else '/datos <100 GiB' if disk < 100 else 'público sin health ok' if not health else '')
            if not reason:
                reason = frozen_state()
            if reason:
                if reason != last_pause:
                    record(tsv, 'GESTOR', 'PAUSA', f'{reason}; memoria={mem:.2f}GiB disco={disk:.2f}GiB')
                    last_pause = reason
                break
            last_pause = ''
            bit = (base / 'bitacora.md').read_text(encoding='utf-8')
            used = used_seeds(base, bit)
            seed = next(s for s in range(6066, max(used | {6105}) + 42) if s not in used)
            if not registered(seed, bit):
                first = 6106 + ((seed - 6106) // 40) * 40
                preregister(base, first)
                bit = (base / 'bitacora.md').read_text(encoding='utf-8')
            if not registered(seed, bit):
                raise RuntimeError(f'semilla {seed} sin prerregistro')
            output = pool / f'CTRLV4-{seed}'
            log_path = pool / f'CTRLV4-{seed}.log'
            if output.exists() or log_path.exists():
                raise RuntimeError(f'salida/log existentes: {seed}')
            frozen_error = frozen_state()
            if frozen_error:
                record(tsv, 'GESTOR', 'PAUSA', frozen_error)
                last_pause = frozen_error
                break
            record(tsv, output.name, 'INTENCION',
                   f'sha={SHA} params={PARAMS} salida={output} log={log_path}')
            cmd = [str(tsx), 'scripts/lab/replica.ts', '--seed', str(seed), '--dias', '60',
                   '--params', PARAMS, '--salida', str(output)]
            env = dict(os.environ, TMPDIR='/datos/tmp-atlas-lab')
            # taskset y nice hacen exec; PID y PGID permanecen en la raíz de la réplica.
            with log_path.open('x') as log:
                child = subprocess.Popen(['taskset', '-c', '6-31', 'nice', '-n', '19', *cmd],
                                         cwd=WORKTREE, env=env, stdout=log,
                                         stderr=subprocess.STDOUT, start_new_session=True)
            for _ in range(50):
                proc = read_proc(child.pid)
                if (proc and b'scripts/lab/replica.ts' in proc[1]
                        and has_worker(child.pid, output, child.pid)):
                    break
                if child.poll() is not None:
                    break
                time.sleep(0.1)
            try:
                valid = (os.getpgid(child.pid) == child.pid
                         and b'scripts/lab/replica.ts' in Path(f'/proc/{child.pid}/cmdline').read_bytes()
                         and b'TMPDIR=/datos/tmp-atlas-lab\0' in Path(f'/proc/{child.pid}/environ').read_bytes())
            except (OSError, ProcessLookupError):
                valid = False
            restored, problems = audit_group(child.pid, output, pool)
            if problems:
                valid = False
            if not valid:
                record(tsv, output.name, 'FALLO',
                       f'pid={child.pid} sin acreditación de grupo/raíz: {problems}')
                raise RuntimeError(f'raíz {child.pid} sin acreditación al arrancar; revisar sin señalar')
            record(tsv, output.name, 'LANZADA',
                   f'pid={child.pid} pgid={child.pid} sha={SHA} params={PARAMS} '
                   f'nice=19 afinidad=6-31 TMPDIR=/datos/tmp-atlas-lab salida={output}')
            for info in restored:
                record(tsv, output.name, 'PRIORIDAD', info)
            launched[seed] = (child.pid, output)
            known_groups[child.pid] = output
            try:
                watched[child.pid] = (seed, output, os.pidfd_open(child.pid))
            except ProcessLookupError:
                pass
            children[child.pid] = child
            live[child.pid] = (seed, output)
        if stop_requested(base):
            break
        fds = [fd for _, _, fd in watched.values()]
        if fds:
            select.select(fds, [], [], 10)
        else:
            time.sleep(10)
    record(tsv, 'GESTOR', 'DETENIDO', 'codex-FIN o codex-pool-STOP; hijos intactos')
    for _, _, fd in watched.values():
        os.close(fd)


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
