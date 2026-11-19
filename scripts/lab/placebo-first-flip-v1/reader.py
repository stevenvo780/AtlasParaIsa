"""Offline, bounded streaming reader. No World imports; no history reconstruction.
Only valid complete paired iteration witnesses can support a bounded NO_FLIP.
CLI: reader.py CTRL.jsonl PLAC.jsonl sealed-prereg.json identity.json [--max-bytes N]
The byte limit is an operational allocation cap, never a scientific threshold.
"""
import argparse
import hashlib
import json
import math
import struct
from pathlib import Path


def digest(b):
    return hashlib.sha256(b).hexdigest()


def js_json(v):
    return json.dumps(v, separators=(',', ':'), ensure_ascii=False)


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def sha256_string(x):
    return type(x) is str and len(x) == 64 and all(c in '0123456789abcdef' for c in x)


def integer(x):
    return type(x) is int and x >= 0


def projection(p, bits=False):
    require(type(p) is dict and set(p) == {'action', 'target', 'decisionAt', 'thirstBits'}, 'MALFORMED_PROJECTION')
    require(p['action'] in {'explore','eat','forage','drink','hunt','rest','approach','accompany','retreat','share','gather','farm','build','cooperate','invent','repair','research','craft'}, 'ACTION_UNKNOWN')
    require(integer(p['decisionAt']), 'DECISION_AT_UNKNOWN')
    t = p['target']
    require(type(t) is dict and set(t) == {'x', 'y'} and all(type(t[k]) in (int,float) and math.isfinite(t[k]) for k in t), 'TARGET_UNKNOWN')
    b = p['thirstBits']
    require(type(b) is str and ((not bits and b == 'UNKNOWN') or (len(b) == 16 and all(c in '0123456789abcdef' for c in b))), 'BITS_UNKNOWN')
    if b != 'UNKNOWN':
        thirst = struct.unpack('>d', bytes.fromhex(b))[0]
        require(math.isfinite(thirst) and 0 <= thirst <= 1, 'THIRST_BITS_INVALID')


def effective(p):
    return p['action'], p['target']['x'], p['target']['y']


class Stream:
    def __init__(self, path, max_bytes):
        self.path = Path(path)
        self.size = self.path.stat().st_size
        require(0 < self.size <= max_bytes, 'OUTFILE_BOUND')
        self.file = self.path.open('rb')
        self.seq = 0
        self.consumed = 0
        self.cache = {}
        self.gates = self.decisions = self.windows = 0
        self.header = self.line()
        require(self.header.get('kind') == 'header', 'HEADER_MISSING')

    def line(self):
        # A corrupt giant line must not allocate the entire file.
        raw = self.file.readline(min(self.size + 1, 16 * 1024 * 1024))
        self.consumed += len(raw)
        require(raw.endswith(b'\n'), 'HISTORY_GAP_OR_LINE_BOUND')
        r = json.loads(raw)
        require(type(r) is dict and type(r.get('seq')) is int and r['seq'] == self.seq + 1, 'BROKEN_SEQ')
        self.seq += 1
        return r

    def window(self, tick):
        r = self.line()
        require(r.get('kind') == 'window' and r.get('tick') == tick, 'HISTORY_GAP')
        require(integer(r.get('expected')) and integer(r.get('visited')), 'COVERAGE_UNKNOWN')
        changes, removed, commits = r.get('changes'), r.get('removed'), r.get('commits')
        require(all(type(x) is list for x in (changes, removed, commits)), 'MALFORMED_DTO')
        require(len(removed) == len(set(removed)) and all(i in self.cache for i in removed), 'ARCHIVE_GAP')
        for i in removed:
            del self.cache[i]
        seen = set()
        for g in changes:
            require(type(g) is dict and set(g) == {'id','ordinal','eligible','path','pre','post'}, 'MALFORMED_GATE')
            require(type(g['id']) is str and g['id'] and g['id'] not in seen and integer(g['ordinal']) and g['ordinal'] > 0, 'GATE_ID_ORDER')
            require(type(g['eligible']) is bool and g['path'] in ('gate','preparation'), 'ELIGIBILITY_UNKNOWN')
            require(g['path'] != 'preparation' or not g['eligible'], 'PREPARATION_DECISION')
            projection(g['pre']); projection(g['post'])
            if not g['eligible']:
                require(g['pre'] == g['post'], 'NO_DECISION_MUTATION')
            self.cache[g['id']] = g
            seen.add(g['id'])
        ordered = sorted(self.cache.values(), key=lambda g: g['ordinal'])
        require([g['ordinal'] for g in ordered] == list(range(1, len(ordered)+1)), 'ITERATION_GAP')
        ids = [g['id'] for g in ordered]
        require(r['expected'] == r['visited'] == len(ids) and r.get('rosterHash') == digest(js_json(ids).encode()), 'WITNESS_MISMATCH')
        selected = {}
        last_ordinal = 0
        for c in commits:
            require(type(c) is dict and set(c) == {'kind','tick','id','ordinal','pre','post','selectedAction','selectedTarget','selectedScoreBits','candidateCount','reasonHash'}, 'MALFORMED_COMMIT')
            require(c['kind'] == 'commit' and c['tick'] == tick and c['id'] in self.cache and c['id'] not in selected, 'COMMIT_ID')
            g = self.cache[c['id']]
            require(g['eligible'] and c['id'] in seen and c['ordinal'] == g['ordinal'] and c['ordinal'] > last_ordinal, 'COMMIT_GATE_ORDER')
            last_ordinal = c['ordinal']
            projection(c['pre'], True); projection(c['post'], True)
            require(integer(c['candidateCount']) and c['candidateCount'] > 0, 'CANDIDATES_UNKNOWN')
            require(type(c['selectedScoreBits']) is str and len(c['selectedScoreBits']) == 16 and all(x in '0123456789abcdef' for x in c['selectedScoreBits']), 'SCORE_UNKNOWN')
            require(math.isfinite(struct.unpack('>d', bytes.fromhex(c['selectedScoreBits']))[0]), 'SCORE_BITS_INVALID')
            require(c['reasonHash'] == 'UNKNOWN' or (type(c['reasonHash']) is str and len(c['reasonHash']) == 64), 'REASON_UNKNOWN')
            require(c['selectedAction'] == c['post']['action'] and c['selectedTarget'] == c['post']['target'], 'SELECTED_COMMIT_MISMATCH')
            for side in ('pre','post'):
                require(effective(c[side]) == effective(g[side]) and c[side]['decisionAt'] == g[side]['decisionAt'], 'GATE_COMMIT_MISMATCH')
            selected[c['id']] = c
        require(set(selected) == {g['id'] for g in ordered if g['eligible']}, 'MISSING_COMMIT')
        self.gates += len(ids); self.decisions += len(selected); self.windows += 1
        require(r.get('gateTotal') == self.gates and r.get('decisionTotal') == self.decisions, 'COUNTER_MISMATCH')
        return self.cache, selected

    def finish(self):
        r = self.line()
        require(r.get('kind') == 'footer' and r.get('complete') is True and r.get('windows') == self.windows and r.get('gateTotal') == self.gates and r.get('decisionTotal') == self.decisions, 'INCOMPLETE')
        require(self.file.read(1) == b'' and self.consumed == self.size, 'TRAILING_OR_CHANGED_DATA')
        return r.get('receipt')

    def close(self):
        self.file.close()


def compare(control, treatment, prereg_path, identity_path, max_bytes=512*1024*1024):
    streams = []
    report = {'status':'UNKNOWN', 'firstFlip':None, 'ScientificAcceptance':False, 'R0':'UNKNOWN',
              'eligibilityDivergence':0, 'gateScheduleDivergence':0, 'floatOnly':0, 'opportunities':0,
              'firstEligibilityDivergence':None, 'firstFloatOnly':None, 'thirstBitsDivergence':0, 'scoreBitsDivergence':0, 'missingGates':[], 'coverage':'INCOMPLETE'}
    try:
        require(0 < Path(prereg_path).stat().st_size <= 1024*1024 and 0 < Path(identity_path).stat().st_size <= 1024*1024, 'BINDING_FILE_BOUND')
        prereg_bytes = Path(prereg_path).read_bytes()
        p = json.loads(prereg_bytes)
        ident = json.loads(Path(identity_path).read_text())
        require(p.get('dataKind') in ('NATIVE','SYNTHETIC'), 'DATA_KIND_UNKNOWN')
        report['evidenceKind'] = p['dataKind']
        require(p.get('status') == 'SEALED' and p.get('sealedBeforeData') is True, 'PREREG_MISSING')
        require(p.get('originalHEAD') == '6516c62e06fe2b22493e029022fab7f32388b674', 'ORIGINAL_SOURCE_MISMATCH')
        require(p.get('lowerInclusive') == 4807 and p.get('firstTick') == 1 and integer(p.get('endTick')) and 1 <= p['endTick'] <= 144000, 'WINDOW_MISMATCH')
        for path in (control, treatment):
            streams.append(Stream(path, max_bytes))
        a,b = streams
        ha,hb = a.header,b.header
        for h in (ha,hb):
            require(h.get('version') == 1 and h.get('dataKind') == p['dataKind'] and h.get('preregSHA') == digest(prereg_bytes), 'PREREG_BINDING')
            require(h.get('fieldCoverage') == {'gate':'ALL_ACTUAL_ITERATIONS','prePost':'ACTION_TARGET_DECISION_AT','thirstBits':'COMMIT_ONLY','selectedScoreBits':'COMMIT_ONLY','candidateCount':'COMMIT_ONLY','reasonHash':'UNKNOWN_NOT_EXPORTED','sourceOrdinal':'ACTUAL_ITERATION'}, 'FIELD_COVERAGE_UNKNOWN')
            for key in ('sourceSHA','worldSourceHash','harnessHash'):
                require(h.get(key) == ident.get(key) == p.get(key) and type(h.get(key)) is str and len(h[key]) == 64, 'SOURCE_MISMATCH')
            require(all(sha256_string(h.get(key)) for key in ('sourceSHA','worldSourceHash','harnessHash','initialHash','paramsHash','runtimeHash','preregSHA')), 'MALFORMED_BINDING')
            require(type(h.get('runId')) is str and h['runId'] and type(h.get('pairedRunId')) is str and h['pairedRunId'], 'MALFORMED_RUN_ID')
            for key in ('seed','initialHash','paramsHash','runtimeHash','firstTick','endTick','lowerInclusive','pairId'):
                require(key in p and h.get(key) == p[key], 'PAIR_INPUT_MISMATCH:'+key)
        require(ha.get('arm') == 'CTRL' and hb.get('arm') == 'PLAC' and ha.get('runId') != hb.get('runId') and ha.get('pairedRunId') == hb.get('runId') and hb.get('pairedRunId') == ha.get('runId'), 'UNPAIRED_CONTROL')
        report['window'] = {'firstTick':1,'lowerInclusive':4807,'endTick':p['endTick']}
        require(p.get('actor') == 'descendant-1' and p.get('thirstBeforeBits') == '3fc3f8dd73b519d9' and p.get('thirstAfterBits') == '3fc3f8dd73b519d8' and p.get('seed') == 18107, 'INTERVENTION_MISMATCH')
        continuity = True
        actor_opportunities = 0
        for tick in range(1, p['endTick']+1):
            ga,ca = a.window(tick); gb,cb = b.window(tick)
            if set(ga) != set(gb):
                continuity = False
                if len(report['missingGates']) < 16:
                    report['missingGates'].append({'tick':tick,'CTRL_only':sorted(set(ga)-set(gb)), 'PLAC_only':sorted(set(gb)-set(ga)), 'cause':'UNKNOWN_DEATH_ARCHIVE_OR_GAP'})
            if any(ga[i]['ordinal'] != gb[i]['ordinal'] for i in set(ga) & set(gb)):
                continuity = False
            if tick < p['lowerInclusive']:
                require(ga == gb and ca == cb, 'PRE_INTERVENTION_DIVERGENCE')
                continue
            for person in sorted(set(ga) & set(gb), key=lambda i: ga[i]['ordinal']):
                x,y = ga[person],gb[person]
                if effective(x['pre']) != effective(y['pre']) and report['firstFlip'] is None:
                    continuity = False
                decision = x['eligible'] or y['eligible']
                if x['eligible'] != y['eligible']:
                    report['eligibilityDivergence'] += 1
                    if report['firstEligibilityDivergence'] is None:
                        report['firstEligibilityDivergence'] = {'tick':tick, 'id':person, 'CTRL':x, 'PLAC':y}
                if x['post']['decisionAt'] != y['post']['decisionAt'] or x['path'] != y['path']:
                    report['gateScheduleDivergence'] += 1
                if decision:
                    report['opportunities'] += 1
                    actor_opportunities += person == p['actor']
                    changed = (person in ca and effective(ca[person]['pre']) != effective(ca[person]['post'])) or (person in cb and effective(cb[person]['pre']) != effective(cb[person]['post']))
                    if changed and effective(x['post']) != effective(y['post']) and report['firstFlip'] is None:
                        report['firstFlip'] = {'tick':tick,'id':person,'unilateral':x['eligible'] != y['eligible'], 'CTRL':ca.get(person,x), 'PLAC':cb.get(person,y), 'continuityBefore':continuity}
                    elif effective(x['post']) != effective(y['post']) and report['firstFlip'] is None:
                        continuity = False  # Divergence without an observed changing commit.
                    elif person in ca and person in cb:
                        thirst_diff = ca[person]['post']['thirstBits'] != cb[person]['post']['thirstBits']
                        score_diff = ca[person]['selectedScoreBits'] != cb[person]['selectedScoreBits']
                        report['thirstBitsDivergence'] += thirst_diff
                        report['scoreBitsDivergence'] += score_diff
                        if thirst_diff or score_diff:
                            report['floatOnly'] += 1
                            if report['firstFloatOnly'] is None:
                                report['firstFloatOnly'] = {'tick':tick,'id':person,'CTRL':ca[person],'PLAC':cb[person]}
                elif effective(x['post']) != effective(y['post']) and report['firstFlip'] is None:
                    continuity = False
        ra,rb = a.finish(),b.finish()
        if p['endTick'] >= 4807:
            require(ra is None and rb == {'tick':4807,'personaId':p['actor'],'variable':'thirst','direccion':'down','beforeBits':p['thirstBeforeBits'],'afterBits':p['thirstAfterBits']}, 'RECEIPT_MISMATCH')
        else:
            require(ra is None and rb is None, 'EARLY_INTERVENTION')
        report['iterationCoverage'] = 'COMPLETE'
        report['coverage'] = 'COMPLETE' if continuity else 'INCOMPLETE'
        if not actor_opportunities:
            report['actorOpportunity'] = 'NO_OPPORTUNITY'
        else:
            report['actorOpportunity'] = actor_opportunities
        report['counters'] = {s.header['arm']:{'windows':s.windows,'gates':s.gates,'decisions':s.decisions,'bytes':s.size} for s in streams}
        flip = report['firstFlip']
        if flip and flip['continuityBefore'] and continuity:
            report['status'] = 'FIRST_FLIP'
        elif not continuity:
            report['reason'] = 'HISTORY_OR_POPULATION_GAP'
        elif not actor_opportunities:
            report['reason'] = 'NO_OPPORTUNITY'
        else:
            report['status'] = 'NO_FLIP'
        # Diagnostic early windows never discharge the full scientific panel.
        report['fullOriginalWindow'] = p['endTick'] == 144000
    except (ValueError, KeyError, TypeError, OSError, OverflowError) as e:
        report['reason'] = str(e)
        report['status'] = 'UNKNOWN'
        report['coverage'] = 'INCOMPLETE'
    finally:
        for s in streams:
            s.close()
    return report


if __name__ == '__main__':
    cli = argparse.ArgumentParser()
    for name in ('control','treatment','prereg','identity'):
        cli.add_argument(name)
    cli.add_argument('--max-bytes',type=int,default=512*1024*1024)
    args = cli.parse_args()
    print(json.dumps(compare(args.control,args.treatment,args.prereg,args.identity,args.max_bytes),indent=2))
