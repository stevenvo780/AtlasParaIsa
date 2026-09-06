/** Coverage describes simulated regions only. Procedural scenery outside this
 * coverage has no claimed ecological history. One step is one physical tick. */
export interface EcologyView {
  version: 1;
  model: 'synchronized-regions-closed-different-time-borders';
  activeRegions: number;
  coldRegions: number;
  oldestTick: number | null;
  debtChunkTicks: number;
  preparing: string[];
  chunkTicksPerPulse: number;
  workedChunkTicks: number;
  migrations: number;
  regions: { key: string; asOfTick: number | null; status: 'active' | 'cold' | 'unobserved' }[];
}
