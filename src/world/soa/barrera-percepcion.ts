/**
 * Barrera de escritura del terreno percibido. Lo que F2 percibió sigue valiendo mientras no cambie nada de lo que lee
 * (`CAMPOS_PERCEPCION`: terreno, comida, agua potable, madera, piedra, humedad y vegetación). Toda ley que escriba uno
 * de esos campos de una tesela llama a `marcarTesela` después de hacerlo: durante la fase de personas eso sube la
 * versión de la página de esa tesela, y el dueño rehace la percepción de quien tenga esa página en su disco. Fuera de
 * la fase no hay destino y no cuesta nada: la captura siguiente compara la página entera.
 */
export interface DestinoBarrera { tocar(x: number, y: number): void }

let destino: DestinoBarrera | undefined;

export function marcarTesela(tesela: { readonly x: number; readonly y: number }): void {
  destino?.tocar(tesela.x, tesela.y);
}

/** La fase de personas abre la barrera sobre su terreno y, al terminar (también si falla), deja la que había. */
export function abrirBarrera(nuevo: DestinoBarrera): DestinoBarrera | undefined {
  const previo = destino;
  destino = nuevo;
  return previo;
}
export function cerrarBarrera(previo: DestinoBarrera | undefined): void { destino = previo; }
