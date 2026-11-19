#!/usr/bin/python3.14
"""Reproducible static freeze. No Node, build, native launch or runtime imports."""
import sys
sys.dont_write_bytecode = True
from pathlib import Path
LOCAL = Path(__file__).resolve().parent
sys.path.insert(0, str(LOCAL))
import json
from pins import closure, encoded, sha

ROOT = LOCAL.parents[2]
OWN = ROOT / '.orchestration/c21-app-v2'


def put(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def main():
    oldfile = ROOT / '.orchestration/c21-app-v1/MANIFEST.json'
    old = json.loads(oldfile.read_text())
    if sha(oldfile) != '6c08dc426e839c03f718800c96be944501c8fe5795d0065cc4fa72e4e83719ab':
        raise RuntimeError('ORIGINAL_AUTHOR_MANIFEST_CHANGED')
    plan = json.loads((ROOT / 'scripts/lab/c21-app-v1/case-plan.json').read_text())
    mapping = {'B01-F': 'WRITE_BEFORE_BEGIN', 'B02-F': 'WRITE_BEFORE_FLUSH',
               'B10-F': 'WRITE_BEFORE_COMMIT', 'A01-F': 'WRITE_AFTER_COMMIT'}
    for case in plan['cases']:
        case_id = case['caseId']
        case['v2Binding'] = {'mechanismImplemented': case_id in mapping or case_id in {'S01', 'S02', 'S03', 'S04', 'D01'},
                             'exactCaseConformanceImplemented': False, 'status': 'UNKNOWN',
                             'hook': mapping.get(case_id),
                             'reason': 'Native mechanism needs observed receipt plus independent manual ledger and v3 bundle'
                             if case_id in mapping else 'Client/recovery partial mechanism' if case_id in {'S01','S02','S03','S04','D01'}
                             else 'No exact private injector or independent fixture for this original case; not substituted'}
    plan['schemaV2Support'] = 'c21-app-case-bindings/v2'
    plan['originalPlanSha256'] = sha(ROOT / 'scripts/lab/c21-app-v1/case-plan.json')
    plan['allOriginalValuesPreserved'] = True
    plan['b02BeforeCommitAliasRejected'] = True
    put(LOCAL / 'case-plan.json', plan)
    stages = [p for p in old['stageFiles'] if p != 'scripts/lab/c21-app-v1/worker.mjs']
    stages += ['scripts/lab/c21-app-v2/worker.mjs', 'scripts/lab/c21-app-v2/projection.mjs']
    node_sources = [p for p in stages if p.startswith('src/') or p in {'package.json','package-lock.json','tsconfig.server.json'}]
    assert len(node_sources) == 105
    typed = closure(ROOT / 'node_modules')
    assert sum(e['kind'] == 'symlink' for e in typed.values()) == 8
    assert sum(e['kind'] != 'directory' for e in typed.values()) == 1773
    for rel, expected in old['dependencyPins'].items():
        assert typed[rel]['sha256'] == expected, rel
    put(OWN / 'TYPED-DEPENDENCIES.json', {'schema': 'c21-typed-copied-deps/v2',
                                         'originRoot': str((ROOT / 'node_modules').resolve()),
                                         'originalContentPins': 1773, 'linkCount': 8, 'entries': typed,
                                         'noExceptions': True, 'includeViteVolatileBytes': True})
    put(OWN / 'ORIGIN-METADATA.json', {'schema': 'c21-source-origins/v2',
                                      'authorOriginal': {'path': str(oldfile), 'sha256': sha(oldfile),
                                                         'sources': 119, 'dependencies': 1773, 'authorities': 16},
                                      'nodeRuntimeSourceFiles': {p: {'origin': str(ROOT / p), 'sha256': sha(ROOT / p),
                                                                    'copyInto': 'stage/' + p} for p in node_sources},
                                      'otherStageFiles': {p: {'origin': str(ROOT / p), 'sha256': sha(ROOT / p)}
                                                         for p in stages if p not in node_sources},
                                      'sourceImportPolicy': 'Only pinned source from this CWD; external dependency root is frozen lineage, never another WT source',
                                      'dependencyCopyPolicy': 'New private stage, preserve relative links, typed exhaustive closure pre/mid/post'})
    native = {}
    for mode, seconds in [('diagnostic', 60), ('campaign', 3600)]:
        native[mode] = ['/usr/bin/python3.14', '-I', str(LOCAL / 'run.py'), '--manifest', str(OWN / 'MANIFEST.json'),
                        '--admission', str(OWN / 'root-go' / f'{mode}-go.json'), '--mode', mode, '--duration', str(seconds)]
    guards = {'globalCpuStopPercent': 80, 'memAvailableFloorBytes': 44 * 1024 ** 3,
              'diskFreeFloorBytes': 220 * 1024 ** 3, 'outputPoolBytes': 60 * 1024 ** 3,
              'parentMemoryMaxBytes': 32 * 1024 ** 3, 'seriesBinding': 'serie24/std39/meta1',
              'monitorOwner': 'ROOT_NATIVE_CPU_COMPONENT', 'overrideAllowed': False}
    limits = dict(old['limits'], outputBytes=16 * 1024 ** 3, requestSeconds=120,
                  absoluteSeconds={'diagnostic': 900, 'campaign': 7200})
    prereg = {'schema': 'c21-app-preregistration-draft/v2', 'state': 'DRAFT_REQUIRES_ROOT_FIN_REVIEW',
              'runOrder': ['ONE_NEW_NATIVE_DIAGNOSTIC_60', 'REVIEW_REAL_DIAGNOSTIC', 'FIN_REVIEW_GO_LONG',
                           'NEW_CPU_ADMISSION_7200_SECONDS', 'CONTINUOUS_12_WS_3600_SECONDS', 'BOUNDED_SUPPORTED_FAULT_SUBSETS',
                           'ENUMERATE_ALL_115_WITH_UNKNOWN_REMAINDER', 'INDEPENDENT_V3_CONFORMANCE_REVIEW'],
              'nativeArgv': native, 'limitsProposedNotAdmitted': limits, 'globalGuards': guards,
              'fullEstimatedBudgetSeconds': {'exposure': 3600, 'prepareMax': 720, 'startupAndRoReaders': 540,
                                             'barrierHolds': 40, 'rawCutsAndRecovery': 720, 'httpAndTeardown': 360,
                                             'sum': 5980, 'requestedAbsoluteDeadline': 7200,
                                             'all115ExactConformanceDuration': 'UNKNOWN_UNIMPLEMENTED_REMAINDER',
                                             'basis': 'Conservative operational allocation, NOT measured runtime or PASS'},
              'requiredRootInputs': ['new diagnostic GO', 'native CPU long component manifest and hash',
                                     'finReview decision GO_LONG and hash', 'signed independent F21-B/C manual component expected manifest',
                                     'reviewed preregistration', 'fresh full resource admission'],
              'sourcePhaseMap': mapping, 'exact115ConformanceExecutor': 'NOT_IMPLEMENTED; keep unsupported cases UNKNOWN', 'beforeCommitRequestedB02MappedToOriginalB10': True,
              'repetitionsPerImplementedFCase': 1, 'observationHoldSecondsPerBarrier': 10,
              'protocolMultiplicity': '44 original B/A G/F cases remain denominator; no invented ten repetitions per hook',
              'guarantee': 'Process death under SQLite WAL synchronous=NORMAL; power-loss UNKNOWN',
              'independentManualComponentManifest': None, 'scientificAcceptance': False, 'c21': 'UNKNOWN'}
    put(OWN / 'PREREGISTRATION-DRAFT.json', prereg)
    authors = [p for p in LOCAL.iterdir() if p.is_file()]
    authors += [OWN / name for name in ('FOREIGN-BASELINE.json','TYPED-DEPENDENCIES.json','ORIGIN-METADATA.json','PREREGISTRATION-DRAFT.json')]
    roots = [ROOT / '.orchestration/C21-APP-NATIVE-COORD-v1.md', oldfile,
             Path('/datos/tmp-atlas-lab/orquestacion-20261003/recursos/QA-C21-APP-NATIVE-v2.md'),
             Path('/datos/tmp-atlas-lab/orquestacion-20261003/recursos/QA-C21-APP-NATIVE-v2.json'),
             Path('/datos/tmp-atlas-lab/orquestacion-20261003/muse-tmux/c21-app-peer-v1/REVIEW-v1.md'),
             Path('/datos/tmp-atlas-lab/orquestacion-20261003/recursos/c21-app-dependency-closure-v2.json')]
    manifest = {'schema': 'c21-app-native-manifest/v2', 'state': 'PREPARED_STATIC_NOT_NATIVE_VALIDATED',
                'head': old['head'], 'authorRequestedIdentity': old['authorRequestedIdentity'],
                'c21': 'UNKNOWN', 'scientificAcceptance': False, 'globalCampaignAcceptance': False,
                'sourcePins': {**old['sourcePins'], **{p: sha(ROOT / p) for p in stages}},
                'authorPins': {str(p.relative_to(ROOT)): sha(p) for p in sorted(authors)},
                'authorityPins': old['authorityPins'], 'runtimePins': old['runtimePins'], 'executables': old['executables'],
                'rootBindings': {str(p): sha(p) for p in roots},
                'dependencyRootResolved': str((ROOT / 'node_modules').resolve()),
                'dependencyClosure': typed, 'dependencyPins': old['dependencyPins'], 'nodeRuntimeSourceFiles': node_sources,
                'stageFiles': stages,
                'prepareArgv': [['{node}','--check','{stage}/scripts/lab/c21-app-v2/worker.mjs'],
                                ['{node}','--check','{stage}/scripts/lab/c21-app-v2/projection.mjs'],
                                *old['prepareArgv'][1:]],
                'runtimeArgv': ['{node}', '{stage}/scripts/lab/c21-app-v2/worker.mjs'],
                'nativeArgv': native, 'childEnvTemplate': dict(old['childEnvTemplate'], NODE_DISABLE_COMPILE_CACHE='1'),
                'limits': limits, 'globalGuards': guards,
                'resourceBudget': prereg['fullEstimatedBudgetSeconds'],
                'costUpperBoundCpuHours': {'diagnostic': 1, 'campaign': 8},
                'clients': [{'client': i, 'profile': 'fast' if i < 4 else 'slow' if i < 8 else 'nonreader',
                             'camera': i % 2, 'ackDelaySeconds': 0 if i < 4 else 2 if i < 8 else 10,
                             'session': 'ONE_SHARED_REAL_SYNTHETIC_SESSION', 'httpIdNamespace': f'c{i:02d}',
                             'deflateNegotiated': False} for i in range(12)],
                'faultPlan': {'diagnosticCases': ['B01-F','B10-F','A01-F'],
                              'campaignCases': ['B01-F','B02-F','B10-F','A01-F'],
                              'barrierObservationHoldSeconds': 10, 'repetitionsPerCase': 1,
                              'supportedSourceHooks': mapping, 'noFakePhase': True},
                'manualLedgerProvided': False, 'frozenV3BundleConformanceImplemented': False,
                'missingCoverage': ['signed F21-B/C independent material and history ledger', 'full frozen-v3 evidenceIndex/schema adapter',
                                    'B03-B09 and A02-A12 exact barriers and all graceful phase cases',
                                    'D02-D13 and additional transaction/load/origin interruption fixtures',
                                    'power-loss/kernel/device failure', 'permanent nonreaders and negotiated WS deflate',
                                    'one-camera-only vs two-camera physics control arm',
                                    'new native v2 diagnostic/Root finReview/full admission'],
                'nativeCpuComponent': 'REQUIRED_ROOT_SUPPLIED_NO_INTERNAL_DBUS'}
    put(OWN / 'MANIFEST.json', manifest)
    print(json.dumps({'manifestSha256': sha(OWN / 'MANIFEST.json'), 'authorPins': len(manifest['authorPins']),
                      'stageFiles': len(stages), 'nodeRuntimeSourceFiles': len(node_sources), 'caseIds': len(plan['cases']),
                      'nativeExecuted': False}))


if __name__ == '__main__':
    main()
