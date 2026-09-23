/**
 * Paleta pixel-art — Una carta para Isa
 *
 * Colores curados a mano a partir de la referencia de estilo
 * `/datos/tmp-atlas-lab/arte/estilos/estilo-A.png` (ver `docs/ARTE.md`):
 * se cuantizó la imagen, se extrajeron colores diversos por muestreo de
 * máxima distancia (para no perder tonos minoritarios frente al césped y
 * el trigal, que dominan en superficie) y se filtraron casi-duplicados
 * (distancia euclidiana RGB ≥ 20 entre cualquier par).
 *
 * Regla del renderizador (T: ver `docs/ARTE.md`): sólo se pinta con estos
 * colores, o con una mezcla discreta de dos de ellos vía tramado ordenado
 * de Bayer. Nunca un degradado RGB continuo (`mix`/`lerp` canal a canal a
 * resolución de píxel) ni una interpolación bilineal por píxel entre
 * vecinos: eso es exactamente lo que producía el "borrón" sucio del
 * terreno (ver diagnóstico en `docs/ARTE.md` y el commit que lo corrige).
 *
 * Sombra y luz son universales: el sombreado de cualquier familia se logra
 * tramando su tono base contra `SOMBRA`/`LUZ`, no fabricando una variante
 * clara/oscura por familia.
 */

export const AGUA = {
  /** Agua honda, lejos de la orilla. */
  profunda: '#1e4266',
  /** Agua somera, cerca de la orilla o sobre fondo visible. */
  somera: '#4e8aae',
  /** Espuma / cresta / brillo del agua en movimiento. */
  espuma: '#96d2de',
} as const;

export const PRADERA = {
  /** Césped / pradera de pasto vivo. */
  base: '#667e1e',
  /** Pasto seco o muy iluminado. */
  seca: '#8a9612',
} as const;

export const BOSQUE = {
  /** Verde de bosque / conífera. */
  base: '#426636',
  /** Sombra bajo el dosel. */
  sombra: '#122a12',
} as const;

export const HUMEDAL = {
  /** Vegetación de humedal / juncal. */
  base: '#42665a',
  /** Humedal en sombra o encharcado. */
  sombra: '#364242',
} as const;

export const DESIERTO = {
  /** Arena / tierra desértica. */
  base: '#d2ae8a',
  /** Arena en sombra o duna. */
  sombra: '#ae9666',
} as const;

export const MONTANA = {
  /** Roca / piedra de montaña. */
  base: '#8a7272',
  /** Roca en sombra. */
  sombra: '#5a4e4e',
} as const;

/** Suelo trabajado por manos humanas: pisado, arado y en cultivo. */
export const SUELO = {
  /** Tierra pisada / sendero. */
  pisado: '#7e5a4e',
  /** Surco recién arado. */
  arado: '#8a4e2a',
  /** Hilera de cultivo (más oscura, tierra removida y húmeda). */
  cultivo: '#5a4e12',
} as const;

export const MADERA = {
  /** Madera de construcción / tronco cortado. */
  base: '#664236',
  /** Madera oscura / veta o carbonizada. */
  oscura: '#421e06',
} as const;

/** Paja de techo / trigo cosechado. */
export const PAJA = {
  base: '#f6a236',
  /** Paja iluminada / trigo maduro al sol. */
  clara: '#ffd24e',
} as const;

/** Piel: varios tonos para variar a la población sin degradado continuo. */
export const PIEL = {
  clara: '#f6ae66',
  media: '#c67236',
  oscura: '#d29672',
} as const;

/** Ropa: acentos de color sobre figuras, no terreno. */
export const ROPA = {
  roja: '#c64236',
  rojaOscura: '#962a2a',
  azul: '#424e72',
} as const;

/** Sombra universal: tramar cualquier color base contra ésta para oscurecerlo. */
export const SOMBRA = '#120606';

/** Luz universal: tramar cualquier color base contra ésta para iluminarlo. */
export const LUZ = '#fffff6';

export const PALETA = {
  AGUA, PRADERA, BOSQUE, HUMEDAL, DESIERTO, MONTANA, SUELO, MADERA, PAJA, PIEL, ROPA, SOMBRA, LUZ,
} as const;

/** Lista plana `[nombre, hex]`, útil para volcar o validar la paleta completa. */
export const PALETA_PLANA: ReadonlyArray<readonly [string, string]> = [
  ['aguaProfunda', AGUA.profunda], ['aguaSomera', AGUA.somera], ['aguaEspuma', AGUA.espuma],
  ['praderaBase', PRADERA.base], ['praderaSeca', PRADERA.seca],
  ['bosqueBase', BOSQUE.base], ['bosqueSombra', BOSQUE.sombra],
  ['humedalBase', HUMEDAL.base], ['humedalSombra', HUMEDAL.sombra],
  ['desiertoBase', DESIERTO.base], ['desiertoSombra', DESIERTO.sombra],
  ['montanaBase', MONTANA.base], ['montanaSombra', MONTANA.sombra],
  ['sueloPisado', SUELO.pisado], ['sueloArado', SUELO.arado], ['sueloCultivo', SUELO.cultivo],
  ['maderaBase', MADERA.base], ['maderaOscura', MADERA.oscura],
  ['pajaBase', PAJA.base], ['pajaClara', PAJA.clara],
  ['pielClara', PIEL.clara], ['pielMedia', PIEL.media], ['pielOscura', PIEL.oscura],
  ['ropaRoja', ROPA.roja], ['ropaRojaOscura', ROPA.rojaOscura], ['ropaAzul', ROPA.azul],
  ['sombra', SOMBRA], ['luz', LUZ],
];
