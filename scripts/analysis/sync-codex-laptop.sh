#!/usr/bin/env bash
# Copia resultados cerrados; conserva destinos y staging parciales.
set -euo pipefail

BASE=/datos/tmp-atlas-lab/datos-lab
REMOTE=stev@100.64.0.2
KEY=$HOME/.ssh/id_ed25519
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=8 -i "$KEY")
RSYNC_SSH="ssh -o BatchMode=yes -o ConnectTimeout=8 -i $KEY"
PROGRESS=/home/stev/atlas-lab/codex-laptop-20260926.tsv

VALIDATOR=$(cat <<'PY'
import hashlib
import json
import pathlib
import stat
import sys

folder, seed = pathlib.Path(sys.argv[1]), int(sys.argv[2])
expected_sha = 'd2ebf11d51c3221477d88c7045faeafa2a229683'
expected_digest = '63d4fc53b1a4c92e9c10bebed763958183ac22f246d8af744ba6a6ebfc840f0a'
expected_params_hash = '3d7a05d5d1d2ee6ee0ee6feaeb18bbc8a2599db1b64c7365a6569bfec7e43b36'
names = ['replica.json'] + [f'dia-{day:03}.json' for day in range(1, 61)]
if not stat.S_ISDIR(folder.lstat().st_mode):
    raise SystemExit(f'No es directorio regular: {folder}')
actual = sorted(path.name for path in folder.iterdir())
if actual != sorted(names):
    raise SystemExit(f'Inventario inesperado en {folder}: {actual}')
for name in names:
    path = folder / name
    if not stat.S_ISREG(path.lstat().st_mode):
        raise SystemExit(f'Archivo no regular o enlace: {path}')
meta = json.loads((folder / 'replica.json').read_text())
if not isinstance(meta, dict) or type(meta.get('seed')) is not int or meta['seed'] != seed \
        or type(meta.get('dias')) is not int or meta['dias'] != 60 \
        or meta.get('sha') != expected_sha or meta.get('digest') != expected_digest:
    raise SystemExit(f'Manifiesto incorrecto: {folder}')
params = meta.get('params')
params_hash = hashlib.sha256(json.dumps(params, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
if not isinstance(params, dict) or params_hash != expected_params_hash:
    raise SystemExit(f'Parámetros incorrectos: {folder}')
final_digest = meta.get('digestoMundoFinal')
if not isinstance(final_digest, str) or len(final_digest) != 64 \
        or any(c not in '0123456789abcdef' for c in final_digest):
    raise SystemExit(f'Digesto final inválido: {folder}')
for day in range(1, 61):
    body = json.loads((folder / f'dia-{day:03}.json').read_text())
    if not isinstance(body, dict) or type(body.get('tick')) is not int or body['tick'] != day * 2400:
        raise SystemExit(f'Tick incorrecto en {folder}/dia-{day:03}.json')
for name in names:
    print(name, hashlib.sha256((folder / name).read_bytes()).hexdigest())
PY
)

validate_remote() {
  printf '%s\n' "$VALIDATOR" | "${SSH[@]}" "$REMOTE" "python3 - '$1' '$2'"
}

validate_local() {
  python3 -c "$VALIDATOR" "$1" "$2"
}

# renameat2 impide reemplazar incluso un directorio vacío creado entretanto.
publish_new() {
  python3 - "$1" "$2" <<'PY'
import ctypes
import os
import sys
source, target = (os.fsencode(p) for p in sys.argv[1:])
libc = ctypes.CDLL(None, use_errno=True)
result = libc.renameat2(-100, source, -100, target, 1)  # RENAME_NOREPLACE
if result != 0:
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error), os.fsdecode(target))
PY
}

progress_ok=$("${SSH[@]}" "$REMOTE" "python3 - '$PROGRESS'" <<'PY'
from pathlib import Path
import stat
import sys
p = Path(sys.argv[1])
if not stat.S_ISREG(p.lstat().st_mode):
    raise SystemExit('Bitácora de gestor no regular')
rows = p.read_text().splitlines()
expected = {f'CTRL2-{seed}' for seed in (2002, 2004, 2006, 2007, 2008, 2009, 2010, 2011, 2012)}
expected |= {f'PUB2-{seed}' for seed in (5, 29, 101, 202, 404, 606, 707)}
if not rows or rows[0] != 'hora\treplica\testado\tinfo' \
        or rows[-1].split('\t')[1:] != ['GESTOR', 'FIN', 'réplicas terminadas']:
    raise SystemExit('Falta GESTOR FIN normal como último registro')
completed = set()
for row in rows[1:]:
    parts = row.split('\t')
    if len(parts) != 4:
        raise SystemExit('Fila mal formada en bitácora de gestor')
    _, name, state, _ = parts
    if state in ('FALLO', 'DETENER', 'NO_LANZADA'):
        raise SystemExit(f'Gestor registró {state} para {name}')
    if state == 'COMPLETA':
        completed.add(name)
if completed != expected:
    raise SystemExit(f'COMPLETA no cubre las 16 réplicas: faltan {sorted(expected-completed)}')
print('GESTOR FIN')
PY
)
[[ $progress_ok == 'GESTOR FIN' ]]

names=()
sources=()
destinations=()
seeds=()
for seed in 2002 2004 2006 2007 2008 2009 2010 2011 2012; do
  names+=("CTRL2-$seed")
  sources+=("/home/stev/atlas-lab/c8panel/CTRL2-$seed")
  destinations+=("$BASE/c8panel/portatil/CTRL2-$seed")
  seeds+=("$seed")
done
for seed in 5 29 101 202 404 606 707; do
  names+=("PUB2-$seed")
  sources+=("/home/stev/atlas-lab/f21b/PUB2-$seed")
  destinations+=("$BASE/f21b-portatil/PUB2-$seed")
  seeds+=("$seed")
done

# Preflight de todas las réplicas antes del primer rsync.
manifests=()
for i in "${!names[@]}"; do
  destination=${destinations[$i]}
  if [[ -e $destination || -L $destination ]]; then
    echo "Destino ya existe; se conserva: $destination" >&2
    exit 1
  fi
  manifests+=("$(validate_remote "${sources[$i]}" "${seeds[$i]}")")
  echo "Preflight completo: ${names[$i]}"
done

files=()
for day in $(seq -w 1 60); do files+=("dia-0${day}.json"); done
files+=(replica.json)
for i in "${!names[@]}"; do
  destination=${destinations[$i]}
  parent=${destination%/*}
  mkdir -p -- "$parent"
  if [[ -e $destination || -L $destination ]]; then
    echo "Destino ya existe; se conserva: $destination" >&2
    exit 1
  fi
  stage=$(mktemp -d "$parent/.sync-${names[$i]}.XXXXXX")
  printf '%s\n' "${files[@]}" | rsync -a --no-links --no-devices --no-specials \
    --files-from=- -e "$RSYNC_SSH" "$REMOTE:${sources[$i]}/" "$stage/"
  local_manifest=$(validate_local "$stage" "${seeds[$i]}")
  [[ $local_manifest == "${manifests[$i]}" ]] || { echo "Huellas distintas: ${names[$i]}; staging conservado: $stage" >&2; exit 1; }
  remote_manifest=$(validate_remote "${sources[$i]}" "${seeds[$i]}")
  [[ $remote_manifest == "$local_manifest" ]] || { echo "Origen cambió: ${names[$i]}; staging conservado: $stage" >&2; exit 1; }
  publish_new "$stage" "$destination"
  echo "Copiada y validada: ${names[$i]}"
done

balance=/datos/tmp-atlas-lab/balance
mkdir -p -- "$balance"
progress_target=$balance/codex-laptop-20260926.tsv
if [[ -e $progress_target || -L $progress_target ]]; then
  echo "Bitácora ya existe; se conserva: $progress_target" >&2
  exit 1
fi
progress_stage=$(mktemp "$balance/.codex-laptop-20260926.XXXXXX")
rsync -a --no-links -e "$RSYNC_SSH" "$REMOTE:$PROGRESS" "$progress_stage"
publish_new "$progress_stage" "$progress_target"
