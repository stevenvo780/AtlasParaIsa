#!/usr/bin/env python3
"""Verifica todos los días archivados que coinciden con sus relanzadas.

Sin opciones escribe un balance únicamente si cada día archivado tiene copia
válida y todos los pares son idénticos. --muestra no escribe ningún archivo.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import stat
import sys


DEFAULT_BASE = Path("/datos/tmp-atlas-lab/datos-lab")
DAY_NAME = re.compile(r"dia-(\d{3})\.json\Z")
GROUPS = (
    ("ctrlv4", "CTRLV4", (6004, 6009, 6010, 6011, 6012, 6013, 6015, 6017, 6018)),
    ("c8panel", "HOG", (2010,)),
    ("c8panel/portatil", "CTRL2", (2002, 2004, 2006, 2007, 2008, 2009, 2010, 2011, 2012)),
    ("f21b-portatil", "PUB2", (5, 29, 101, 202, 404, 606, 707)),
)
EXPECTED_ARCHIVED_LAST_DAY = {
    "CTRLV4-6004": 52, "CTRLV4-6009": 48, "CTRLV4-6010": 49,
    "CTRLV4-6011": 55, "CTRLV4-6012": 56, "CTRLV4-6013": 46,
    "CTRLV4-6015": 45, "CTRLV4-6017": 54, "CTRLV4-6018": 59,
    "HOG-2010": 24,
    "CTRL2-2002": 36, "CTRL2-2004": 38, "CTRL2-2006": 44,
    "CTRL2-2007": 36, "CTRL2-2008": 46, "CTRL2-2009": 39,
    "CTRL2-2010": 36, "CTRL2-2011": 51, "CTRL2-2012": 31,
    "PUB2-5": 33, "PUB2-29": 35, "PUB2-101": 33,
    "PUB2-202": 45, "PUB2-404": 47, "PUB2-606": 35,
    "PUB2-707": 36,
}


def canonical(value):
    # Exactamente la exclusión de launch-codex-campaigns.py.
    if isinstance(value, dict):
        return {key: canonical(item) for key, item in value.items()
                if key not in {"p50Ms", "p95Ms", "rss"} and not key.endswith("Ms")}
    if isinstance(value, list):
        return [canonical(item) for item in value]
    return value


def inventory(folder: Path) -> tuple[dict[int, Path], list[str]]:
    try:
        regular_directory = stat.S_ISDIR(folder.lstat().st_mode)
    except FileNotFoundError:
        regular_directory = False
    if not regular_directory:
        return {}, [f"directorio real ausente o symlink: {folder}"]
    days: dict[int, Path] = {}
    errors: list[str] = []
    for path in folder.iterdir():
        if not path.name.startswith("dia-"):
            continue
        match = DAY_NAME.fullmatch(path.name)
        if not match or not stat.S_ISREG(path.lstat().st_mode):
            errors.append(f"nombre o tipo inválido: {path}")
            continue
        day = int(match.group(1))
        if not 1 <= day <= 60:
            errors.append(f"día inválido: {path}")
        elif day in days:
            errors.append(f"día duplicado: {path} y {days[day]}")
        else:
            days[day] = path
    return days, errors


def fingerprint(path: Path, day: int) -> str:
    body = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(body, dict) or type(body.get("tick")) is not int or body["tick"] != day * 2400:
        raise ValueError(f"{path}: tick distinto de {day * 2400}")
    packed = json.dumps(canonical(body), sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(packed).hexdigest()


def verify_pair(base: Path, relative: str, name: str) -> dict:
    root = base / relative
    archived = root / "parciales-20260924" / name
    rerun = root / name
    old, old_errors = inventory(archived)
    new, new_errors = inventory(rerun)
    errors = old_errors + new_errors
    expected_last = EXPECTED_ARCHIVED_LAST_DAY[name]
    expected_old = list(range(1, expected_last + 1))
    if sorted(old) != expected_old:
        errors.append(f"archivo histórico no coincide con días 1–{expected_last}: {archived}")
    if new and sorted(new) != list(range(1, max(new) + 1)):
        errors.append(f"relanzada con huecos de días: {rerun}")
    common = sorted(old.keys() & new.keys())
    missing_new = sorted(old.keys() - new.keys())
    rows = []
    for day in common:
        try:
            old_sha = fingerprint(old[day], day)
            new_sha = fingerprint(new[day], day)
        except (OSError, ValueError, TypeError) as exc:
            errors.append(str(exc))
            continue
        rows.append({"dia": day, "sha256Archivado": old_sha,
                     "sha256Relanzado": new_sha, "iguales": old_sha == new_sha})
    reached = expected_last in new
    mismatches = [row["dia"] for row in rows if not row["iguales"]]
    # Un hueco en la relanzada no acredita identidad, aunque exista un día posterior.
    complete = reached and not missing_new and len(rows) == expected_last and not errors and not mismatches
    return {
        "replica": name,
        "archivado": str(archived), "relanzado": str(rerun),
        "diasArchivados": sorted(old), "maximoArchivadoEsperado": expected_last,
        "alcanzoMaximoArchivado": reached,
        "diasSinRelanzada": missing_new,
        "solapes": rows, "diasDiferentes": mismatches,
        "errores": errors, "solapeAcreditado": complete,
    }


def verify(base: Path) -> dict:
    rows = [verify_pair(base, relative, f"{arm}-{seed}")
            for relative, arm, seeds in GROUPS for seed in seeds]
    ok = all(row["solapeAcreditado"] for row in rows)
    return {
        "tipo": "verificacion_solapes_relanzadas_20260924",
        "base": str(base),
        "normalizacion": "Omitir recursivamente p50Ms, p95Ms, rss y claves terminadas en Ms; JSON sorted compact; SHA256 UTF-8.",
        "alcance": "Acredita solo identidad de JSON diarios archivados frente a relanzadas; no comprueba día 60, manifiesto final ni igualdad del estado interno. HOG-2010 puede tener solape acreditado y seguir fallida.",
        "estado": "solapes_acreditados" if ok else "pendiente_o_diferente",
        "replicas": rows,
        "resumen": {"replicas": len(rows), "solapesAcreditados": sum(row["solapeAcreditado"] for row in rows),
                    "solapes": sum(len(row["solapes"]) for row in rows),
                    "diferencias": sum(len(row["diasDiferentes"]) for row in rows),
                    "errores": sum(len(row["errores"]) for row in rows)},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, default=DEFAULT_BASE)
    parser.add_argument("--muestra", action="store_true", help="resumen sin escribir balance")
    args = parser.parse_args()
    result = verify(args.base)
    for row in result["replicas"]:
        print(f'{row["replica"]}: archivado={len(row["diasArchivados"])} '
              f'esperado={row["maximoArchivadoEsperado"]} solapes={len(row["solapes"])} '
              f'diferencias={len(row["diasDiferentes"])} '
              f'faltan={len(row["diasSinRelanzada"])} errores={len(row["errores"])} '
              f'estado={"SOLAPE_OK" if row["solapeAcreditado"] else "PENDIENTE"}')
    print(json.dumps(result["resumen"], sort_keys=True, separators=(",", ":")))
    if args.muestra:
        return 0 if result["estado"] == "solapes_acreditados" else 2
    if result["estado"] != "solapes_acreditados":
        print("Balance sin escribir: faltan días, hay datos inválidos o existen diferencias.", file=sys.stderr)
        return 2
    output = args.base.parent / "balance" / "verificacion-solapes-relanzadas.json"
    encoded = (json.dumps(result, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if output.exists():
        if output.read_bytes() != encoded:
            print(f"No se sobrescribe balance distinto: {output}", file=sys.stderr)
            return 2
    else:
        if not output.parent.is_dir():
            print(f"No existe el directorio de balance: {output.parent}", file=sys.stderr)
            return 2
        try:
            with output.open("xb") as stream:
                stream.write(encoded)
        except FileExistsError:
            print(f"El balance apareció durante la verificación: {output}", file=sys.stderr)
            return 2
    print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
