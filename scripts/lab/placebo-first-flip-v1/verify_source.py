"""Safe Python source/hash/diff authoring check. Never executes TS/World/tests.
The source proof removes only named additions and unwraps the unchanged gate.
Any other original-byte difference fails closed; this is not dynamic parity.
"""
import ast
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BASE = '6516c62e06fe2b22493e029022fab7f32388b674'
sha = lambda b: hashlib.sha256(b).hexdigest()


def verify():
    original = subprocess.check_output(['git','-c','core.fsmonitor=false','show',BASE+':src/world/index.ts'],cwd=ROOT)
    stored = (ROOT/'.orchestration/placebo-first-flip-v1/index.original.ts.txt').read_bytes()
    current = (ROOT/'src/world/index.ts').read_bytes()
    if stored != original:
        raise ValueError('Original source snapshot mismatch')
    source = current.decode()
    # Named blocks have no nesting; lines outside them are original.
    restored = re.sub(r'^[ \t]*// BEGIN PLACEBO-FIRST-FLIP-V1[^\n]*\n.*?^[ \t]*// END PLACEBO-FIRST-FLIP-V1[^\n]*\n', '', source, flags=re.M|re.S)
    restored = restored.replace('\n\nfunction choose', '\nfunction choose', 1)
    gate = next(line for line in original.decode().splitlines() if 'if (!agreedWait &&' in line)
    wrapped = gate.replace(' choose(world, person);', ' {\n    choose(world, person);\n  }')
    if restored.count(wrapped) != 1:
        raise ValueError('Gate expression changed')
    restored = restored.replace(wrapped, gate)
    if restored.encode() != original:
        raise ValueError('Original source expressions/bytes changed outside passive additions')
    ast.parse((ROOT/'scripts/lab/placebo-first-flip-v1/reader.py').read_text())
    identity_path = ROOT/'scripts/lab/placebo-first-flip-v1/identity.json'
    if identity_path.exists():
        identity = json.loads(identity_path.read_text())
        if identity['sourceSHA'] != sha(current) or identity['originalIndexSHA'] != sha(original):
            raise ValueError('Identity source pins stale')
        world_hash = hashlib.sha256()
        for path in sorted((ROOT/'src/world').glob('*.ts')):
            world_hash.update(path.name.encode()); world_hash.update(b'\0'); world_hash.update(path.read_bytes())
        harness_hash = hashlib.sha256()
        for name in identity['harnessFiles']:
            harness_hash.update(name.encode()); harness_hash.update(b'\0'); harness_hash.update((ROOT/name).read_bytes())
        if world_hash.hexdigest() != identity['worldSourceHash'] or harness_hash.hexdigest() != identity['harnessHash']:
            raise ValueError('World/harness pins stale')
    print(json.dumps({'check':'SOURCE_BYTES_AND_PYTHON_AST_ONLY','originalIndexSHA':sha(original),
      'sourceSHA':sha(current),'restoredOriginalEqual':True,'dynamicParity':'NOT_RUN','tests':'NOT_RUN'},indent=2))


if __name__ == '__main__':
    verify()
