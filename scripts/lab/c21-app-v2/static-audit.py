#!/usr/bin/python3.14
"""Author static audit; no native launch and no import of the runtime harness."""
import ast
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys
sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[3]
LOCAL = ROOT / 'scripts/lab/c21-app-v2'
OWN = ROOT / '.orchestration/c21-app-v2'
sys.path.insert(0, str(LOCAL))
from pins import closure, sha


def main():
    manifest = json.loads((OWN / 'MANIFEST.json').read_text())
    assert Path(sys.executable).resolve() == Path('/usr/bin/python3.14').resolve()
    for file in LOCAL.glob('*.py'):
        ast.parse(file.read_text(), filename=str(file))
    for file in list(LOCAL.glob('*.json')) + list(OWN.glob('*.json')):
        json.loads(file.read_text())
    for rel, expected in {**manifest['sourcePins'], **manifest['authorPins']}.items():
        assert sha(ROOT / rel) == expected, rel
    for name in ('authorityPins', 'runtimePins', 'rootBindings'):
        for file, expected in manifest[name].items():
            assert sha(file) == expected, file
    assert sha(ROOT / '.orchestration/c21-app-v1/MANIFEST.json') == '6c08dc426e839c03f718800c96be944501c8fe5795d0065cc4fa72e4e83719ab'
    assert closure(ROOT / 'node_modules') == manifest['dependencyClosure']
    typed = manifest['dependencyClosure']
    assert sum(v['kind'] == 'symlink' for v in typed.values()) == 8
    assert sum(v['kind'] != 'directory' for v in typed.values()) == 1773
    assert len(manifest['nodeRuntimeSourceFiles']) == 105
    original = json.loads((ROOT / 'scripts/lab/c21-app-v1/case-plan.json').read_text())
    current = json.loads((LOCAL / 'case-plan.json').read_text())
    assert len(current['cases']) == len({c['caseId'] for c in current['cases']}) == 115
    for a, b in zip(original['cases'], current['cases'], strict=True):
        for key, value in a.items():
            assert b[key] == value, (a['caseId'], key)
        assert b['classification'] == 'UNKNOWN'
    baseline = json.loads((OWN / 'FOREIGN-BASELINE.json').read_text())
    drift = [rel for rel, expected in baseline.items() if sha(ROOT / rel) != expected]
    assert not drift, drift
    for command in manifest['nativeArgv'].values():
        assert command[0] == '/usr/bin/python3.14'
        assert command[1] == '-I'
    for file in LOCAL.iterdir():
        if file.is_file():
            for number, line in enumerate(file.read_text().splitlines(), 1):
                assert line == line.rstrip(), (file.name, number)
    diff = subprocess.run(['git', '-c', 'core.fsmonitor=false', 'diff', '--check'], cwd=ROOT,
                          capture_output=True, text=True, check=False)
    assert diff.returncode == 0, diff.stdout + diff.stderr
    report = {'schema': 'c21-app-author-static-validation/v2',
              'recordedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'pythonAst': 'PASS', 'jsonParse': 'PASS', 'pins': 'PASS', 'typedClosure': 'PASS',
              'dependencyFilesAndLinks': 1773, 'symlinksTypedWithoutExceptions': 8,
              'nodeRuntimeSourceFiles': 105, 'foreignBaselineUnchanged': len(baseline),
              'foreignDrift': [], 'originalCaseValuesPreserved': 115, 'casePASS': 0, 'caseUNKNOWN': 115,
              'gitDiffCheck': 'PASS', 'newSourceWhitespace': 'PASS',
              'jsSyntax': 'NOT_RUN_NATIVE_ONLY', 'manualFixturesExecution': 'NOT_RUN_NO_TESTS',
              'nodeImportsBuildTestsSocketsUnits': 'NOT_RUN', 'c21': 'UNKNOWN',
              'scientificAcceptance': False, 'scope': 'AUTHOR_STATIC_ONLY'}
    (OWN / 'VALIDATION.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
