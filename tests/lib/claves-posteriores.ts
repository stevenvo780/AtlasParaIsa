import assert from 'node:assert/strict';

/**
 * Claves añadidas después de la forma histórica del commit 5329242. El valor neutro documenta la
 * condición bajo la cual puede quitarse sólo la declaración para comparar el digesto físico.
 */
export const CLAVES_POSTERIORES = Object.freeze({
  'conducta.vocacion': 0,
  'conducta.practicaOficios': 0,
  'conducta.saturacionLocal': 0,
  'social.banda': 0,
  // Centinela neutro para la comparación histórica: su default de schema es 6, pero la clave
  // completa no participa cuando `banda=0` y se elimina antes de validar/hashear la forma vieja.
  'social.bandaMax': 0,
} as const);

export const NOMBRES_CLAVES_POSTERIORES = Object.freeze(Object.keys(CLAVES_POSTERIORES));

/** Comprueba que las cinco claves de VOC/PO1/SL1/B1 están apagadas en `vigentes` (`social.bandaMax`
 * se comprueba por `social.banda`, su guard maestro: el propio valor de `bandaMax` no importa) y las
 * borra de `forma` antes de hashear, igual que cada prueba de identidad anterior hace con su propia
 * clave (`social.memoriaDisputa`, `conducta.aptitud`…). `vigentes` y `forma` pueden ser el mismo
 * objeto sólo si `forma` no se ha mutado todavía para las claves posteriores a `social.banda`. */
export function borrarClavesPosteriores(
  vigentes: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  forma: Record<string, Record<string, unknown>>,
): void {
  for (const clave of NOMBRES_CLAVES_POSTERIORES) {
    const [seccion, hoja] = clave.split('.') as [string, string];
    const centinela = clave === 'social.bandaMax' ? 'social.banda' : clave;
    const [seccionCentinela, hojaCentinela] = centinela.split('.') as [string, string];
    assert.equal(vigentes[seccionCentinela]![hojaCentinela], 0, `${centinela} = 0: ${clave} no actúa`);
    delete forma[seccion]![hoja];
  }
}
