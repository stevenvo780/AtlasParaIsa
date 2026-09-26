#!/usr/bin/env python3
"""Relanzar las réplicas incompletas del 24-09 sin alterar los datos viejos.

Uso: python3 scripts/analysis/launch-codex-campaigns.py tower|laptop
El perfil laptop se copia a ~/atlas-lab antes de ejecutarlo allí. Cada proceso
se inicia desde el checkout congelado; el gestor solo detiene sus propios hijos.
"""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
import urllib.request


PARAMS = "persistencia.cadaTicks=300,limites.teselasActivas=1303552,limites.chunks=5092,limites.fauna=7821312"
TOWER_BASE = Path("/datos/tmp-atlas-lab/datos-lab")
LAPTOP_BASE = Path.home() / "atlas-lab"
WORKTREES = Path("/datos/workspaces/personal/AtlasParaIsa-anexo/worktrees")
TOWER = [
    ("ctrlv4", "CTRLV4", seed, WORKTREES / "lab-v4", "667454d5e0232885d78c37775d6a5619f516872d", PARAMS)
    for seed in (6004, 6009, 6010, 6011, 6012, 6013, 6015, 6017, 6018)
] + [
    ("c8panel", "HOG", 2010, WORKTREES / "lab-c8", "d2ebf11d51c3221477d88c7045faeafa2a229683", PARAMS + ",social.hogarTrabajo=1")
]
LAPTOP = [
    ("c8panel", "CTRL2", seed, LAPTOP_BASE / "lab-c8", "d2ebf11d51c3221477d88c7045faeafa2a229683", PARAMS)
    for seed in (2002, 2004, 2006, 2007, 2008, 2009, 2010, 2011, 2012)
] + [
    ("f21b", "PUB2", seed, LAPTOP_BASE / "lab-c8", "d2ebf11d51c3221477d88c7045faeafa2a229683", PARAMS)
    for seed in (5, 29, 101, 202, 404, 606, 707)
]


def stamp() -> str:
    return dt.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S%z")


def disk_free_gib(path: Path) -> float:
    stat = os.statvfs(path)
    return stat.f_bavail * stat.f_frsize / 2**30


def available_gib() -> float:
    for line in Path("/proc/meminfo").read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) / 2**20
    raise RuntimeError("MemAvailable ausente")


def healthy() -> bool:
    request = urllib.request.Request(
        "http://100.64.0.1:3000/health", headers={"Host": "atlas.humanizar.tech"}
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status == 200 and json.load(response).get("status") == "ok"
    except Exception:
        return False


def sha(path: Path) -> str:
    return hashlib.sha256(json.dumps(
        canonical(json.loads(path.read_text())), sort_keys=True, separators=(",", ":")
    ).encode()).hexdigest()


def canonical(value):
    # Los tiempos del paso y RSS no forman parte del estado determinista.
    if isinstance(value, dict):
        return {key: canonical(item) for key, item in value.items()
                if key not in {"p50Ms", "p95Ms", "rss"} and not key.endswith("Ms")}
    if isinstance(value, list):
        return [canonical(item) for item in value]
    return value


def compare_early(old: Path, new: Path, day: int) -> str | None:
    previous = old / f"dia-{day:03}.json"
    current = new / f"dia-{day:03}.json"
    if not previous.is_file() or not current.is_file():
        return None
    old_hash, new_hash = sha(previous), sha(current)
    if old_hash != new_hash:
        raise RuntimeError(
            f"FALLO_DE_DETERMINISMO día {day}: {old} {old_hash} != {new} {new_hash}"
        )
    return new_hash


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"tower", "laptop"}:
        print(__doc__, file=sys.stderr)
        return 2
    profile = sys.argv[1]
    base = TOWER_BASE if profile == "tower" else LAPTOP_BASE
    jobs = TOWER if profile == "tower" else LAPTOP
    tmp = Path("/datos/tmp-atlas-lab") if profile == "tower" else LAPTOP_BASE / "tmp"
    max_workers = 10 if profile == "tower" else 14
    progress = base / ("codex-tower-20260926.tsv" if profile == "tower" else "codex-laptop-20260926.tsv")
    lockfile = base / f"codex-{profile}-20260926.lock"
    lock = lockfile.open("a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit(f"Ya hay un gestor {profile} vivo: {lockfile}")

    if not healthy():
        raise SystemExit("El público no responde ok; no se lanzan réplicas")
    if disk_free_gib(tmp) < 40:
        raise SystemExit(f"Disco con menos de 40 GiB libres: {tmp}")
    if profile == "tower" and available_gib() < 20:
        raise SystemExit("Torre con menos de 20 GiB disponibles")

    for _, _, _, worktree, expected, _ in jobs:
        actual = subprocess.check_output(["git", "-C", str(worktree), "rev-parse", "HEAD"], text=True).strip()
        if actual != expected:
            raise SystemExit(f"SHA incorrecto en {worktree}: {actual} != {expected}")

    # Todos los parciales y sus logs quedan conservados con su nombre original.
    prepared = []
    for campaign, arm, seed, worktree, expected, params in jobs:
        name = f"{arm}-{seed}"
        campaign_dir = base / campaign
        old_dir = campaign_dir / name
        old_log = campaign_dir / f"{name}.log"
        archive = campaign_dir / "parciales-20260924"
        archive.mkdir(exist_ok=True)
        if (archive / name).exists() or (archive / f"{name}.log").exists():
            raise SystemExit(f"Parcial ya archivado; no se sobreescribe: {name}")
        if not (old_dir / "dia-003.json").is_file() or (old_dir / "dia-060.json").exists():
            raise SystemExit(f"Parcial inesperado: {old_dir}")
        old_dir.rename(archive / name)
        if old_log.exists():
            old_log.rename(archive / old_log.name)
        prepared.append((name, campaign_dir, archive / name, worktree, params, seed))

    progress.write_text("hora\treplica\testado\tinfo\n")
    write_lock = threading.Lock()
    stop = threading.Event()
    children: dict[str, subprocess.Popen] = {}
    reason: list[str] = []

    def record(name: str, state: str, info: str = "") -> None:
        with write_lock, progress.open("a") as output:
            output.write(f"{stamp()}\t{name}\t{state}\t{info}\n")
            output.flush()

    def halt(why: str) -> None:
        if not stop.is_set():
            reason.append(why)
            record("GESTOR", "DETENER", why)
        stop.set()
        with write_lock:
            owned = list(children.values())
        for child in owned:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass

    def watchdog() -> None:
        unhealthy_since = None
        while not stop.wait(30):
            free = disk_free_gib(tmp)
            if free < 20:
                halt(f"Disco {tmp}: {free:.2f} GiB libres (<20)")
                return
            if healthy():
                unhealthy_since = None
            else:
                unhealthy_since = unhealthy_since or time.monotonic()
                if time.monotonic() - unhealthy_since >= 600:
                    halt("Público sin health ok durante 10 minutos")
                    return

    threading.Thread(target=watchdog, daemon=True).start()

    def run_one(job) -> None:
        name, campaign_dir, old_dir, worktree, params, seed = job
        while disk_free_gib(tmp) < 40 and not stop.is_set():
            record(name, "ESPERA_DISCO", f"{disk_free_gib(tmp):.2f} GiB")
            stop.wait(60)
        if stop.is_set():
            record(name, "NO_LANZADA", "gestor detenido")
            return
        if profile == "tower" and available_gib() < 20:
            halt("Torre con menos de 20 GiB disponibles antes de lanzar nueva réplica")
            return
        output_dir = campaign_dir / name
        log_path = campaign_dir / f"{name}.log"
        env = os.environ.copy()
        env["TMPDIR"] = str(tmp)
        cmd = ["npx", "tsx", "scripts/lab/replica.ts", "--seed", str(seed),
               "--dias", "60", "--params", params, "--salida", str(output_dir)]
        with log_path.open("w") as log:
            child = subprocess.Popen(cmd, cwd=worktree, env=env, stdout=log,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            with write_lock:
                children[name] = child
            record(name, "LANZADA", f"pid={child.pid} sha={subprocess.check_output(['git', '-C', str(worktree), 'rev-parse', '--short', 'HEAD'], text=True).strip()}")
            verified = set()
            while child.poll() is None and not stop.is_set():
                for day in (1, 2, 3):
                    if day not in verified and (output_dir / f"dia-{day:03}.json").is_file():
                        try:
                            digest = compare_early(old_dir, output_dir, day)
                        except (RuntimeError, json.JSONDecodeError) as exc:
                            if isinstance(exc, json.JSONDecodeError):
                                continue  # archivo en escritura; se compara en el próximo ciclo
                            halt(str(exc))
                            break
                        if digest:
                            verified.add(day)
                            record(name, "IDENTIDAD", f"día={day} sha256={digest}")
                stop.wait(5)
            code = child.wait()
            if not stop.is_set():
                for day in (1, 2, 3):
                    if day not in verified and (output_dir / f"dia-{day:03}.json").is_file():
                        try:
                            digest = compare_early(old_dir, output_dir, day)
                        except RuntimeError as exc:
                            halt(str(exc))
                            break
                        if digest:
                            verified.add(day)
                            record(name, "IDENTIDAD", f"día={day} sha256={digest}")
            with write_lock:
                children.pop(name, None)
            if code == 0 and len(verified) == 3 and (output_dir / "dia-060.json").is_file():
                record(name, "COMPLETA", "60 días; identidad 1-3 verificada")
            else:
                record(name, "FALLO", f"exit={code} identidad={sorted(verified)} día60={(output_dir / 'dia-060.json').is_file()}")

    record("GESTOR", "INICIO", f"perfil={profile} jobs={len(prepared)} concurrencia={max_workers}")
    with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [pool.submit(run_one, job) for job in prepared]
        for future in concurrent.futures.as_completed(futures):
            try:
                future.result()
            except Exception as exc:
                halt(f"Excepción del gestor: {exc!r}")
    stop.set()
    record("GESTOR", "FIN", reason[0] if reason else "réplicas terminadas")
    return 1 if reason else 0


if __name__ == "__main__":
    raise SystemExit(main())
