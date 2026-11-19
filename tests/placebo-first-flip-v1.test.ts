/** Authored here; execute only in ROOT's newly authorized native capsule. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manualFixture, type Scenario } from '../scripts/lab/placebo-first-flip-v1/fixtures/manual.js';
const scenarios: Scenario[] = JSON.parse(readFileSync(new URL('../scripts/lab/placebo-first-flip-v1/fixtures/scenarios.json',import.meta.url),'utf8'));
for (const scenario of scenarios) test(`prospective first flip: ${scenario.name}`, () => {
  assert.equal(process.env.ATLAS_FIRST_FLIP_NATIVE_CAPSULE, '1', 'ROOT native capsule required');
  const dir=mkdtempSync(join(tmpdir(),'first-flip-private-'));
  try {
    const args=manualFixture(dir,scenario);
    const report=JSON.parse(execFileSync('python3',['scripts/lab/placebo-first-flip-v1/reader.py',...args],{encoding:'utf8'}));
    assert.equal(report.status,scenario.expect);
    assert.equal(report.ScientificAcceptance,false);assert.equal(report.R0,'UNKNOWN');
    if (scenario.expect==='FIRST_FLIP') assert.equal(report.firstFlip.tick,4807);
    if (scenario.variant==='unilateral') {assert.equal(report.firstFlip.unilateral,true);assert.equal(report.firstEligibilityDivergence.tick,4807);}
    if (scenario.variant==='gate') {assert.equal(report.firstFlip,null);assert.ok(report.eligibilityDivergence>0);assert.ok(report.gateScheduleDivergence>0);}
    if (scenario.variant==='float') {assert.ok(report.floatOnly>0);assert.equal(report.firstFlip,null);}
    if (scenario.variant==='death') assert.equal(report.reason,'NO_OPPORTUNITY');
    if (scenario.variant==='source') assert.equal(report.reason,'SOURCE_MISMATCH');
    if (scenario.variant==='transient') assert.equal(report.firstFlip.PLAC.post.action,'eat');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
