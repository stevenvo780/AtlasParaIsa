/**
 * Guardia de solo lectura de la fase de decisión (T148, `motor.depuracion`).
 *
 * Con `motor.depuracion=false` (default) el envoltorio devuelve el propio mundo: ni proxies ni copias,
 * coste cero. Con `motor.depuracion=true` la fase de decisión recibe un proxy profundo del mundo en el
 * que cualquier escritura, borrado, redefinición o mutador de un `TypedArray`/`Map`/`Set` lanza un
 * `Error` que nombra el slot culpable y la ruta mutada (p. ej. `… por slot 3 sobre tiles[0].food`).
 *
 * Límites conocidos (la guardia es de diagnóstico, no una barrera criptográfica):
 * · un valor leído de un `Map`/`Set` (`get`, `forEach`…) no pasa por el proxy;
 * · un proxy creado para un objeto ya visto conserva la ruta de su primer acceso;
 * · las propiedades no configurables y no escribibles devuelven el valor real (invariante de `Proxy`).
 */
import type { World } from '../index.js';
import { paramsOf, setParams } from '../params.js';

/** Mutadores de `TypedArray` que escriben en el buffer compartido (sin `DataView`). */
const MUTADORES_TIPADOS: ReadonlySet<string> = new Set(['set', 'fill', 'copyWithin', 'reverse', 'sort']);
/** Mutadores de `Map` y `Set`. */
const MUTADORES_COLECCION: ReadonlySet<string> = new Set(['set', 'add', 'delete', 'clear']);

function unirRuta(base: string, clave: string | symbol): string {
  const texto = String(clave);
  if (base === '') return texto;
  return /^\d+$/.test(texto) ? `${base}[${texto}]` : `${base}.${texto}`;
}

function prohibido(operacion: string, actorSlot: number, ruta: string): never {
  throw new Error(`${operacion} prohibida en fase B por slot ${actorSlot} sobre ${ruta}`);
}

function esVistaTipada(valor: object): valor is ArrayBufferView & { slice(...args: number[]): unknown } {
  return ArrayBuffer.isView(valor) && !(valor instanceof DataView);
}

function mutadoresDe(valor: object): ReadonlySet<string> | undefined {
  if (esVistaTipada(valor)) return MUTADORES_TIPADOS;
  if (valor instanceof Map || valor instanceof Set) return MUTADORES_COLECCION;
  return undefined;
}

/**
 * Proxy profundo de solo lectura para `actorSlot` sobre `objetivo`. Los objetos anidados se envuelven
 * al leerse (con caché por objeto, para que `===` entre lecturas siga valiendo). No consulta
 * `motor.depuracion`: quien lo llama decide si lo necesita (`withReadOnlyDecisionGuard` lo hace).
 */
export function createDecisionReadOnlyProxy<T extends object>(objetivo: T, actorSlot: number): T {
  const envueltos = new WeakMap<object, object>();

  const envolver = (valor: object, ruta: string): object => {
    const previo = envueltos.get(valor);
    if (previo) return previo;
    const proxy = new Proxy(valor, manejador(ruta));
    envueltos.set(valor, proxy);
    return proxy;
  };

  const manejador = (rutaBase: string): ProxyHandler<object> => ({
    get(target, clave) {
      if (typeof clave === 'symbol') return Reflect.get(target, clave, target);
      const mutadores = mutadoresDe(target);
      if (mutadores?.has(clave)) return () => prohibido('Escritura', actorSlot, `${unirRuta(rutaBase, clave)}()`);
      // Un buffer o una vista se leen como copia: su escritura nunca llega al mundo real.
      if (esVistaTipada(target) && clave === 'buffer') return (target.buffer as ArrayBuffer).slice(0);
      if (esVistaTipada(target) && clave === 'subarray') return target.slice.bind(target);
      const valor: unknown = Reflect.get(target, clave, target);
      if (typeof valor === 'function') return mutadores ? valor.bind(target) : valor;
      if (valor === null || typeof valor !== 'object') return valor;
      const descriptor = Reflect.getOwnPropertyDescriptor(target, clave);
      // Invariante de Proxy: una propiedad no configurable y no escribible debe devolver su valor real.
      if (descriptor && descriptor.configurable === false && descriptor.writable === false) return valor;
      return envolver(valor, unirRuta(rutaBase, clave));
    },
    set(_target, clave) { return prohibido('Escritura', actorSlot, unirRuta(rutaBase, clave)); },
    deleteProperty(_target, clave) { return prohibido('Borrado', actorSlot, unirRuta(rutaBase, clave)); },
    defineProperty(_target, clave) { return prohibido('Redefinición', actorSlot, unirRuta(rutaBase, clave)); },
    setPrototypeOf() { return prohibido('Cambio de prototipo', actorSlot, rutaBase || 'raíz'); },
    preventExtensions() { return prohibido('Bloqueo de extensión', actorSlot, rutaBase || 'raíz'); },
    getOwnPropertyDescriptor(target, clave) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, clave);
      if (!descriptor || typeof descriptor.value !== 'object' || descriptor.value === null) return descriptor;
      if (descriptor.configurable === false && descriptor.writable === false) return descriptor;
      return { ...descriptor, value: envolver(descriptor.value, unirRuta(rutaBase, clave)) };
    },
  });

  return envolver(objetivo, '') as T;
}

/**
 * Ejecuta `fn` con la vista de solo lectura del mundo para el slot `actorSlot`. Con
 * `motor.depuracion=false` llama a `fn(world)` directamente (coste cero). Con `true` pasa un proxy
 * con los mismos params registrados (`paramsOf(vista)` devuelve los del mundo).
 */
export function withReadOnlyDecisionGuard<T>(world: World, actorSlot: number, fn: (vista: World) => T): T {
  const params = paramsOf(world);
  if (!params.motor.depuracion) return fn(world);
  const vista = createDecisionReadOnlyProxy(world, actorSlot);
  setParams(vista, params);
  return fn(vista);
}
