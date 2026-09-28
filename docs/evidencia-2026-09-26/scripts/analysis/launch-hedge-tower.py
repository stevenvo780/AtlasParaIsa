#!/usr/bin/env python3
"""Lanza copias independientes de las 14 réplicas activas del portátil.

Las copias viven en un árbol separado: no modifican ni sustituyen los trabajos
del portátil. El TSV registra el lanzamiento real; los resultados requieren
identidad con los parciales antes de entrar en cualquier análisis.
"""

from datetime import datetime
import os
from pathlib import Path
import shutil
import subprocess


LAB = Path('/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees/lab-c8')
BASE = Path('/datos/tmp-atlas-lab/datos-lab/hedge-torre-20260926')
TMP = Path('/datos/tmp-atlas-lab')
SHA = 'd2ebf11d51c3221477d88c7045faeafa2a229683'
PARAMS = 'persistencia.cadaTicks=300,limites.teselasActivas=1303552,limites.chunks=5092,limites.fauna=7821312'
JOBS = [("CTRL2", seed) for seed in (2002, 2004, 2006, 2007, 2008, 2009, 2010, 2011, 2012)]
JOBS += [("PUB2", seed) for seed in (5, 29, 101, 202, 404)]


def stamp():
    return datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S%z')


def child_setup():
    os.sched_setaffinity(0, set(range(10, 32)))
    os.nice(19)


def main():
    if subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=LAB, text=True).strip() != SHA:
        raise RuntimeError('SHA de lab-c8 distinto del congelado')
    if subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=no'], cwd=LAB):
        raise RuntimeError('lab-c8 tiene cambios rastreados')
    if BASE.exists() or BASE.is_symlink():
        raise RuntimeError(f'El destino ya existe; no se relanza encima: {BASE}')
    if shutil.disk_usage(TMP).free < 100 * 1024 ** 3:
        raise RuntimeError('Menos de 100 GiB de disco libre; no iniciar copias')
    if not shutil.which('npx'):
        raise RuntimeError('npx no disponible')
    health = subprocess.run(['curl', '-fsS', '--max-time', '5', '-H',
                             'Host: atlas.humanizar.tech', 'http://100.64.0.1:3000/health'],
                            capture_output=True, text=True, check=True)
    if '"status":"ok"' not in health.stdout:
        raise RuntimeError('El público no responde ok')

    BASE.mkdir(parents=True)
    event_log = BASE / 'codex-hedge-torre-20260926.tsv'
    with event_log.open('x') as events:
        events.write('hora\treplica\testado\tinfo\n')
        events.flush()
        for arm, seed in JOBS:
            name = f'{arm}-{seed}'
            output = BASE / name
            log = BASE / f'{name}.log'
            if output.exists() or log.exists():
                raise RuntimeError(f'Destino ya ocupado: {name}')
            cmd = ['npx', 'tsx', 'scripts/lab/replica.ts', '--seed', str(seed),
                   '--dias', '60', '--params', PARAMS, '--salida', str(output)]
            env = os.environ.copy()
            env['TMPDIR'] = str(TMP)
            with log.open('x') as stream:
                process = subprocess.Popen(cmd, cwd=LAB, env=env, stdin=subprocess.DEVNULL,
                                           stdout=stream, stderr=subprocess.STDOUT,
                                           start_new_session=True, preexec_fn=child_setup)
            events.write(f'{stamp()}\t{name}\tLANZADA\tpid={process.pid} sha={SHA} '
                         f'params={PARAMS} afinidad=10-31 nice=19 TMPDIR={TMP} salida={output}\n')
            events.flush()
            print(f'{name}\tpid={process.pid}\t{output}', flush=True)


if __name__ == '__main__':
    main()
