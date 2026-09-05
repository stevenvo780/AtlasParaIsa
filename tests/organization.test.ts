import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeOrganization } from '../src/world/organization.js';
import type { OrganizationExecution, OrganizationObservation, OrganizationProcess } from '../src/shared/organization.js';

const q = (resourceId: string, amount = 1) => ({ resourceId, amount });
const process = (id: string, output: string, catalyst: string, parents: string[] = []): OrganizationProcess => ({
  id, inputs: [q('raw')], outputs: [q(output)], catalysts: [catalyst], parents,
});
function execution(id: string, tick: number, processId: string, output: string, catalyst: string): OrganizationExecution {
  return { id, tick, processId, actorId: processId === 'make-a' ? 'ana' : 'bea', inputs: [q('raw')], outputs: [q(output)], catalysts: [{ resourceId: catalyst, wear: 0.5 }], success: true };
}
function cycle(): OrganizationObservation {
  return {
    window: { startTick: 0, endTick: 4, complete: true }, food: ['raw'],
    processes: [process('make-a', 'a', 'b'), process('make-b', 'b', 'a', ['make-a'])],
    executions: [execution('e1', 1, 'make-a', 'a', 'b'), execution('e2', 2, 'make-b', 'b', 'a'), execution('e3', 3, 'make-a', 'a', 'b'), execution('e4', 4, 'make-b', 'b', 'a')],
    resources: [
      { resourceId: 'raw', openingStock: 0, closingStock: 0, externalInput: 4, externalLoss: 0 },
      { resourceId: 'a', openingStock: 1, closingStock: 2, externalInput: 0, externalLoss: 0 },
      { resourceId: 'b', openingStock: 1, closingStock: 2, externalInput: 0, externalLoss: 0 },
    ],
  };
}

test('a repeated, materially balanced tool cycle has structural RAF and finite-window replacement, not certified autopoiesis', () => {
  const observation = cycle(), before = structuredClone(observation), report = analyzeOrganization(observation);
  assert.deepEqual(observation, before, 'the analyzer cannot change the simulation');
  assert.deepEqual(report.foodClosure, ['a', 'b', 'raw']);
  assert.deepEqual(report.maximalRaf, ['make-a', 'make-b']);
  assert.deepEqual(report.constructibleFromFood, [], 'mutual catalysts need a seed even when the network is RAF');
  assert.deepEqual(report.maintainedComponents, [['make-a', 'make-b']]);
  assert.equal(report.evidence.successful, 4); assert.equal(report.evidence.balanced, true);
  assert.deepEqual(report.evidence.rejected, []); assert.deepEqual(report.evidence.failures, []);
  assert.equal(report.maintenance.catalystReplacementCoverage, 1);
  assert.deepEqual(report.maintenance.catalystsWithCompleteTurnover, ['a', 'b']);
  assert.equal(report.diversity.effectiveProcesses, 2); assert.equal(report.diversity.maxAncestorDepth, 1);
  assert.deepEqual(report.actorActivity, [{ actorId: 'ana', processId: 'make-a', executions: 2 }, { actorId: 'bea', processId: 'make-b', executions: 2 }]);
  assert.deepEqual(report.actorRoles, [
    { actorId: 'ana', executions: 2, dominantProcessId: 'make-a', dominantShare: 1, effectiveProcesses: 1 },
    { actorId: 'bea', executions: 2, dominantProcessId: 'make-b', dominantShare: 1, effectiveProcesses: 1 },
  ]);
  assert.equal(report.autopoiesisEstablished, false); assert.equal(report.boundary, 'not-modeled');
  assert.ok(report.processes.every(item => item.maintained && item.fluxPerTick === 0.4));
});

test('an arbitrary SCC with an unreachable extra input is not food generated and cannot be an RAF', () => {
  const observation = cycle(); observation.processes[0]!.inputs.push(q('missing'));
  const report = analyzeOrganization(observation);
  assert.deepEqual(report.structuralComponents, [['make-a', 'make-b']], 'the apparent cycle still exists');
  assert.deepEqual(report.maximalRaf, []);
  assert.equal(report.processes.find(item => item.id === 'make-a')!.foodGenerated, false);
  assert.ok(report.evidence.rejected.every(item => item.reasons.includes('missing-input:missing')));
  assert.deepEqual(report.maintainedComponents, []); assert.equal(report.evidence.successful, 2);
});

test('cycles without executions remain structural and earn neither maintenance nor observed edges', () => {
  const observation = cycle(); observation.executions = []; observation.resources = [];
  const report = analyzeOrganization(observation);
  assert.equal(report.maximalRaf.length, 2); assert.deepEqual(report.observedDependencies, []);
  assert.deepEqual(report.observedComponents, []); assert.deepEqual(report.maintainedComponents, []);
  assert.equal(report.diversity.effectiveProcesses, 0); assert.equal(report.maintenance.catalystReplacementCoverage, null);
  assert.ok(report.processes.every(item => !item.maintained && item.blockers.includes('zero-flux')));
});

test('declaring a catalyst in a recipe cannot replace a missing catalyst receipt', () => {
  const observation = cycle(); observation.executions[0]!.catalysts = [];
  observation.resources.find(item => item.resourceId === 'b')!.closingStock = 2.5;
  const report = analyzeOrganization(observation);
  assert.equal(report.evidence.balanced, true, 'stock equality alone must not legitimize a fabricated execution');
  assert.deepEqual(report.evidence.rejected, [{ executionId: 'e1', reasons: ['missing-catalyst:b'] }]);
  assert.deepEqual(report.maintainedComponents, []);
});

test('an output cannot retroactively provide the catalyst needed for its own first execution', () => {
  const observation: OrganizationObservation = {
    window: { startTick: 0, endTick: 2, complete: true }, food: ['raw'], processes: [process('self', 'a', 'a')],
    executions: [execution('e1', 1, 'self', 'a', 'a'), execution('e2', 2, 'self', 'a', 'a')],
    resources: [
      { resourceId: 'raw', openingStock: 0, closingStock: 0, externalInput: 2, externalLoss: 0 },
      { resourceId: 'a', openingStock: 0, closingStock: 1, externalInput: 0, externalLoss: 0 },
    ],
  };
  const report = analyzeOrganization(observation);
  assert.deepEqual(report.maximalRaf, ['self']); assert.equal(report.evidence.balanced, true);
  assert.ok(report.evidence.rejected[0]!.reasons.includes('unavailable-catalyst:a'));
  assert.deepEqual(report.maintainedComponents, []);
});

test('using a seed tool without reproducing it explicitly reveals unproduced catalyst and depletion', () => {
  const observation = cycle(); observation.processes = [process('make-a', 'a', 'b')];
  observation.executions = observation.executions.filter(item => item.processId === 'make-a');
  observation.resources = [
    { resourceId: 'raw', openingStock: 0, closingStock: 0, externalInput: 2, externalLoss: 0 },
    { resourceId: 'a', openingStock: 0, closingStock: 2, externalInput: 0, externalLoss: 0 },
    { resourceId: 'b', openingStock: 2, closingStock: 1, externalInput: 0, externalLoss: 0 },
  ];
  const report = analyzeOrganization(observation);
  assert.equal(report.evidence.balanced, true); assert.deepEqual(report.maintenance.unproducedCatalysts, ['b']);
  assert.equal(report.maintenance.catalystReplacementCoverage, 0); assert.deepEqual(report.maintenance.depletedResources, ['b']);
  assert.ok(report.processes[0]!.blockers.includes('unproduced-resource:b'));
  assert.deepEqual(report.maintainedComponents, []);
});

test('a material cycle that does not replace catalyst wear is not maintained even if every process executed', () => {
  const observation = cycle();
  for (const execution of observation.executions) execution.catalysts[0]!.wear = 1.5;
  for (const resource of observation.resources.filter(item => item.resourceId !== 'raw')) { resource.openingStock = 4; resource.closingStock = 3; }
  const report = analyzeOrganization(observation);
  assert.equal(report.evidence.balanced, true); assert.equal(report.evidence.successful, 4);
  assert.equal(report.maintenance.catalystReplacementCoverage, 2 / 3);
  assert.deepEqual(report.maintenance.depletedResources, ['a', 'b']); assert.deepEqual(report.maintainedComponents, []);
});

test('a broken source chain prunes downstream maintenance and restoring real supply restores it', () => {
  const observation = cycle(), broken = structuredClone(observation);
  broken.resources[0]!.openingStock = 4; broken.resources[0]!.externalInput = 0;
  const report = analyzeOrganization(broken);
  assert.equal(report.evidence.balanced, true); assert.deepEqual(report.maintenance.depletedResources, ['raw']);
  assert.ok(report.processes.every(item => item.blockers.includes('depleting-food:raw')));
  assert.deepEqual(report.maintainedComponents, []);
  assert.deepEqual(analyzeOrganization(observation).maintainedComponents, [['make-a', 'make-b']]);
});

test('imported replacement components remain external dependencies despite a balanced, repeated cycle', () => {
  const observation = cycle(), resource = observation.resources.find(item => item.resourceId === 'a')!;
  resource.externalInput = 1; resource.closingStock!++;
  const report = analyzeOrganization(observation);
  assert.equal(report.evidence.balanced, true); assert.deepEqual(report.maintenance.externallySuppliedNonFood, ['a']);
  assert.deepEqual(report.maintainedComponents, []);
  assert.ok(report.processes.find(item => item.id === 'make-b')!.blockers.includes('external-dependency:a'));
});

test('missing inventories, truncated windows and unexplained stock changes cannot certify maintenance', () => {
  for (const kind of ['missing', 'truncated', 'inconsistent'] as const) {
    const observation = cycle();
    if (kind === 'missing') delete observation.resources[1]!.openingStock;
    if (kind === 'truncated') observation.window.complete = false;
    if (kind === 'inconsistent') observation.resources[1]!.closingStock!++;
    const report = analyzeOrganization(observation);
    assert.equal(report.evidence.balanced, false, kind); assert.deepEqual(report.maintainedComponents, [], kind);
    assert.ok(report.evidence.failures.includes('unverified-material-balance'));
  }
});

test('failed work is counted as a debit and cannot earn internal production credit', () => {
  const observation = cycle(); observation.executions[0]!.success = false;
  const report = analyzeOrganization(observation);
  assert.equal(report.evidence.executed, 4); assert.equal(report.evidence.successful, 3);
  assert.equal(report.resources.find(item => item.resourceId === 'raw')!.consumed, 4);
  assert.equal(report.resources.find(item => item.resourceId === 'a')!.output, 2);
  assert.equal(report.resources.find(item => item.resourceId === 'a')!.internalProduction, 1);
  assert.deepEqual(report.maintainedComponents, []);
});

test('a productive terminal chain and reuse of an output are not an autocatalytic maintenance cycle', () => {
  const observation = cycle();
  for (const process of observation.processes) process.catalysts = [];
  for (const execution of observation.executions) execution.catalysts = [];
  observation.resources.find(item => item.resourceId === 'a')!.closingStock = 3;
  observation.resources.find(item => item.resourceId === 'b')!.closingStock = 3;
  const report = analyzeOrganization(observation);
  assert.equal(report.evidence.balanced, true); assert.deepEqual(report.maximalRaf, []);
  assert.deepEqual(report.constructibleFromFood, ['make-a', 'make-b']);
  assert.ok(report.processes.every(item => item.maintained)); assert.deepEqual(report.maintainedComponents, []);
});

test('AND catalyst ensembles prune a missing member even if another catalyst is reachable', () => {
  const observation = cycle(); observation.processes[0]!.catalysts.push('absent');
  assert.deepEqual(analyzeOrganization(observation).maximalRaf, []);
});

test('lineage cycles and missing parents do not fabricate evolutionary depth', () => {
  const observation = cycle(); observation.processes[0]!.parents = ['make-b'];
  let report = analyzeOrganization(observation);
  assert.deepEqual(report.diversity.unresolvedLineage, ['make-a', 'make-b']); assert.equal(report.diversity.maxAncestorDepth, 0);
  observation.processes[0]!.parents = ['unknown']; report = analyzeOrganization(observation);
  assert.deepEqual(report.diversity.unresolvedLineage, ['make-a', 'make-b']);
  assert.ok(report.processes.every(item => item.ancestorDepth === null));
});

test('outside-window records do not earn flux; duplicates and invalid numeric receipts are rejected', () => {
  const observation = cycle(); observation.executions.push({ ...structuredClone(observation.executions[0]!), id: 'outside', tick: 9 });
  const report = analyzeOrganization(observation); assert.equal(report.evidence.ignoredOutsideWindow, 1); assert.equal(report.evidence.successful, 4);
  observation.executions.push(structuredClone(observation.executions[0]!)); assert.throws(() => analyzeOrganization(observation), /duplicate organization execution id/);
  observation.executions.pop(); observation.executions[0]!.inputs[0]!.amount = Number.NaN; assert.throws(() => analyzeOrganization(observation), /Invalid organization quantity/);
});

test('exact process receipts reject invented yield and undisclosed material inputs', () => {
  const observation = cycle(); observation.executions[0]!.outputs[0]!.amount = 2;
  observation.resources.find(item => item.resourceId === 'a')!.closingStock!++;
  let report = analyzeOrganization(observation);
  assert.equal(report.evidence.balanced, true); assert.ok(report.evidence.rejected[0]!.reasons.includes('excess-output:a'));
  assert.deepEqual(report.maintainedComponents, []);
  observation.executions[0]!.inputs.push(q('secret', 1)); report = analyzeOrganization(observation);
  assert.ok(report.evidence.rejected[0]!.reasons.includes('undeclared-input:secret'));
});

test('a seed-only recycling loop is not reproducible from food even when observed balances remain stable', () => {
  const observation = cycle(); observation.food = [];
  for (const process of observation.processes) process.inputs = [q(process.id === 'make-a' ? 'b' : 'a', 0.5)];
  for (const execution of observation.executions) execution.inputs = [q(execution.processId === 'make-a' ? 'b' : 'a', 0.5)];
  observation.resources = [
    { resourceId: 'a', openingStock: 2, closingStock: 2, externalInput: 0, externalLoss: 0 },
    { resourceId: 'b', openingStock: 2, closingStock: 2, externalInput: 0, externalLoss: 0 },
  ];
  const report = analyzeOrganization(observation);
  assert.equal(report.evidence.successful, 4); assert.equal(report.evidence.balanced, true);
  assert.deepEqual(report.observedComponents, [['make-a', 'make-b']]); assert.deepEqual(report.maximalRaf, []);
  assert.deepEqual(report.maintainedComponents, []); assert.ok(report.processes.every(item => item.blockers.includes('not-food-generated')));
});

test('an unused patent cannot inflate the ancestry depth of actual production or assign a profession', () => {
  const observation = cycle(); observation.processes.push(process('unbuilt', 'c', 'a', ['make-b']));
  const report = analyzeOrganization(observation);
  assert.equal(report.processes.find(item => item.id === 'unbuilt')!.ancestorDepth, 2);
  assert.equal(report.diversity.maxAncestorDepth, 1); assert.equal(report.diversity.activeProcesses, 2);
  assert.ok(report.actorRoles.every(item => item.dominantProcessId !== 'unbuilt'));
});

test('a source process must declare an input; naming a product does not authorize production from nothing', () => {
  const observation = cycle(); observation.processes[0]!.inputs = [];
  assert.throws(() => analyzeOrganization(observation), /has no input/);
});

test('stoichiometric units support scaled receipts without weakening exact material accounting', () => {
  const observation = cycle();
  for (const execution of observation.executions) {
    execution.units = 2; execution.inputs[0]!.amount = 2; execution.outputs[0]!.amount = 2;
  }
  observation.resources[0]!.externalInput = 8;
  observation.resources[1]!.closingStock = observation.resources[2]!.closingStock = 4;
  const report = analyzeOrganization(observation);
  assert.equal(report.evidence.balanced, true); assert.equal(report.evidence.successful, 4);
  assert.deepEqual(report.maintainedComponents, [['make-a', 'make-b']]);
});
