import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { expectedOn, exactKeys, requireDecisionWorldAlignment, sidecarMatches } from './driver.mjs';
import { canonicalGraph, firstCutDifference } from './comparator.mjs';

test('clock bridge separates attempts even when they reuse one physical tick',()=>{
  const rows=[
    {siteId:'step-start',callOrdinal:1,attemptId:null,tick:8,clockDomain:'app-monotonic' as const,
      value:10,phase:'step' as const,attemptIndex:1},
    {siteId:'step-start',callOrdinal:2,attemptId:null,tick:8,clockDomain:'app-monotonic' as const,
      value:11,phase:'step' as const,attemptIndex:2},
  ];
  const mapped=expectedOn(rows,'run','e');
  assert.deepEqual(mapped.map(row=>row.attemptId),['run:e:attempt-2','run:e:attempt-3']);
  assert.deepEqual(mapped.map(row=>row.callOrdinal),[1,1]);
  assert.deepEqual(mapped.map(row=>row.tick),[8,8]);
});

test('all common fields are mandatory; no three-field shortcut',()=>{
  assert.throws(()=>exactKeys({pending:[],beats:[],governor:{}},
    ['pending','beats','governor','worldTick'],'APP_STATE_INCOMPLETE'),/APP_STATE_INCOMPLETE/);
});

test('B/C extension rejects false alignment even when both arms would agree',()=>{
  assert.deepEqual(requireDecisionWorldAlignment({decisionWorldAlignment:true}),
    {decisionWorldAlignment:true});
  assert.throws(()=>requireDecisionWorldAlignment({decisionWorldAlignment:false}),
    /BC_DECISION_WORLD_MISALIGNED/);
  assert.throws(()=>requireDecisionWorldAlignment({decisionWorldAlignment:'true'}),
    /BC_DECISION_WORLD_MISALIGNED/);
  assert.throws(()=>requireDecisionWorldAlignment({}),/BC_EXTENSION_INCOMPLETE/);
});

test('equal-length same-line-count sidecar tampering fails independent intended-byte seal',()=>{
  const intended=Buffer.from('{"siteId":"alpha"}\n');
  const tampered=Buffer.from('{"siteId":"omega"}\n');
  assert.equal(intended.length,tampered.length);
  const digest=createHash('sha256').update(intended).digest('hex');
  assert.equal(sidecarMatches(intended,digest,intended.length,1),true);
  assert.equal(sidecarMatches(tampered,digest,intended.length,1),false);
});

test('ordered arrays and IDs remain distinct in the private comparator',()=>{
  const fixture={ids:['a','b'],rng:7};
  const left=canonicalGraph(fixture);
  // The report locates a scalar in the canonical graph, rather than a source key.
  // Dereference that numeric location independently and verify the named fixture field.
  const at=(bytes:Buffer,path:string):unknown=>{
    assert.match(path,/^\$(?:\[\d+\])+$/);
    const indices=[...path.matchAll(/\[(\d+)\]/g)].map(match=>Number(match[1]));
    return indices.reduce<unknown>((node,index)=>{
      assert.ok(Array.isArray(node));assert.ok(index<node.length);return node[index];
    },JSON.parse(bytes.toString('utf8')) as unknown);
  };
  assert.equal(at(left,'$[3][0][1]'),'ids');
  assert.equal(at(left,'$[3][0][5][2]'),'Array');
  assert.equal(at(left,'$[3][0][5][3][0][1]'),'0');
  assert.equal(at(left,'$[3][0][5][3][1][1]'),'1');
  assert.equal(firstCutDifference(left,canonicalGraph({ids:['a','b'],rng:7})),null);
  const check=(ids:string[],path:string,leftId:string,rightId:string)=>{
    const right=canonicalGraph({ids,rng:7});
    const difference=firstCutDifference(left,right);assert.ok(difference);
    assert.equal(difference.path,path);
    assert.equal(at(left,path),leftId);assert.equal(at(right,path),rightId);
    assert.deepEqual(Object.keys(difference).sort(),['leftSha256','path','rightSha256']);
    assert.equal(difference.leftSha256,createHash('sha256').update(left).digest('hex'));
    assert.equal(difference.rightSha256,createHash('sha256').update(right).digest('hex'));
    assert.notEqual(difference.leftSha256,difference.rightSha256);
  };
  // Same identities, reversed order: sorting IDs would erase this first difference.
  check(['b','a'],'$[3][0][5][3][0][5][1]','a','b');
  // Same order/length, changed second identity: treating distinct IDs as equal must fail.
  check(['a','c'],'$[3][0][5][3][1][5][1]','b','c');
});
