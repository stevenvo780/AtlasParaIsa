#!/usr/bin/env bash
# Copia únicamente resultados completos de CTRL2 y PUB2. No borra archivos.
set -euo pipefail

BASE=/datos/tmp-atlas-lab/datos-lab
REMOTE=stev@100.64.0.2
KEY=$HOME/.ssh/id_ed25519
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=8 -i "$KEY")
RSYNC_SSH="ssh -o BatchMode=yes -o ConnectTimeout=8 -i $KEY"

for seed in 2002 2004 2006 2007 2008 2009 2010 2011 2012; do
  name=CTRL2-$seed
  source=/home/stev/atlas-lab/c8panel/$name
  "${SSH[@]}" "$REMOTE" "test -f '$source/dia-060.json' && test -f '$source/replica.json'"
  rsync -a --checksum -e "$RSYNC_SSH" "$REMOTE:$source/" "$BASE/c8panel/portatil/$name/"
done

for seed in 5 29 101 202 404 606 707; do
  name=PUB2-$seed
  source=/home/stev/atlas-lab/f21b/$name
  "${SSH[@]}" "$REMOTE" "test -f '$source/dia-060.json' && test -f '$source/replica.json'"
  rsync -a --checksum -e "$RSYNC_SSH" "$REMOTE:$source/" "$BASE/f21b-portatil/$name/"
done

python3 - <<'PY'
import json
from pathlib import Path
base = Path('/datos/tmp-atlas-lab/datos-lab')
for campaign, arm, seeds in (
    ('c8panel/portatil', 'CTRL2', (2002, 2004, 2006, 2007, 2008, 2009, 2010, 2011, 2012)),
    ('f21b-portatil', 'PUB2', (5, 29, 101, 202, 404, 606, 707)),
):
    for seed in seeds:
        folder = base / campaign / f'{arm}-{seed}'
        meta = json.loads((folder / 'replica.json').read_text())
        assert meta['seed'] == seed and meta['dias'] == 60 and meta['sha'].startswith('d2ebf11'), folder
        for day in range(1, 61):
            body = json.loads((folder / f'dia-{day:03}.json').read_text())
            assert body['tick'] == day * 2400, (folder, day)
        print(f'{arm}-{seed}: 60 días y manifiesto verificados')
PY

progress=/home/stev/atlas-lab/codex-laptop-20260926.tsv
"${SSH[@]}" "$REMOTE" "test -f '$progress' && grep -Fq 'GESTOR' '$progress' && grep -Fq 'FIN' '$progress'"
rsync -a --checksum -e "$RSYNC_SSH" "$REMOTE:$progress" /datos/tmp-atlas-lab/balance/codex-laptop-20260926.tsv
