import { parentPort } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { closeEcosystemWorkers } from '../../src/world/ecosystem.js';
import { CPU_BACKENDS, captureReference, compareCandidate } from './matriz.js';
import type { HardwareSceneName } from './escenas.js';

export interface MatrixSceneRequest {
  id: number;
  seed: number;
  scene: HardwareSceneName;
  steps: number;
}

export interface MatrixSceneResponse {
  id: number;
  ok: boolean;
  subtests?: { name: string; elapsedMs: number }[];
  diagnostic?: string;
  failedSubtest?: string;
  errorMessage?: string;
  errorStack?: string;
}

const port = parentPort;
if (port) {
  port.on('message', async (req: MatrixSceneRequest | { close: true }) => {
    if ('close' in req) {
      await closeEcosystemWorkers().catch(() => {});
      port.close();
      return;
    }
    const started = performance.now();
    let currentSubtest = 'captureReference';
    try {
      const reference = captureReference(req.seed, req.scene, req.steps);
      let actualDispatches = 0, actualEcologyDispatches = 0, actualDelays = 0;
      let topologyScannedTiles = reference.topologyScannedTiles;
      let fullRefreshes = reference.fullRefreshes;
      let globalCaptures = reference.globalCaptures;
      let logicalTileChanges = reference.logicalTileChanges;
      let updatedPages = reference.updatedPages;
      const subtests: { name: string; elapsedMs: number }[] = [];
      for (const regionSide of [256, 512] as const) {
        for (const backend of CPU_BACKENDS) {
          currentSubtest = `CPU=${backend} geometry=${regionSide}`;
          const evidence = compareCandidate(reference, regionSide, backend);
          actualDispatches += evidence.actualKernelDispatches;
          actualDelays += evidence.delayCount;
          actualEcologyDispatches += evidence.actualEcologyDispatches;
          topologyScannedTiles += evidence.topologyScannedTiles;
          fullRefreshes += evidence.fullRefreshes;
          globalCaptures += evidence.globalCaptures;
          logicalTileChanges += evidence.logicalTileChanges;
          updatedPages += evidence.updatedPages;
          subtests.push({ name: currentSubtest, elapsedMs: evidence.elapsedMs });
        }
      }
      const response: MatrixSceneResponse = {
        id: req.id,
        ok: true,
        subtests,
        diagnostic: `steps=${req.steps}; elapsedMs=${(performance.now() - started).toFixed(3)};`
          + ` physicalEcologyDispatches=${actualEcologyDispatches}; physicalKernelDispatches=${actualDispatches}; realDelayCount=${actualDelays};`
          + ` topologyScannedTiles=${topologyScannedTiles}; fullRefreshes=${fullRefreshes};`
          + ` logicalTileChanges=${logicalTileChanges}; updatedPages=${updatedPages}; globalCaptures=${globalCaptures}`,
      };
      port.postMessage(response);
    } catch (error) {
      const response: MatrixSceneResponse = {
        id: req.id,
        ok: false,
        failedSubtest: currentSubtest,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
      };
      port.postMessage(response);
    }
  });
}
