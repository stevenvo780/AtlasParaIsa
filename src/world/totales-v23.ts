/**
 * Contadores V23 de `world.totals` (kg acumulados en la vida del mundo que lee el laboratorio). Los escriben
 * `actuar/recursos.ts` y `actuar/ley-actuar.ts`; `mundo/validar.ts` los admite junto a los heredados. Módulo hoja: el
 * validador no puede importar las leyes sin cerrar ciclos.
 */
export const TOTALES_V23 = [
  'v23DietaKg', 'v23DietaFaunaKg', 'v23CazaKg', 'v23BebidaKg', 'v23ForrajeoKg', 'v23RecogidaKg', 'v23CargaKgTick', 'v23MasaKgTick',
] as const;
export type TotalV23 = (typeof TOTALES_V23)[number];
