import { IncrementalRegionHasher, type RegionHashCapture, type RegionHashPage,
  type RegionHashTopologyCertificate } from '../../src/world/digesto.js';
import type { World } from '../../src/world/index.js';
import { residentTopologyOwner, residentTopologyToken, sameResidentTopology,
  type ResidentTopologyToken } from '../../src/world/soa/topologia.js';

export interface HardwareTrackedCapture {
  digest: RegionHashCapture;
  fullRefresh: boolean;
  changedTiles: number;
  dirtyPages: readonly RegionHashPage[] | undefined;
}

/** One observer per trajectory. Certificates come from the actual owner registry, never
 * from an assumed stable length or from the previous ecology event's Tile array.
 * Initial construction/rebuild is O(T); a certified stable capture visits only changed Tiles
 * and dirty pages. globalHash still traverses all non-active-Tile world state explicitly. */
export class HardwareTileChanges {
  private lastTiles: World['tiles'] | undefined;
  private lastToken: ResidentTopologyToken | undefined;
  private certificate: RegionHashTopologyCertificate | undefined;
  private initialized = false;
  private readonly hasher: IncrementalRegionHasher;

  constructor(private readonly world: World, regionSide: 256 | 512 = 256) {
    this.hasher = new IncrementalRegionHasher(regionSide, { normalizeExecution: true,
      topologyOf: () => this.certificate });
  }

  get topologyCertificate(): RegionHashTopologyCertificate | undefined { return this.certificate; }

  capture(externalPages?: readonly RegionHashPage[], forceFull = false): HardwareTrackedCapture {
    const tiles = this.world.tiles, owner = residentTopologyOwner(tiles);
    // Read the CURRENT array's token at EVERY boundary. maintainRegions may replace it.
    const token = owner ? residentTopologyToken(tiles) : undefined;
    const changed = owner?.drainChangedTiles() ?? [];
    const owned = owner !== undefined && token !== undefined;
    if (!owned) {
      this.lastTiles = undefined; this.lastToken = undefined; this.certificate = undefined;
    } else if (tiles !== this.lastTiles || !sameResidentTopology(token, this.lastToken)) {
      this.lastTiles = tiles; this.lastToken = token;
      // This revision's identity is cached only while both real token identities stay stable.
      this.certificate = { tiles, revision: token };
    }
    const fullRefresh = forceFull || !this.initialized || !owned;
    let dirtyPages: RegionHashPage[] | undefined;
    if (!fullRefresh) {
      const pages = new Map<string, RegionHashPage>();
      for (const page of externalPages ?? []) pages.set(`${page.pageX},${page.pageY}`, page);
      for (const tile of changed) {
        const pageX = Math.floor(tile.x / 16), pageY = Math.floor(tile.y / 16);
        pages.set(`${pageX},${pageY}`, { pageX, pageY });
      }
      // [] is valid only when neither the pool nor an observed logical write touched a Tile.
      dirtyPages = [...pages.values()];
    }
    const digest = this.hasher.update(this.world, dirtyPages);
    this.initialized = true;
    return { digest, fullRefresh, changedTiles: changed.length, dirtyPages };
  }
}
