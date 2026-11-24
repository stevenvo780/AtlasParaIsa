# Motor V23: arquitectura única

Base `v24-base` (`849a895`); rutas relativas a él. Contrasté con el código: personas y demografía en serie (`index.ts:2228-2273`), proyección y clonación por tick con freno a 64 fotogramas (`sim-worker.ts:326-416`), arena que reasigna al crecer (`arena.ts:56-62`), barrera sin plazo (`barrera.ts:27-33`), VRAM autoritativa y modo repartido solo en bancos (`puente.ts:744,782-816`). Node 22.23.3 de la torre admite `SharedArrayBuffer` crecible con vistas que siguen su longitud (comprobado). No ejecuté pruebas: las cifras son estimaciones.

## 1. Idea central

1. Un proceso, ticks globales sin reloj de pared. El mundo se parte en chunks 16×16; cada chunk tiene por tick un **hilo dueño**, único escritor de sus celdas y de los organismos que hay en él.
2. **La RAM (SAB crecible) es la única autoridad.** Las GPU guardan copias de solo lectura versionadas por página y devuelven resultados; si caen, la CPU rehace el mismo cálculo sin perder nada.
3. Lo que otros leen es un **frente público con doble búfer** (el de t no cambia durante t+1). Lo privado de una persona vive en el heap de su dueño y migra serializado.
4. **Ningún agente escribe en otro:** toda acción sobre otro organismo o sobre una celda de otro chunk es un *intento* al buzón de su dueño, que lo aplica contra su estado actual. La materia viaja en garantía y toda garantía termina: aceptada, devuelta o depositada.
5. La decisión se trocea: **percepción y cerebro en GPU** (o cualquier hilo) por lotes de vencidos; lo irregular y la elección, en el dueño. Un **fotograma** es el frente publicado tras el tick, binario, escrito en paralelo cuando la cinta da crédito: el motor nunca espera a quien mira.

**Base e injertos.** Esqueleto de Opus (dueños, buzones con garantía, troceo de `choose()`), porque conserva las leyes TS sobre objetos `Person`; el almacén «todo en SAB» de GPT exige reescribir el estado y todas las leyes a accesores SoA, semanas que chocan con la reescritura de materia (decisión 6). De GPT, los principios: autoridad explícita, transacciones completas o rechazadas, recuperación solo desde lo durable, invariantes en vez de paridad. De Sonnet, épocas y sucesos sin pérdida. Cada objeción de la crítica se resuelve en §3.9.

## 2. Modelo de datos

| Estado | Dónde | Quién lo escribe | Cuándo |
|---|---|---|---|
| Celdas y materia (enteros por elemento, contrato de la pieza de materia) | Arena de páginas 16×16 sobre SAB crecible (`soa/arena.ts`, `soa/terreno.ts`) | Dueño del chunk; ecología en su fase exclusiva | F4–F5, y fase eco cada 10 ticks |
| Versión de página y bits de «cambio visible» | `Uint32Array`/`Uint8Array` por página | Dueño | Al escribir |
| Dueño por chunk (vigente y siguiente) | `Int16Array` SAB | Coordinador | F0 |
| Frente público de organismos, personas y fauna (una tabla, columna `clase`) | SoA SAB crecible, 2 frentes | Dueño de la fila | Solo F6 y solo en el frente t+1 |
| Persona: memoria, vínculos, cultura, conocimiento, política | Objeto `Person` en el heap del dueño | Dueño | F1–F6; migra con `v8.serialize` |
| Fauna completa (filas de ancho fijo; lo variable en páginas laterales) | SoA SAB | Dueño | Decidir es solo lectura (cualquier hilo o GPU) |
| Salidas de F2 (decisión de fauna, percepción por CPU) | Columnas de trabajo por slot (SAB) | El hilo que reclamó el lote (cada slot está en un solo lote) | F2 |
| Índice uid→slot, contadores de id, registro abierto | SAB (`Atomics`/CAS) | Cualquier hilo, sin orden | Cualquier fase |
| Globales pequeños: lugares, comunidades, carta | Réplica de solo lectura por hilo | Coordinador, por peticiones | F0; los hilos la ponen al día en F1 |
| Sucesos (crónica) | Registro por hilo, sin pérdida | Hilo que los crea | Siempre; el coordinador los junta en F0 |
| Libro de materia | `BigInt64Array` por hilo | Hilo | Al debitar o acreditar una garantía |
| VRAM | Espejo por tarjeta: campos de percepción por página y filas del frente | Puente GPU | Subidas en F0 por versión; nunca es autoridad |

### Contratos a congelar (`src/world/motor/contratos.ts`, primer commit tras E-pre)

```ts
import type { Gesture, GestureResult, ChronicleEvent, PlaceView, CommunityView } from '../../shared/types.js';
import type { World, Person } from '../index.js';

export type Slot = number;                 // fila estable de por vida del organismo
export type Ref = number;                  // gen * 2**32 + slot  (gen < 2**21: cabe en un double)
export type Hilo = number;                 // 0 = coordinador, que además es dueño 0
export type ChunkId = number;
export const enum Clase { Persona = 1, Animal = 2 }
export const refDe = (s: Slot, gen: number): Ref => gen * 4294967296 + s;
export const slotDe = (r: Ref): Slot => r % 4294967296;
export const genDe = (r: Ref): number => Math.floor(r / 4294967296);

/** Solo lectura: TS rechaza `c[i] = v`. En modo verificar, el frente leído se sella con CRC32 por tick. */
export interface Col { readonly [i: number]: number; readonly length: number }

export interface FrentePublico {           // estado tras el tick `tick`; inmutable durante el siguiente
  readonly tick: number; readonly alta: number;
  readonly gen: Col; readonly vivo: Col; readonly clase: Col; readonly especie: Col;
  readonly uid: Col;                       // identidad durable (f64), nunca reutilizada
  readonly dueno: Col;                     // hilo que tiene al organismo durante el tick siguiente
  readonly x: Col; readonly y: Col; readonly chunk: Col;
  readonly accion: Col; readonly objetivo: Col; readonly decideEn: Col;
  readonly cuerpo: Col;                    // CUERPO_ANCHO f32 por slot
  readonly rasgos: Col;                    // RASGOS_ANCHO f32 por slot: entrada de la cabeza lineal
  col(nombre: string): Col;                // columnas que registran los demás carriles
}
export interface FrenteEscritura {         // frente t+1; un dueño solo toca filas con dueno == hilo
  fila(slot: Slot): void;                  // sella escritoPor[slot] = hilo (se comprueba en modo verificar)
  f32(nombre: string): Float32Array; f64(nombre: string): Float64Array; i32(nombre: string): Int32Array;
}
export interface TablaOrganismos {
  columna(nombre: string, tipo: 'f32' | 'f64' | 'i32' | 'u16' | 'u8', ancho: number): void; // antes de arrancar
  lectura(): FrentePublico; escritura(h: Hilo): FrenteEscritura;
  alta(h: Hilo, c: Clase): Ref;            // slot libre tras 2 ticks de cuarentena; gen nueva
  baja(h: Hilo, r: Ref): void;             // gen++ y vivo = 0 en el frente t+1
}

export interface Terreno {
  readonly versionPagina: Uint32Array;     // la sube el dueño; la GPU sube solo lo que cambió
  readonly duenoChunk: Int16Array;         // vigente durante el tick; lo cambia el coordinador en F0
  celda(x: number, y: number): number;     // −1 si no residente
  pagina(celda: number): number; chunkDe(celda: number): ChunkId;
  campo(nombre: string): Col;
}
export interface TerrenoDueno extends Terreno {
  escribible(nombre: string, c: ChunkId): Float64Array | Float32Array | Int32Array | Uint8Array; // verifica dueño en modo verificar
  marcar(pagina: number, visible: boolean): void;   // versión++ y, si visible, bit para el fotograma
}

export const enum TipoIntento {
  Tomar = 1, Depositar, Dar, Golpear, Vincular, Ensenar,   // sobre otro organismo o celda de otro chunk
  ProponerCria, Concebido, Rechazado,                       // reproducción (§3.2)
  Concedido, Devuelto,                                      // respuestas que llevan garantía
  Migrante, Gesto, Activar, Global,                         // motor: migración, mensaje divino, chunk nuevo, coordinador
}
export interface Intento {
  tipo: TipoIntento; de: Ref; a: Ref;      // a = −1 si el destino es una celda
  celda: number;                           // −1 si no aplica
  nonce: number;                           // slot(de)·2^20 + contador propio: repetir no duplica efectos
  materia: Int32Array | null;              // garantía en tránsito, ya debitada del emisor (por elemento)
  dato: Float64Array | null;               // cantidad pedida, daño, peso…
  bytes: Uint8Array | null;                // v8.serialize: migrante, conocimiento, gesto
}
export interface Buzon {
  enviar(destino: Hilo, i: Intento): void; // MPSC: Atomics.add reserva sitio; el SAB crece sin copiar
  vaciar(f: (i: Intento) => void): number; // solo el dueño, en su fase; orden barajado con su azar
}
/** Por hilo. En F0, Σ almacenes + Σ enVuelo = inicial + fuentes − sumideros, por elemento y exacto. */
export interface Libro { enVuelo: BigInt64Array; fuentes: BigInt64Array; sumideros: BigInt64Array }

export interface Registro {                // abierto y direccionado por contenido: especies, recetas, planos
  insertar(canonico: Uint8Array): bigint;  // id = hash64 de los bytes; idempotente desde cualquier hilo (CAS)
  leer(id: bigint): Uint8Array | undefined;
}
export interface Globales { lugares: ReadonlyMap<string, PlaceView>; comunidades: ReadonlyMap<string, CommunityView>; registro: Registro; version: number }

export interface CtxLectura {              // F2: cualquier hilo
  readonly tick: number; readonly frente: FrentePublico; readonly terreno: Terreno;
  readonly ref: (uid: number) => Ref;      // −1 si no vive
  readonly globales: Globales;
}
export interface CtxDueno extends CtxLectura {   // F1, F3–F6: solo el dueño
  readonly hilo: Hilo; readonly chunks: Int32Array;
  readonly personas: ReadonlyMap<Slot, Person>;
  readonly propio: TerrenoDueno; readonly escritura: FrenteEscritura;
  readonly buzon: Buzon; readonly libro: Libro;
  azar(): number;                           // xorshift del hilo; world.rng solo lo usa el coordinador
  id(tipo: 'uid' | 'suceso' | 'comunidad' | 'estructura'): number; // único, sin orden
  suceso(e: Omit<ChronicleEvent, 'id' | 'tick'>): string;
  pedirGlobal(tipo: 'lugar' | 'comunidad', datos: Uint8Array): void; // lo aplica F0 de t+1
}

/** Mejor celda alcanzable: minimiza Σ w·campo + pesoDist·dist + pesoPasos·pasos en la ventana BFS r = 7. */
export interface Consulta { campos: Int32Array; pesos: Float32Array; pesoDist: number; pesoPasos: number; filtros: Float32Array; alcanzable: boolean }
export interface ConsultaOrganismo { radio: number; clase: Clase; filtros: Float32Array; criterio: 0 | 1; columna: number }
export interface Plan { id: number; celdas: readonly Consulta[]; organismos: readonly ConsultaOrganismo[]; acciones: number }
export interface Lote { tick: number; slots: Int32Array; plan: Uint16Array }
export interface Percepcion {              // alineado con lote.slots: N×Q, N×Q, N×Q, N×V, N×A
  celda: Int32Array; pasos: Int16Array; valor: Float32Array; organismo: Float64Array; utilidad: Float32Array }
export interface Percibidor {               // CPU (cualquier hilo) o una tarjeta
  readonly dispositivo: 'cpu' | 'gpu0' | 'gpu1';
  lanzar(l: Lote, planes: readonly Plan[]): void;
  esperar(plazoMs: number): Percepcion;    // lanza ErrorDispositivo si vence el plazo o falla
}

export interface Fotograma {               // estado visible tras F6 del tick `tick`
  tick: number; epoca: number; completo: boolean; saltados: number;
  n: number; organismos: Uint8Array;       // n filas × ESQUEMA_VISIBLE, cuantizado, sin campos privados
  paginas: Int32Array; celdas: Uint8Array; // páginas con cambio visible desde el último entregado
  sucesos: [desde: number, hasta: number]; // rango del registro de sucesos sin pérdida
  serie: Float64Array;                     // SERIE_CAMPOS: población, nacimientos, muertes, fauna, Hz…
  reparto: Int16Array | null;              // dueño por chunk, solo en fotogramas completos
}
export interface EnlaceCinta {             // SAB compartido con el hilo de la cinta
  creditos: Int32Array;                    // [0] ranuras libres; con 0, el motor salta el fotograma
  pedirCompleto: Int32Array;               // [0] = 1 ⇒ el siguiente fotograma es completo
  ranura(i: number): Fotograma;
}

export interface Motor {
  paso(gestos: readonly Gesture[]): { tick: number; resultados: GestureResult[] };
  instantanea(): World;                    // reúne todo en una barrera: un tick coherente para Store.save
  cargar(world: World, epoca: number): void; // reparte tras Store.load o una recuperación
  detalle(uid: number): Promise<Person | null>; // inspector: lo serializa el dueño en el F1 siguiente
  telemetria(): TelemetriaMotor; cerrar(): Promise<void>;
}
export interface TelemetriaMotor {
  tick: number; hz: number; diasPorMinuto: number; hilos: number; desequilibrio: number;
  faseMs: Record<'F0' | 'eco' | 'percibir' | 'actuar' | 'aplicar', number>; esperaBarreraMs: number;
  ocupacion: Float32Array; gpuMs: number[]; gpuBytes: number[]; gpuEstado: ('ok' | 'cpu' | 'sin')[];
  intentos: number; rechazados: number; migraciones: number; fotogramasSaltados: number;
}
export interface MotorConfig {             // del proceso, ya no del mundo (sustituye a params.motor)
  hilos: number | 'auto'; gpu: number[]; decisionGpu: 'siempre' | 'medido'; verificar: boolean;
}
```

## 3. Algoritmos

### 3.1 Un tick

```
F0  coordinador (serie, corto)
    gestos → Intento Gesto al buzón B del dueño; sumar libros, contadores y sucesos de t−1 (crónica)
    peticiones Global/Activar: lugares, comunidades nuevas, chunks nuevos (la arena crece SOLO aquí)
    si toca: nuevo reparto en duenoSiguiente[]; si toca fotograma y hay crédito: fotogramaDebido = 1
    cada 10 ticks: fase eco exclusiva con barrera (piscina por reclamo de páginas; GPU o CPU, código actual)
    GPU: subir páginas con versión nueva + filas cambiadas del frente t; lanzar Lote(vencidos de t)
──  B1
F1  dueño: adoptar migrantes; vaciar B (Concedido, Devuelto, Concebido, Rechazado, Gesto, Dar/Depositar tardíos)
F2  dueño: candidatos fríos de sus personas vencidas (estado privado)
    todos: reclamar lotes de 64 slots (Atomics.add) de trabajo de lectura: fauna vencida; percepción
           CPU de lo que no fue a GPU o de una tarjeta caída
──  B2  + esperar Percepcion GPU (plazo 2 s; si vence → la CPU recalcula ese lote, es solo lectura)
F3  dueño: elegir (previsión corporal, valores, aptitud) y fijar acción y objetivo
F4  dueño: cuerpo, mover, trabajar; escribe celdas del chunk donde empezó el tick; el resto → buzón A
──  B3
F5  dueño: vaciar A barajado; aplicar cada intento contra el estado actual (recorte a existencias);
    respuestas con garantía → B; nacimientos y muertes propias
F6  dueño: publicar sus filas en el frente t+1; si fotogramaDebido: escribir sus filas visibles y sus
    páginas marcadas en la ranura (sitio reservado con Atomics.add); emigrar (Migrante → B)
──  B4  intercambiar frentes; duenoVigente = duenoSiguiente
```

Cuatro barreras por tick sobre `paralelo/barrera.ts`, workers persistentes, sin `postMessage` por despacho. Con `dueños = 1` (el hilo de simulación) el tick es idéntico y los demás hilos solo hacen F2: es E1 y el modo en que las otras piezas programan contra los contratos antes de que existan los dueños.

### 3.2 Intentos, garantía y nacimientos

**La regla depende del chunk, nunca del hilo.** Un actor escribe directo solo su propio estado y las celdas del chunk donde empezó el tick. Todo lo demás, incluidos otros organismos del mismo chunk, va por intento aunque el destino lo tenga el mismo hilo: el número de hilos cambia la muestra, no la ley.

| Intento | El dueño destino lo aplica así (F5) |
|---|---|
| `Tomar(celda,q)` | `g = min(q, existencias)`; débito; `Concedido(g)` con la materia → B |
| `Dar(a,m)` / `Depositar(celda,m)` | `a` vivo y de este dueño → acreditar; si no → depositar en la celda de `a` según el frente t; si esa celda es ajena, `Depositar` reenviado |
| `Golpear(a,d)` | daño; si muere, su materia queda como cadáver en su celda (si es de otro chunk, `Depositar`) |
| `Vincular` / `Ensenar` | modifica solo el lado del receptor; el emisor ya modificó el suyo |
| `Devuelto` | toda garantía rechazada vuelve; si el emisor murió → `Depositar` en su última celda |

Debitar al enviar suma a `enVuelo`; acreditar resta. Toda garantía es terminal en ≤ 2 ticks (I-B). `convivir` deja de escribir los dos extremos (`society.ts:134`): cada dueño sube su lado leyendo el frente t, sin mensajes, y es simétrico porque ambos leen el mismo frente.

**Nacimiento atómico** (sustituye a `index.ts:2307-2358`, que debita a ambos padres en `:2342`; la ley concreta es de la pieza de leyes):

```
F4 de b: quiere criar con g (Ref del frente t) → debitar su aporte m_b (puede ser 0), enVuelo += m_b
         enviar(dueno[g], ProponerCria{de:b, a:g, nonce, materia:m_b, bytes:genoma_b})
F5 de dueño(g), único escritor de g: propuestas barajadas;
   descartar nonce ya visto (idempotencia)
   aceptar la PRIMERA que cumpla: g vivo con la misma gen, fértil, sin gestación, y que no haya
   propuesta mutua g→b este tick con slot(g) > slot(b)        // de una pareja mutua solo vale una
   g.gestacion = {padreUid, genoma_b, m_b, nonce} → Concebido a b; las demás → Rechazado + Devuelto(m_b)
Parto (dueño de g, cuando lo diga la ley): alta() + id('uid'); cuerpo de la cría = materia de g + m_b. Todo es local y atómico.
```

Resuelve también las gestaciones sobrescritas que la crítica señala en `leyes-opus`: solo el dueño de g escribe en g.

### 3.3 Carreras

**Toleradas:** quién gana un recurso disputado (orden barajado); ver lo ajeno un tick atrás; leer en F4 una celda ajena a medio escribir (el aplicador recorta igual); qué hilo o GPU percibe; FP32/FMA; ids sin orden. **Prohibidas:** doble consumo (escritor único + recorte), negativos (enteros, solo debita el dueño), referencias colgantes (`Ref` comprueba `gen` y `vivo`; nunca se comparte un objeto JS), materia creada o perdida en tránsito (`Libro`), dos dueños a la vez (emigra en F6, se adopta en F1), fotograma mezclado (se escribe en F6 y se entrega tras B4).

### 3.4 Troceo de `choose()` (`index.ts:777-1520`)

Desglose de Opus, verificado (BFS r = 7 en `personas-worker.ts:29,166-243`):

| Parte | Líneas | Qué es | Dónde |
|---|---|---|---|
| Percepción regular | ventana y BFS 791-819 y 524-588; mejor comida, agua, presa, refugio, material, sol, cultivo y espacio (879-886, 1012-1022, 1073-1118, 1136-1232) | unas 10 `Consulta` + 3 `ConsultaOrganismo` en `decision/planes.ts` | GPU, o cualquier hilo |
| Cerebro | 691-753, 1402-1443 y puntuaciones base | red 12→8→12 (`politica.ts`) + `W·rasgos` con una sola tabla `W` en TS | GPU, misma tarjeta que la percepción |
| Candidatos fríos | asentamiento, familia, cortejo, memorias, obra, invento, invitaciones… (862-1321 menos lo anterior) | lee el `Person` privado | dueño, en F2 |
| Elegir | 1322-1401, 1456-1516 | previsión corporal, valores, aptitud, efectos | dueño, en F3 |

La fauna (`animals.ts:628`) pasa a un `Plan` con pesos del genoma, entera en F2; comer, cazar y criar van en F4–F5 con intentos.

### 3.5 Decisión en GPU (decisión 3)

- **Puente:** un servidor Python por tarjeta (`scripts/gpu/servidor-gpu.py`, funde `compute-ecology-gpu-resident.py` y `compute-policy-gpu.py`) y un canal TS único (`gpu/canal.ts`) en vez de las dos copias de `Reader`/`send` (`puente.ts:52`, `politica-gpu.ts`). Dos viajes por tick como mucho: lanzar en F0, esperar en B2. El complemento N-API de GPT queda fuera de V23; entra solo si el banco mide que el viaje pasa del 20 % del tick.
- **Kernel `percibir`:** un bloque CUDA por actor vencido; BFS 15×15 en memoria compartida; `argmin` por `Consulta` sobre 225 celdas; consultas de organismo sobre rejilla CSR por celda; después la red y `W·rasgos` con pesos por slot residentes (solo suben las filas sucias). Salida ≈ 150 B por actor: los rasgos no salen de la tarjeta.
- **Dos tarjetas:** espejo replicado en ambas; los vencidos se reparten por rendimiento medido (EMA), no 79/21 fijo (`puente.ts:622-627`). La ecología sigue con `run()` (`puente.ts:739-776`), bajando a una zona de preparación que se copia al confirmar. FP32: se quita `--fmad=false` (`compute-ecology-gpu-resident.py:149`).
- **Política:** `decisionGpu: 'siempre'` (decisión 3, aunque hoy no compense). Si una tarjeta falla, ese tick va por CPU y la tarjeta queda apagada hasta reiniciar; el mundo nunca se pausa.

### 3.6 Fotograma: lo que la cinta de vida entera necesita del motor

- **Fotograma** = estado visible tras F6 de un tick: filas vivas cuantizadas, páginas con cambio visible desde el último entregado, rango de sucesos y serie. Lo escriben los dueños en paralelo en la ranura; desaparecen `projectMirrorWorld` y la clonación por tick (`sim-worker.ts:233-264,326-405`), que hoy son ~80 % del tick.
- **Cadencia por créditos:** sin crédito el motor salta y cuenta `saltados`; se borra el freno `sim-worker.ts:416`.
- **Sucesos sin pérdida:** registro por hilo que F0 junta en uno. Es el único freno físico: si la cinta no consume y pasa de 256 MiB, el coordinador espera (el disco no da abasto). Los textos visibles (razón, necesidad) van como sucesos `CambioTexto` solo al cambiar.
- **Época:** `cargar()` abre una (`{instanciaId, tick}`); la cinta marca lo huérfano. La pieza de cinta escribe el adaptador `fotogramaAVista` (el `WorldView` de hoy) y deriva L0–L4; el motor no sabe de niveles ni graba átomos (la pieza de materia aporta la columna `forma`).

### 3.7 Fallos y recuperación

- **Worker muerto o excepción en un dueño:** se conserva el supervisor (`piscina.ts:92-246`), que convierte la salida de un hijo en `fatal`; las esperas pasan a `Atomics.wait` con plazo de 1 s en bucle y 60 s sin avance = `fatal`. Tras `fatal`: se descarta el mundo en memoria, `Store.load()` + `cargar()`, época nueva, bitácora (cableado de poda en `app.ts:930-955`).
- **GPU:** error o plazo → la CPU recalcula el lote en el mismo tick; nada se pierde porque la GPU nunca tiene autoridad.
- **Persistencia:** `instantanea()` en barrera; los dueños serializan sus personas en paralelo y el coordinador arma un `World` para el `Store.save` actual (`store.ts:1541`), con diarios y validación intactos. Mundo nuevo (decisión 12): sin conversión.
  - Cada guardado es **completo**: con el motor libre, reejecutar ticks ya no reproduce (`store.ts:540-542` lanzaría `Replay gesture result mismatch`). Por eso `persistencia.paginasSucias` queda en `false`, que es el valor por defecto (`params.ts:232`), y la pieza de poda borra el replay (`store.ts:493-690`).
  - El `World` de la instantánea lleva copias en arrays normales y nunca un SAB: `clon.ts:77` rechaza prototipos de typed arrays, y clonar un SAB comparte memoria.
  - Los ids del `Registro` se guardan como texto hexadecimal de 16 cifras, porque `exact-json.ts:121` no codifica `bigint`.

### 3.8 Reparto y competencia (decisión 4)

Chunks en orden Morton (`mortonCode` se conserva), cortados en T tramos contiguos de coste medido (EMA de ms de pared por chunk). Se rebalancea cada 240 ticks o tras 3 ventanas con `máx/media > 1,3`: un hilo retrasado por la torre recibe menos chunks. `hilos:'auto'` compara cada 60 s el Hz con T y ¾T y se queda el mejor. Se quitan la reserva de 4 hilos (`hardware-limits.ts:187`) y `CPUWeight=10000` (`atlas-publico.prioridad.conf:3`, de la pieza de poda); se conserva el nombre «carta-isa» para no caer en `SCHED_IDLE` de ananicy.

### 3.9 Objeciones de la crítica

| Objeción | Resolución |
|---|---|
| Opus 1: VRAM sobrescrita; GPU caída deja terreno viejo | La VRAM nunca es autoridad: se borran `runTick`/`flushToHost`/`vramAhead` (`puente.ts:580,782-816`); bajada a zona de preparación; si cae, la CPU recalcula |
| Opus 2: reproducción no atómica | §3.2: escritor único de la gestante, nonce, regla de pareja mutua, garantía devuelta o depositada |
| Opus 3: F5 mezcla publicar y consumir; `Readonly` no protege | Doble frente (nadie lee el que se escribe); adopción en F1, antes de usar el objeto; `Col` sin escritura más CRC y sello `escritoPor` en modo verificar |
| Opus 4: barrera sin salida | Supervisor conservado, plazos, `fatal` → recarga |
| Opus 5: 6,36 MB/tick | Solo vencidos; percepción y cerebro en la misma tarjeta; ≈150 B por actor (§6); tramo serial por dueño medido y repartido |
| GPT 1: grafo que serializa aldeas | No hay grafo: vínculos actualizados por lado; transacciones solo de materia, con garantía |
| GPT 2: precondiciones de lectura frente a escritura | Lo que se consume lo valida su único dueño contra el estado actual al aplicar; entre dueños se encadena reteniendo antes lo propio. Sin cerrojos ni interbloqueo |
| GPT 3: vida útil de páginas | SAB crecible (las vistas no cambian de identidad); la arena crece solo en F0; slots con 2 ticks de cuarentena; la cinta copia, no referencia |
| GPT 4: persistencia | `instantanea()` en barrera con la RAM como única autoridad + `Store` actual |
| GPT 5: combinatoria química | Requisito a materia: coste por celda acotado por muestreo de sitios, no por enumeración (`chemistry.ts:466`); registro por contenido sin carreras |
| Cinta 1: cola inestable | Créditos + fotogramas coalescidos; sucesos sin pérdida con tope físico declarado |
| Cinta 2–5 | De la pieza de cinta; el motor da páginas 16×16 (sectores naturales) y fotogramas sin niveles |

## 4. Qué se borra y qué se conserva

**Se borra (carriles del motor):**
- `paralelo/identidades.ts`, `reduccion.ts`, `agregados.ts`, `guardia.ts` (los sustituyen el sello `escritoPor` y la comprobación de dueño); `particion.ts:9-54` (órdenes); `piscina.ts:173-191,343-357` (retardos adversariales); las tres piscinas pasan a una.
- Escala que el mundo real no ejecuta (decisión 11): `halo.ts`, `soa/personas.ts`, `personas-motor.ts` y `fauna-motor.ts` enteros; de `personas-worker.ts` y `fauna-worker.ts` el BFS pasa a `decision/percepcion.ts` y el resto se borra. El trabajo que pretendían hacer lo hacen los dueños.
- GPU: VRAM autoritativa (`puente.ts:580,782-816`); modo repartido de más de 16 M celdas (`puente.ts:744` y las ramas `sharded`/halos de `ResidentTopology`, `:332-569`; se conserva la sincronización incremental por página); `reparto.ts` salvo `mortonCode`; `autoprueba.ts` y sus llamadas (`server/main.ts:93-110`, `sim-worker.ts:430-434`); `politica-gpu.ts` y `compute-policy-gpu.py` (se funden); `compute-ecology-gpu.py`, `compute-ecology.cu`, `compute-ecology-core.mjs`, `compute-ecology-clients.mjs`.
- Fauna: `animals.ts:16,23` (topes), `:1041-1046` (cupo y umbral 384), `:858-998` (certificado, orden canónico, máscara), `:86,188` (orden por id).
- `index.ts`: `:77-97` (`hypot2`), `:2203-2216` (`FASES_SERIALES`), `:2234-2237`, `:2226` (`withArchiveReadBatch`; cada worker abre `node:sqlite` de solo lectura), borradores de módulo de `choose` (pasan a uno por hilo) y el bucle serie `:2253`.
- `ecosystem-kernel.ts:281-358` (serie sobre objetos) y los relanzamientos `:201,255` (pasan a caída a CPU); `params.ts:77,235,397,467-472` (`motor.*` sale del mundo y pasa a `MotorConfig`); `hardware-limits.ts:187`.
- Servidor (lo aplica el dueño de cada fichero): `sim-worker.ts:233-416` (proyección, espejo y freno), `app.ts:831-836` (clon y punto de restauración por paso) y `server/governor.ts`, un freno de natalidad por latencia de reloj, es decir, una tasa humana encubierta (decisión 7; lo borra la pieza de poda o la de leyes).

**Se conserva:** `soa/arena.ts` (pasa a SAB crecible), `soa/terreno.ts`, `soa/region.ts`, `soa/presencia.ts`, `paralelo/paginas.ts`, `paralelo/barrera.ts`, el supervisor de `piscina.ts:92-246`, `puente.ts` `run` + `ResidentTopology.delta`, `ecology-kernel.ts` y los kernels residentes en FP32, `politica.ts`, `politica-obs.ts`, `mortonCode` y `digesto.ts` (solo para la integridad del `Store`).

## 5. Etapas (cada una deja el mundo andando)

| Etapa | Ficheros | Hecho cuando |
|---|---|---|
| **E-pre** (½–1 día) | Partir `index.ts` en `mundo/paso.ts`, `decision/personas.ts`, `actuar/personas.ts`, `actuar/interacciones.ts` y `demografia/nacer.ts`, sin cambiar la conducta | Typecheck y suite verdes y **digestos dorados idénticos**: es la última vez que el determinismo sirve |
| **E0 Libre** (1–2 días) | `motor/contratos.ts`; piscina única persistente; arena crecible; caída a CPU de la GPU; borrados de §4 que no dependen de dueños; `scripts/banco-motor.mts` | 270 personas: paso ≤ 20 ms; matar la GPU no pausa nada; 0 violaciones de invariantes |
| **E1 Percibir en paralelo** (3–4 días) | `soa/organismos.ts`, `soa/fauna.ts`, `decision/{percepcion,planes,fauna}.ts`, `choose` troceado; dueño único = hilo de simulación | F2 escala ≥ 10× con 32 hilos; equivalencia estadística 1 frente a 32 |
| **E2 GPU** (3–4 días, en paralelo con E1 una vez congelados los contratos) | `gpu/canal.ts`, `gpu/percibir-gpu.ts`, `scripts/gpu/*`, recorte de `puente.ts`, FP32 | Lote de 4.000 vencidos ≤ 3 ms; ≤ 2 MB/tick; caída probada en cada fase |
| **E3 Dueños** (5–7 días) | `motor/{coordinador,dueno-worker,buzon,libro,aplicar,reunir,fotograma}.ts`, intentos en `actuar/*`, protocolo de cría | Conservación exacta; referencias limpias; frontera sin sesgo; ≥ 300 Hz con 270 personas en el banco integrado |
| **E4 Reparto** (1–2 días) | `motor/rebalanceo.ts`, `hilos:'auto'` | Desequilibrio ≤ 1,3; con carga ajena en 16 hilos, ≥ 40 % del Hz en reposo y sin corrupción |
| **E5** | Banco integrado (motor + fotograma + guardado + cinta, aldea densa, crecimiento, carga), ensayo de 20 caídas `kill -9`, panel 4 × 30 × 3 réplicas, V23 | Veredicto del panel; cada caída vuelve al último guardado con época nueva |

## Carriles

| Carril | Ficheros en propiedad exclusiva | Depende de | Dificultad | Cómo se verifica |
|---|---|---|---|---|
| M0 Partición | `src/world/index.ts` → `mundo/paso.ts`, `decision/personas.ts`, `actuar/{personas,interacciones}.ts`, `demografia/nacer.ts` | — | media | Digestos dorados iguales antes y después |
| M1 Núcleo | `motor/{contratos,buzon,libro,contadores,registro}.ts`, `paralelo/{piscina,barrera}.ts`, `soa/arena.ts` | M0 | alta | `motor-buzones`, `motor-fallos` (worker muerto, plazo), crecimiento concurrente del SAB |
| M2 Tabla y percepción CPU | `soa/{organismos,fauna}.ts`, `decision/{percepcion,planes,fauna}.ts` | contratos | alta | `motor-frente` (CRC); equivalencia de la elección con el `choose` actual (distribución de acciones, KS de distancias) |
| M3 GPU | `gpu/{canal,percibir-gpu,puente,reparto}.ts`, `ecosystem-kernel.ts`, `scripts/gpu/*`, borrar `politica-gpu.ts`, `autoprueba.ts` y `compute-*` heredados | contratos | alta | GPU frente a CPU estadístico; matar el servidor en cada fase; bytes y ms por lote |
| M4 Dueños | `motor/{coordinador,dueno-worker,bloques,reunir}.ts`, `mundo/paso.ts` | M1, M2 | extrema | `motor-referencias`, equivalencia 1/8/32, `motor-frontera`, banco |
| M5 Interacciones | `actuar/interacciones.ts`, `motor/aplicar.ts` | M1 (funciona con dueño único) | alta | `motor-conservacion` exacta; garantías terminales en ≤ 2 ticks |
| M6 Fotograma | `motor/fotograma.ts`, `shared/fotograma.ts` (esquema visible) | M2; pieza de cinta | media | `motor-fotograma`: un solo tick por fotograma, sucesos contiguos, adaptador igual a `projectTapeFrame` sobre el mismo estado |
| M7 Reparto | `motor/rebalanceo.ts`, `server/hardware-limits.ts`, `scripts/banco-motor.mts` | M4 | media | Desequilibrio y prueba con carga ajena |
| M8 Pruebas | `tests/motor-*.test.ts`, `scripts/lab/equivalencia-motor.ts` | contratos | media | Pasan en `T=1` y en `T=32` |

**Fronteras con las otras piezas:** leyes (`society.ts`, `animals.ts`, natalidad) programa contra `CtxDueno`/`Buzon`; materia (almacenes por celda, química) entrega vectores enteros y el `Libro`; cinta (`sim-worker.ts`, `tape-*`, cliente) consume `Fotograma`; poda (`app.ts:928-973`, gobernador, systemd, cuarentena de pruebas, `invariantes.ts`). Hasta E3, `stepWorld()` sigue como fachada sobre `Motor` con dueño único y el servidor no cambia.

## Orden

1. **M0 solo**, antes que nadie: toca `index.ts`, que comparten todas las piezas.
2. **Contratos congelados** (los sube M1 y los revisa Opus). Desde ahí materia, leyes y cinta programan contra `CtxDueno` en modo `T=1`.
3. En paralelo: **M1, M2, M3, M8**.
4. En paralelo: **M4, M5, M6** (M6 cuando el otro equipo suelte `sim-worker.ts`).
5. **M7** y banco integrado; después **E5**.

Recomiendo integrar el motor **antes** que las leyes nuevas: con leyes iguales, `v24-base` hace de control estadístico. La publicación sigue siendo una sola, V23 (decisión 12).

## 6. Coste estimado y escala

Hoy (V22 en vivo): 273 personas y 546 animales a 4,5–5,5 Hz; `stepWorld` 20–30 ms (≈70 µs por persona y tick, fauna incluida); ≈80 % del tick en proyección, clonación y freno de la cinta; 2,2 núcleos ocupados de 32.

**Objetivo de paso, con fotograma binario:**

| Carga | E0 | E1 + E2 | E3 + E4 |
|---|---|---|---|
| 270 p + 550 a | ≤ 20 ms | ≤ 12 ms | ≤ 3 ms (≥ 300 Hz) |
| 3.000 p + 30.000 a | ~250 ms | ~120 ms | ≤ 30 ms (≥ 33 Hz) |
| 30.000 p + 300.000 a | — | — | ≤ 300 ms (≥ 3 Hz) |

- **E3 con 270 personas:** 16 ms de trabajo entre 32 hilos con eficiencia 0,4 ≈ 1,3 ms, más F0 ≈ 0,3 ms, 4 barreras de 10–30 µs y la GPU (0,2–0,5 ms, solapada con los candidatos fríos). Con pocos organismos la GPU resta por la latencia del viaje, lo que la decisión 3 acepta.
- **PCIe (3.000 p + 30.000 a):** ≈ 4.000 vencidos × 150 B de bajada ≈ 0,6 MB; subida de filas cambiadas ≈ 0,4 MB y de páginas sucias ≈ 1,2 MB: **≈ 2 MB/tick**.
- **Memoria (30.000 p + 300.000 a + 16 M celdas):** frente ≈ 110 MB (≈170 B × 2 frentes); personas privadas ≈ 0,6 GB (~20 KB cada una); fauna SoA ≈ 80 MB; celdas ≈ 4 GB si la pieza de materia cumple ≤ 256 B por celda activa; espejo GPU ≈ 256 MB por tarjeta; buzones de 1 GiB virtual que ocupan MB.
- **Pausa de `instantanea()`:** ≈ 10 ms con 270 personas, 1–2 s con 30.000.
- **Escala:** F2–F6 es lineal en organismos entre T hilos; el tramo serie es F0. El techo de la GPU replicada es la VRAM de la 2060 (6 GB ≈ 300 M celdas de percepción); por encima esa tarjeta deja de espejar y el mundo no tiene tope.
- **Medición:** `scripts/banco-motor.mts --personas 300,3000,30000 --hilos 1,8,16,32 --gpu no,0,0+1 --cinta --guardar --escena aldea-densa,crecimiento --carga 0,16 --ticks 2000 --replicas 3` → Hz, p50/p95, ms por fase, espera en barrera, ocupación, bytes de buzón y de PCIe, migraciones, fotogramas saltados.

## 7. Invariantes y pruebas que sustituyen a la paridad

Se registran en el marco `invariantes.ts` de la pieza de poda: en cada tick en las pruebas, por muestreo en producción.

- **I-C** `motor-conservacion`: Σ almacenes + Σ `enVuelo` = inicial + fuentes − sumideros, por elemento y **exacto**, con 32 dueños y esperas aleatorias inyectadas; ningún stock negativo.
- **I-B** `motor-buzones`: enviados = aplicados + devueltos + depositados + reenviados; ninguna garantía con más de 2 ticks.
- **I-R** `motor-referencias`: ningún `Ref` caducado se resuelve; cada vivo en un solo heap y con un dueño; Σ listas = vivos; índice uid→slot coherente.
- **I-N** `motor-nacimientos`: ningún uid repetido; ≤ 1 gestación por nonce; cada parto tiene su gestación.
- **I-F** `motor-frente`: CRC del frente leído igual al principio y al final del tick; `escritoPor[s] = dueno[s]`.
- **I-K** `motor-fallos`: matar un worker, lanzar en un dueño o matar la GPU en cada fase. GPU: el mismo tick sigue sin pérdida. Worker: recarga del último guardado y época nueva, nunca épocas a medias.
- **I-V** `motor-fotograma`: un tick por fotograma, sucesos contiguos, `saltados` contabilizados.
- **I-E** equivalencia (laboratorio): 4 semillas × 3 réplicas con 1, 8 y 32 hilos y 32 + GPU. Permutación sobre población, nacimientos, muertes por causa, hambre media, reparto de acciones y tasa de rechazos; α = 0,01/8, margen ±20 %.
- **I-S** frontera y arbitraje: interacción a ≤ 2 celdas de un borde entre dueños frente al interior con razón en [0,9, 1,1]; dueños de 1 chunk frente a 4 chunks; victorias en disputas uniformes por hilo (χ²).

## 8. Cómo se ve en pantalla

La pieza entrega los datos y la UI de v24 los integra.
- **Panel «Motor»:** días por minuto y Hz, distancia entre lo que se mira y el presente, 32 barras de ocupación, ms y estado de cada GPU (`ok`/`cpu`), fase dominante y fotogramas saltados.
- **Capa «Hilos»:** cada chunk teñido según su dueño y las migraciones como destellos; sale de `Fotograma.reparto`, así que también se ve sobre lo grabado.
- **Recibos causales en el inspector** (sucesos de baja importancia, muestreados): «intentó recoger; otro llegó antes».

## 9. Riesgos y mitigaciones

1. **E3 es grande** (unas 25 escrituras cruzadas y estado de módulo). Mitigación: M0 primero, tipos `Col` y modo `T=1`, donde M5 y las otras piezas ya prueban los intentos.
2. **Un hilo rezagado o un chunk caro frena la barrera.** Mitigación: F2 por reclamo dinámico, rebalanceo por tiempo de pared y `hilos:'auto'`.
3. **La latencia de un tick cambia la conducta** (comer de un chunk vecino, cazar, criar). Mitigación: es uniforme por chunk; se calibra en el panel.
4. **La pausa de `instantanea()` crece con la población.** Mitigación: los dueños serializan en paralelo; más adelante, el `Store` escribiría partes por dueño.
5. **Depurar sin reproducir.** Mitigación: modo `verificar` en pruebas y panel, registro de rechazos, caja negra de la pieza de poda y la cinta.
6. **La materia rompe el presupuesto por celda.** Mitigación: requisito de §3.9, medido en el banco integrado antes de E5.
7. **Choque con el equipo de grabación en `sim-worker.ts`.** Mitigación: M6 empieza cuando lo suelten; hasta entonces sigue la fachada `stepWorld`.

## 10. Consecuencias y decisiones para el orquestador

**Consecuencias que Steven debe conocer:**
- Ningún fallo se puede volver a ejecutar; el laboratorio pasa a ser solo estadístico.
- Nace una ley explícita: **toda acción sobre otro organismo o sobre una celda de otro chunk llega al tick siguiente, y cada cual ve a los demás un tick atrás.**
- Con la población de hoy, 32 hilos y GPU ganan poco y la GPU resta. La mejora grande de V23 sale de quitar la proyección y la clonación por tick (fotograma binario), no del paralelismo.
- Sin prioridad propia, con la torre cargada el presente avanza más despacio. Las réplicas del panel corren como `node` (en `SCHED_IDLE` por ananicy) y el público no: para competir de igual a igual, el panel debe lanzarse con el mismo nombre de proceso.
- Una caída devuelve el mundo al último guardado: a 300 Hz, con guardado cada 30 s, son ≈ 3,7 días de mundo que la cinta conserva como época huérfana.
- Desaparece el espejo vivo: `/api/world` y el inspector leen lo grabado o `Motor.detalle()` (decisión 1).
- Se borra el modo de más de 16 M celdas en varias GPU; por encima de la VRAM el mundo sigue, en CPU.

**Decisiones que quedan:**
1. Cadencia de guardado: por reloj (30 s) o por ticks. Es la pausa frente a cuánto mundo se pierde en una caída.
2. Política de decisión en GPU: `'siempre'` (la decisión 3 al pie de la letra) o `'medido'`.
3. Borrar el gobernador (`server/governor.ts`) y dejar solo una guarda de RAM que guarda y para.
4. Motor antes que leyes (control estadístico con `v24-base`) o todo a la vez.
5. Una sola tabla para personas y fauna, a acordar con las piezas de materia y leyes, que registran las columnas `forma` y `disposicion` (decisión 9).
