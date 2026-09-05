import type { TechnologyRecipe } from './technology.js';

/** Immutable grammar/signature version, independent from the world's rules version. */
export const TECHNOLOGY_ARCHIVE_LAWS_VERSION = 1 as const;
export type TechnologyDefinition = Omit<TechnologyRecipe, 'uses' | 'utility' | 'manufactured'> & {
  lawsVersion: typeof TECHNOLOGY_ARCHIVE_LAWS_VERSION;
};
export interface TechnologyStats { uses: number; utility: number; manufactured: number; }
export interface TechnologyStatsRecord extends TechnologyStats { recipeId: string; tick: number; }
/** Serials through this boundary were never claimed as preserved observations. */
export interface TechnologyHistoryOrigin { version: 1; startsAfter: number; }
export interface TechnologyExecutionQuery {
  afterSerial?: number;
  asOfTick?: number;
  /** Pagination bounds each read, not the lifetime number of archived receipts. */
  limit?: number;
}
