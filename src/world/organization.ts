import type {
  OrganizationAnalysis, OrganizationDependency, OrganizationExecution, OrganizationObservation,
  OrganizationProcess, OrganizationQuantity, OrganizationResourceBalance,
} from '../shared/organization.js';

const EPSILON = 1e-8;
const sorted = (items: Iterable<string>): string[] => [...new Set(items)].sort();
const sum = (items: OrganizationQuantity[], resourceId: string): number => items.reduce((total, item) => total + (item.resourceId === resourceId ? item.amount : 0), 0);
const ids = (items: OrganizationQuantity[]): string[] => sorted(items.filter(item => item.amount > 0).map(item => item.resourceId));
const near = (a: number, b: number): boolean => Math.abs(a - b) <= EPSILON * Math.max(1, Math.abs(a), Math.abs(b));

function checkNumber(value: number | undefined, label: string, optional = false): void {
  if (optional && value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new RangeError(`Invalid organization ${label}`);
}

function validate(observation: OrganizationObservation): void {
  checkNumber(observation.window.startTick, 'start tick'); checkNumber(observation.window.endTick, 'end tick');
  if (observation.window.endTick < observation.window.startTick) throw new RangeError('Invalid organization observation window');
  const unique = (values: string[], label: string) => {
    if (values.some(value => !value) || new Set(values).size !== values.length) throw new RangeError(`Invalid or duplicate organization ${label}`);
  };
  const quantities = (items: OrganizationQuantity[]) => {
    unique(items.map(item => item.resourceId), 'quantity resource');
    for (const item of items) checkNumber(item.amount, 'quantity');
  };
  unique(observation.processes.map(process => process.id), 'process id');
  unique(observation.executions.map(execution => execution.id), 'execution id');
  unique(observation.resources.map(resource => resource.resourceId), 'resource id');
  for (const process of observation.processes) {
    quantities(process.inputs); quantities(process.outputs); unique(process.catalysts, 'catalyst');
    if (!ids(process.inputs).length) throw new RangeError(`Organization process ${process.id} has no input`);
    if (!ids(process.outputs).length) throw new RangeError(`Organization process ${process.id} has no output`);
  }
  for (const execution of observation.executions) {
    checkNumber(execution.tick, 'execution tick'); checkNumber(execution.units, 'execution units', true);
    quantities(execution.inputs); quantities(execution.outputs);
    unique(execution.catalysts.map(catalyst => catalyst.resourceId), 'execution catalyst');
    for (const catalyst of execution.catalysts) checkNumber(catalyst.wear, 'catalyst wear');
  }
  for (const resource of observation.resources) {
    checkNumber(resource.openingStock, 'opening stock', true); checkNumber(resource.closingStock, 'closing stock', true);
    checkNumber(resource.externalInput, 'external input'); checkNumber(resource.externalLoss, 'external loss');
  }
}

/** Food closure is a hypergraph operation: every input must be reachable. */
function closure(processes: OrganizationProcess[], food: Iterable<string>, requireCatalysts = false): { resources: Set<string>; processes: Set<string> } {
  const resources = new Set(food), reached = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (reached.has(process.id) || !ids(process.inputs).every(id => resources.has(id))) continue;
      if (requireCatalysts && !process.catalysts.every(id => resources.has(id))) continue;
      reached.add(process.id); changed = true;
      for (const id of ids(process.outputs)) resources.add(id);
    }
  }
  return { resources, processes: reached };
}

/**
 * Maximal RAF pruning, with AND catalyst ensembles. Food closure ignores catalysis,
 * then pruning requires the ensemble in that closure; iterate to a fixed point.
 * Structural only: Steel, Hordijk & Xavier (2019), doi:10.1098/rsif.2018.0808.
 */
function maximalRaf(processes: OrganizationProcess[], food: string[]): Set<string> {
  let candidates = processes;
  while (candidates.length) {
    const available = closure(candidates, food).resources;
    const next = candidates.filter(process => process.catalysts.length > 0 &&
      ids(process.inputs).every(id => available.has(id)) && process.catalysts.every(id => available.has(id)));
    if (next.length === candidates.length) return new Set(next.map(process => process.id));
    candidates = next;
  }
  return new Set();
}

function dependencies(processes: OrganizationProcess[]): OrganizationDependency[] {
  const result: OrganizationDependency[] = [];
  for (const producer of processes) for (const consumer of processes) {
    for (const resourceId of ids(producer.outputs)) {
      if (sum(consumer.inputs, resourceId) > 0) result.push({ producerId: producer.id, consumerId: consumer.id, resourceId, kind: 'input' });
      if (consumer.catalysts.includes(resourceId)) result.push({ producerId: producer.id, consumerId: consumer.id, resourceId, kind: 'catalyst' });
    }
  }
  return result.sort((a, b) => a.producerId.localeCompare(b.producerId) || a.consumerId.localeCompare(b.consumerId) || a.resourceId.localeCompare(b.resourceId) || a.kind.localeCompare(b.kind));
}

/** SCCs are reported as graph descriptors, never substituted for food closure or RAF. */
function components(processIds: string[], edges: OrganizationDependency[]): string[][] {
  const adjacency = new Map(processIds.map(id => [id, new Set<string>()]));
  for (const edge of edges) if (adjacency.has(edge.consumerId)) adjacency.get(edge.producerId)?.add(edge.consumerId);
  const visited = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], onStack = new Set<string>();
  const result: string[][] = []; let counter = 0;
  const visit = (id: string): void => {
    visited.set(id, counter); low.set(id, counter++); stack.push(id); onStack.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!visited.has(next)) { visit(next); low.set(id, Math.min(low.get(id)!, low.get(next)!)); }
      else if (onStack.has(next)) low.set(id, Math.min(low.get(id)!, visited.get(next)!));
    }
    if (low.get(id) !== visited.get(id)) return;
    const group: string[] = []; let member: string;
    do { member = stack.pop()!; onStack.delete(member); group.push(member); } while (member !== id);
    result.push(group.sort());
  };
  for (const id of [...processIds].sort()) if (!visited.has(id)) visit(id);
  return result.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

function ancestorDepths(processes: OrganizationProcess[]): Map<string, number | null> {
  const records = new Map(processes.map(process => [process.id, process])), memo = new Map<string, number | null>(), visiting = new Set<string>();
  const depth = (id: string): number | null => {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id) || !records.has(id)) return null;
    visiting.add(id); const parents = records.get(id)!.parents.map(depth); visiting.delete(id);
    const result = parents.some(value => value === null) ? null : parents.length ? 1 + Math.max(...parents as number[]) : 0;
    memo.set(id, result); return result;
  };
  for (const process of processes) depth(process.id);
  return memo;
}

/**
 * Analyze supplied receipts without changing world state or inferring missing evidence.
 * Finite-window material maintenance is not biological autopoiesis: this model has no
 * self-produced containing boundary (Hordijk & Steel 2015, doi:10.1186/s13322-014-0006-2).
 */
export function analyzeOrganization(observation: OrganizationObservation): OrganizationAnalysis {
  validate(observation);
  const processMap = new Map(observation.processes.map(process => [process.id, process])), food = new Set(observation.food);
  const available = closure(observation.processes, food), raf = maximalRaf(observation.processes, observation.food);
  const constructible = closure(observation.processes, food, true), depths = ancestorDepths(observation.processes);
  const resourceIds = sorted([
    ...food, ...observation.resources.map(resource => resource.resourceId),
    ...observation.processes.flatMap(process => [...process.inputs.map(item => item.resourceId), ...process.outputs.map(item => item.resourceId), ...process.catalysts]),
    ...observation.executions.flatMap(execution => [...execution.inputs.map(item => item.resourceId), ...execution.outputs.map(item => item.resourceId), ...execution.catalysts.map(catalyst => catalyst.resourceId)]),
  ]);
  const records = new Map(observation.resources.map(resource => [resource.resourceId, resource]));
  const balances = new Map<string, OrganizationResourceBalance>(resourceIds.map(resourceId => [resourceId, {
    resourceId, ...records.get(resourceId), externalInput: records.get(resourceId)?.externalInput ?? 0,
    externalLoss: records.get(resourceId)?.externalLoss ?? 0, food: food.has(resourceId), output: 0, internalProduction: 0,
    consumed: 0, catalystWear: 0, demand: 0, replacementCoverage: null, turnover: null, netFlow: 0, residual: null,
    balance: 'unverified', depleting: false,
  }]));
  // Arrivals have aggregate, not event-time, resolution. Even this generous availability
  // bound must cover every debit; it cannot prove arrival timing or spatial delivery.
  const running = new Map(resourceIds.map(id => [id, records.get(id)?.openingStock === undefined ? undefined : records.get(id)!.openingStock! + records.get(id)!.externalInput]));
  const selected = observation.executions.filter(execution => execution.tick >= observation.window.startTick && execution.tick <= observation.window.endTick)
    .map((execution, order) => ({ execution, order })).sort((a, b) => a.execution.tick - b.execution.tick || a.order - b.order).map(item => item.execution);
  const rejected: OrganizationAnalysis['evidence']['rejected'] = [], successful: OrganizationExecution[] = [];
  for (const execution of selected) {
    const process = processMap.get(execution.processId), reasons: string[] = [];
    const units = execution.units ?? 1;
    if (!process) reasons.push('unknown-process');
    if (units <= 0) reasons.push('zero-units');
    if (execution.success && process) {
      for (const input of process.inputs) if (!near(sum(execution.inputs, input.resourceId), input.amount * units)) reasons.push(`${sum(execution.inputs, input.resourceId) < input.amount * units ? 'missing' : 'excess'}-input:${input.resourceId}`);
      for (const input of execution.inputs) if (input.amount > 0 && !ids(process.inputs).includes(input.resourceId)) reasons.push(`undeclared-input:${input.resourceId}`);
      for (const output of process.outputs) if (!near(sum(execution.outputs, output.resourceId), output.amount * units)) reasons.push(`${sum(execution.outputs, output.resourceId) < output.amount * units ? 'missing' : 'excess'}-output:${output.resourceId}`);
      for (const output of execution.outputs) if (output.amount > 0 && !ids(process.outputs).includes(output.resourceId)) reasons.push(`undeclared-output:${output.resourceId}`);
      for (const catalyst of process.catalysts) if (!execution.catalysts.some(item => item.resourceId === catalyst)) reasons.push(`missing-catalyst:${catalyst}`);
      if (!ids(execution.outputs).length) reasons.push('zero-output');
    }
    for (const resourceId of sorted([...ids(execution.inputs), ...execution.catalysts.map(catalyst => catalyst.resourceId)])) {
      const stock = running.get(resourceId), input = sum(execution.inputs, resourceId);
      const catalyst = execution.catalysts.find(item => item.resourceId === resourceId), wear = catalyst?.wear ?? 0;
      if (stock !== undefined && stock + EPSILON < input + wear) reasons.push(`unavailable-input:${resourceId}`);
      if (catalyst && stock !== undefined && stock - input <= EPSILON) reasons.push(`unavailable-catalyst:${resourceId}`);
    }
    if (reasons.length) rejected.push({ executionId: execution.id, reasons: sorted(reasons) });
    const accepted = execution.success && reasons.length === 0;
    if (accepted) successful.push(execution);
    for (const input of execution.inputs) {
      balances.get(input.resourceId)!.consumed += input.amount;
      if (running.get(input.resourceId) !== undefined) running.set(input.resourceId, running.get(input.resourceId)! - input.amount);
    }
    for (const catalyst of execution.catalysts) {
      balances.get(catalyst.resourceId)!.catalystWear += catalyst.wear;
      if (running.get(catalyst.resourceId) !== undefined) running.set(catalyst.resourceId, running.get(catalyst.resourceId)! - catalyst.wear);
    }
    for (const output of execution.outputs) {
      const balance = balances.get(output.resourceId)!; balance.output += output.amount;
      if (accepted) balance.internalProduction += output.amount;
      if (running.get(output.resourceId) !== undefined) running.set(output.resourceId, running.get(output.resourceId)! + output.amount);
    }
  }
  for (const balance of balances.values()) {
    balance.demand = balance.consumed + balance.catalystWear + balance.externalLoss;
    balance.netFlow = balance.externalInput + balance.output - balance.demand;
    balance.replacementCoverage = balance.demand > EPSILON ? Math.min(1, balance.internalProduction / balance.demand) : null;
    balance.turnover = balance.openingStock !== undefined && balance.openingStock > EPSILON ? balance.demand / balance.openingStock : null;
    balance.depleting = balance.netFlow < -EPSILON;
    if (balance.openingStock !== undefined && balance.closingStock !== undefined) {
      balance.residual = balance.closingStock - (balance.openingStock + balance.netFlow);
      balance.balance = near(balance.closingStock, balance.openingStock + balance.netFlow) ? (observation.window.complete ? 'verified' : 'unverified') : 'inconsistent';
    }
  }
  const relevantBalances = [...balances.values()].filter(balance => balance.output > 0 || balance.demand > 0 || balance.externalInput > 0);
  const balanced = observation.window.complete && relevantBalances.length > 0 && relevantBalances.every(balance => balance.balance === 'verified');
  const executionsByProcess = new Map(observation.processes.map(process => [process.id, successful.filter(execution => execution.processId === process.id)]));
  const active = observation.processes.filter(process => executionsByProcess.get(process.id)!.length > 0);
  const actualProcesses = active.map(process => ({ ...process,
    inputs: sorted(executionsByProcess.get(process.id)!.flatMap(execution => ids(execution.inputs))).map(resourceId => ({ resourceId, amount: 1 })),
    outputs: sorted(executionsByProcess.get(process.id)!.flatMap(execution => ids(execution.outputs))).map(resourceId => ({ resourceId, amount: 1 })),
    catalysts: sorted(executionsByProcess.get(process.id)!.flatMap(execution => execution.catalysts.map(catalyst => catalyst.resourceId))),
  }));
  const actualProcessMap = new Map(actualProcesses.map(process => [process.id, process]));
  const structuralDependencies = dependencies(observation.processes), observedDependencies = dependencies(actualProcesses);
  const required = sorted(actualProcesses.flatMap(process => [...ids(process.inputs), ...process.catalysts]));
  const catalystIds = sorted(actualProcesses.flatMap(process => process.catalysts));
  const nonFoodCatalysts = catalystIds.filter(id => !food.has(id));
  const failures: string[] = [];
  if (!observation.window.complete) failures.push('incomplete-window');
  if (!successful.length) failures.push('no-successful-flux');
  if (!balanced) failures.push('unverified-material-balance');
  if (rejected.length) failures.push('invalid-execution-receipts');
  // Prune unsupported active processes repeatedly. A dormant producer cannot replace
  // a catalyst, and a producer removed for missing inputs cannot support downstream work.
  let maintained = new Set(active.map(process => process.id));
  const maintenanceContext = (candidates: Set<string>) => {
    const generated = closure(actualProcesses.filter(process => candidates.has(process.id)), food).processes;
    const supplies = new Map<string, number>();
    for (const execution of successful) if (candidates.has(execution.processId)) {
      for (const output of execution.outputs) supplies.set(output.resourceId, (supplies.get(output.resourceId) ?? 0) + output.amount);
    }
    return { generated, supplies };
  };
  const blockersFor = (process: OrganizationProcess, context: ReturnType<typeof maintenanceContext>): string[] => {
    const blockers = [...failures], executions = executionsByProcess.get(process.id)!;
    if (!executions.length) blockers.push('zero-flux');
    if (new Set(executions.map(execution => execution.tick)).size < 2) blockers.push('no-repeated-flux');
    const actual = actualProcessMap.get(process.id) ?? process;
    if (!context.generated.has(process.id)) blockers.push('not-food-generated');
    for (const resourceId of sorted([...ids(actual.inputs), ...actual.catalysts])) {
      const resource = balances.get(resourceId)!;
      const supply = context.supplies.get(resourceId) ?? 0;
      if (resource.balance !== 'verified') blockers.push(`unverified-stock:${resourceId}`);
      if (food.has(resourceId)) {
        if (resource.externalInput + supply + EPSILON < resource.demand) blockers.push(`depleting-food:${resourceId}`);
      } else {
        if (resource.externalInput > EPSILON) blockers.push(`external-dependency:${resourceId}`);
        if (supply <= EPSILON) blockers.push(`unproduced-resource:${resourceId}`);
        if (supply + EPSILON < resource.demand) blockers.push(`unreplaced-resource:${resourceId}`);
      }
    }
    return sorted(blockers);
  };
  while (maintained.size) {
    const context = maintenanceContext(maintained);
    const next = new Set(active.filter(process => maintained.has(process.id) && blockersFor(process, context).length === 0).map(process => process.id));
    if (next.size === maintained.size) break;
    maintained = next;
  }
  const finalMaintenance = maintenanceContext(maintained);
  const observedComponents = components(active.map(process => process.id), observedDependencies);
  const maintainedComponents = components([...maintained], observedDependencies).filter(component => {
    const cyclic = component.length > 1 || observedDependencies.some(edge => edge.producerId === component[0] && edge.consumerId === component[0]);
    // Require an internally reproduced catalyst with actual loss, not arbitrary output
    // reuse, a food catalyst, or an immortal seed tool. Optional observed tools count as
    // maintenance evidence but do not become structural RAF requirements.
    return cyclic && observedDependencies.some(edge => edge.kind === 'catalyst' && component.includes(edge.producerId) && component.includes(edge.consumerId) &&
      !food.has(edge.resourceId) && balances.get(edge.resourceId)!.catalystWear > EPSILON);
  });
  const catalystDemand = nonFoodCatalysts.reduce((total, id) => total + balances.get(id)!.demand, 0);
  const catalystReplacement = nonFoodCatalysts.reduce((total, id) => total + Math.min(balances.get(id)!.demand, balances.get(id)!.internalProduction), 0);
  const activity = new Map<string, { actorId: string; processId: string; executions: number }>();
  for (const execution of successful) {
    const key = JSON.stringify([execution.actorId, execution.processId]);
    const record = activity.get(key) ?? { actorId: execution.actorId, processId: execution.processId, executions: 0 };
    record.executions++; activity.set(key, record);
  }
  const entropy = active.reduce((total, process) => { const share = executionsByProcess.get(process.id)!.length / successful.length; return total - share * Math.log(share); }, 0);
  const actorRoles = sorted(successful.map(execution => execution.actorId)).map(actorId => {
    const practiced = [...activity.values()].filter(item => item.actorId === actorId).sort((a, b) => b.executions - a.executions || a.processId.localeCompare(b.processId));
    const executions = practiced.reduce((total, item) => total + item.executions, 0);
    const entropy = practiced.reduce((total, item) => { const share = item.executions / executions; return total - share * Math.log(share); }, 0);
    return { actorId, executions, dominantProcessId: practiced[0]!.processId, dominantShare: practiced[0]!.executions / executions, effectiveProcesses: Math.exp(entropy) };
  });
  return {
    window: { ...observation.window }, boundary: 'not-modeled', autopoiesisEstablished: false,
    foodClosure: sorted(available.resources), maximalRaf: sorted(raf), constructibleFromFood: sorted(constructible.processes),
    processes: [...observation.processes].sort((a, b) => a.id.localeCompare(b.id)).map(process => ({
      id: process.id, executions: executionsByProcess.get(process.id)!.length,
      fluxPerTick: executionsByProcess.get(process.id)!.length / Math.max(1, observation.window.endTick - observation.window.startTick + 1),
      foodGenerated: available.processes.has(process.id), structuralRaf: raf.has(process.id), constructibleFromFood: constructible.processes.has(process.id),
      viableNow: process.inputs.every(input => (balances.get(input.resourceId)?.closingStock ?? 0) + EPSILON >= input.amount) &&
        process.catalysts.every(id => (balances.get(id)?.closingStock ?? 0) - sum(process.inputs, id) > EPSILON),
      maintained: maintained.has(process.id), blockers: blockersFor(process, finalMaintenance), ancestorDepth: depths.get(process.id) ?? null,
    })),
    resources: [...balances.values()], structuralDependencies, observedDependencies,
    structuralComponents: components(observation.processes.map(process => process.id), structuralDependencies), observedComponents, maintainedComponents,
    evidence: { executed: selected.length, successful: successful.length, rejected, ignoredOutsideWindow: observation.executions.length - selected.length, balanced, failures },
    maintenance: {
      requiredResources: required, depletedResources: required.filter(id => balances.get(id)!.depleting),
      externallySuppliedNonFood: resourceIds.filter(id => !food.has(id) && balances.get(id)!.externalInput > EPSILON),
      unproducedCatalysts: nonFoodCatalysts.filter(id => balances.get(id)!.internalProduction <= EPSILON),
      catalystReplacementCoverage: catalystDemand > EPSILON ? catalystReplacement / catalystDemand : null,
      catalystsWithCompleteTurnover: nonFoodCatalysts.filter(id => (balances.get(id)!.turnover ?? 0) >= 1 && balances.get(id)!.replacementCoverage === 1),
    },
    diversity: { activeProcesses: active.length, effectiveProcesses: active.length ? Math.exp(entropy) : 0,
      activeActors: new Set(successful.map(execution => execution.actorId)).size,
      maxAncestorDepth: Math.max(0, ...active.map(process => depths.get(process.id) ?? null).filter((value): value is number => value !== null)),
      unresolvedLineage: sorted([...depths].filter(([, value]) => value === null).map(([id]) => id)),
    },
    actorActivity: [...activity.values()].sort((a, b) => a.actorId.localeCompare(b.actorId) || a.processId.localeCompare(b.processId)),
    actorRoles,
  };
}
