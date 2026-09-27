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
expected |= {f'PUB2-{seed}' for seed in (5, 29, 101, 202, 404)}
if not rows or rows[0] != 'hora\treplica\testado\tinfo':
    raise SystemExit('Cabecera inválida de bitácora')
launched = set()
identities = {name: set() for name in expected}
manager_start = 0
for row in rows[1:]:
    parts = row.split('\t')
    if len(parts) != 4:
        raise SystemExit('Fila mal formada en bitácora de gestor')
    _, name, state, info = parts
    if name == 'GESTOR' and state == 'INICIO' and info == 'perfil=laptop jobs=16 concurrencia=14':
        manager_start += 1
    elif name in expected and state == 'LANZADA' and info.startswith('pid=') and ' sha=d2ebf11' in info:
        if name in launched:
            raise SystemExit(f'LANZADA duplicada: {name}')
        launched.add(name)
    elif name in expected and state == 'IDENTIDAD' and info.startswith('día='):
        day = int(info.split()[0].split('=')[1])
        if day not in (1, 2, 3) or day in identities[name] or ' sha256=' not in info:
            raise SystemExit(f'IDENTIDAD inesperada: {name} {info}')
        identities[name].add(day)
    else:
        raise SystemExit(f'Evento inesperado en bitácora interrumpida: {name} {state}')
if manager_start != 1 or launched != expected or any(days != {1, 2, 3} for days in identities.values()):
    raise SystemExit('Bitácora interrumpida no acredita 14 lanzamientos e identidades 1–3')
print('GESTOR INTERRUMPIDO; 14 hijos lanzados')
PY
)
[[ $progress_ok == 'GESTOR INTERRUMPIDO; 14 hijos lanzados' ]]

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
for seed in 5 29 101 202 404; do
  names+=("PUB2-$seed")
  sources+=("/home/stev/atlas-lab/f21b/PUB2-$seed")
  destinations+=("$BASE/f21b-portatil/PUB2-$seed")
  seeds+=("$seed")
done

# Preflight de todas las réplicas antes del primer rsync. Un destino de un
# intento anterior solo se reutiliza si sus 61 huellas igualan el origen.
manifests=()
already=()
for i in "${!names[@]}"; do
  destination=${destinations[$i]}
  manifests+=("$(validate_remote "${sources[$i]}" "${seeds[$i]}")")
  if [[ -e $destination || -L $destination ]]; then
    local_manifest=$(validate_local "$destination" "${seeds[$i]}")
    [[ $local_manifest == "${manifests[$i]}" ]] || {
      echo "Destino existente difiere del origen; se conserva: $destination" >&2
      exit 1
    }
    already+=(1)
  else
    already+=(0)
  fi
  echo "Preflight completo: ${names[$i]}"
done

files=()
for day in $(seq -w 1 60); do files+=("dia-0${day}.json"); done
files+=(replica.json)
for i in "${!names[@]}"; do
  destination=${destinations[$i]}
  if [[ ${already[$i]} == 1 ]]; then
    local_manifest=$(validate_local "$destination" "${seeds[$i]}")
    remote_manifest=$(validate_remote "${sources[$i]}" "${seeds[$i]}")
    [[ $local_manifest == "${manifests[$i]}" && $remote_manifest == "${manifests[$i]}" ]] || {
      echo "Origen o destino cambió tras el preflight: ${names[$i]}" >&2
      exit 1
    }
    echo "Ya estaba copiada y validada: ${names[$i]}"
    continue
  fi
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
progress_sha=$("${SSH[@]}" "$REMOTE" "python3 - '$PROGRESS'" <<'PY'
import hashlib
from pathlib import Path
import stat
import sys
p = Path(sys.argv[1])
if not stat.S_ISREG(p.lstat().st_mode):
    raise SystemExit('Bitácora remota no regular')
print(hashlib.sha256(p.read_bytes()).hexdigest())
PY
)
if [[ -e $progress_target || -L $progress_target ]]; then
  local_progress_sha=$(python3 - "$progress_target" <<'PY'
import hashlib
from pathlib import Path
import stat
import sys
p = Path(sys.argv[1])
if not stat.S_ISREG(p.lstat().st_mode):
    raise SystemExit('Bitácora local no regular')
print(hashlib.sha256(p.read_bytes()).hexdigest())
PY
)
  [[ $local_progress_sha == "$progress_sha" ]] || {
    echo "Bitácora local difiere de la remota; se conserva: $progress_target" >&2
    exit 1
  }
  echo "Bitácora ya estaba copiada y validada: $progress_target"
  exit 0
fi
progress_stage=$(mktemp "$balance/.codex-laptop-20260926.XXXXXX")
rsync -a --no-links -e "$RSYNC_SSH" "$REMOTE:$PROGRESS" "$progress_stage"
local_progress_sha=$(python3 - "$progress_stage" <<'PY'
import hashlib
from pathlib import Path
import stat
import sys
p = Path(sys.argv[1])
if not stat.S_ISREG(p.lstat().st_mode):
    raise SystemExit('Bitácora copiada no regular')
print(hashlib.sha256(p.read_bytes()).hexdigest())
PY
)
[[ $local_progress_sha == "$progress_sha" ]] || {
  echo "Bitácora cambió durante la copia; staging conservado: $progress_stage" >&2
  exit 1
}
publish_new "$progress_stage" "$progress_target"
