# Arquitectura única de materia (V23)

Base: `v24-base` (`849a895`); todas las rutas son relativas a ese árbol.

**Origen de las piezas.** La estructura viene de **materia-gpt**: capas estructura → forma → inventario → confirmación, y durabilidad desde el principio.

- La sustituye en la representación química la de **materia-fable**, corregida con la distinción entre molécula y unidad. Es la única con un prototipo que funcionó.
- De **materia-opus** tomo las tres leyes de uso y los fenómenos de calibración.
- De **leyes-opus**, las leyes sin topes, corrigiendo sus balances.

Contrasté con el código lo dudoso. Hechos comprobados:

- `MAX_FORMULAS` es 512, no 256 (`world/chemistry.ts:41`).
- El nacimiento crea reserva (`index.ts:2342`).
- La arena reasigna al crecer (`soa/arena.ts:56`).
- El guardado resimula con `stepWorld` (`server/store.ts:1622`).
- Node 22.23.3 admite `SharedArrayBuffer` crecible de 64 GiB con arrays que siguen su longitud. Lo probé en memoria.

## 1) Idea central

1. Todo es un **lote**: cuantos enteros de **sustancias**. Una sustancia es una unidad de fórmula de ≤ 8 átomos con enlaces que cumplen las valencias. Su identidad es su vector de enlaces y no hay catálogo.
2. Una sustancia es **molécula** si puede existir sola como grafo conexo (agua, CO₂, O₂, NH₃). Si no, es **unidad de red**: madera, sílice, hierro, hueso. Lo grande (un árbol, una roca, un cuerpo) son muchos cuantos de unidades.
3. **Una sola química**: cada par de sustancias que coincide en un lote reacciona hacia el reparto de menor energía libre con los mismos átomos. Se calcula una vez, se memoriza y se aplica con tasa de Arrhenius y redondeo estocástico entero.
4. **Tres leyes de uso** sirven para todo: romper, fluir y copiar. Hambre, sed, energía, fertilidad y servicios de obra son vistas de los lotes.
5. **Toda transacción material tiene un solo dueño.** Entre dueños solo hay traslados en depósito con nonce. Átomos y energía se conservan exactos en enteros, y el guardado es un punto de control binario sin resimulación.

## 2) Modelo de datos

**Elementos (8): H C N O P Si Ca Fe.**

- Sale S. Entran O, N y P: sin O no hay agua, aire ni fuego, y N y P son los nutrientes escasos reales (Liebig, proteína, hueso).
- La tabla es la única constante química: 8 × 5 valores (valencia v, χ, D propia, π, masa).
- Valencias: H1 C4 N3 O2 P5 Si4 Ca2 Fe3.
- Tipos de enlace (e ≤ f, orden k), derivados: k > 1 solo si π_e·π_f > 0, y k ≤ min(v_e, v_f, 3). Salen unos 52.
- Energía: `D = (D_e+D_f)/2 + 96,5·(χ_e−χ_f)² + (k−1)·√(π_e·π_f)` (Pauling), en J enteros por cuanto.

**Sustancia.** Es un vector b de enlaces saturado: n_e = Σ usos/v_e es entero, con Σn ≤ 8.

- `realizable(b)` es cierto si: no hay Ca ni Fe (los metales forman red); no hay enlace con Δχ ≥ 1,7 (iónico); E ≥ N−1; y cada par de elementos tiene ≤ n_e·n_f enlaces (o n_e(n_e−1)/2 si es el mismo elemento).
- Si `realizable(b)`, es **Molécula**; si no, **Unidad**.
- Ejemplos: etano {C–C:1, C–H:6} es molécula; {C–C:1, C–H:2} no es realizable (un solo C), así que es unidad de polietileno. Sílice {Si–O:4}, hierro {Fe–Fe:3}, CaCO₃ y CaHPO₄ son unidades. H₃PO₄ (8 átomos) y HNO₃ son moléculas.

**Lote** (arena `src/world/materia/arena.ts`, un único `SharedArrayBuffer` crecible y columnas SoA):

| Columna | Tipo | Por lote |
|---|---|---|
| `esp` | Uint32 × 8 ranuras | 32 B |
| `cant` | Float64 × 8 (valor entero ≤ 2⁵³) | 64 B |
| `calor` | Float64 entero, en J | 8 B |
| `desborde` | Int32 (lista de la página, sin pérdida) | 4 B |
| `rol`, `activo` | Uint8 | 2 B |
| `forma`, `gen` | Uint32 | 8 B |

Son 118 B, 120 alineados. Ocho ranuras es una resolución, no un tope: lo demás va al desborde.

Crecer = `sab.grow()` en barrera. Los arrays siguen su longitud, así que ningún worker queda con buffers abandonados. Una ranura liberada solo se reutiliza en barrera y con `gen++`.

**Dónde viven los lotes:**

- Tesela: 3 lotes (Suelo, Agua, Vida) y un `plantilla` u32 (la vegetación dominante).
- Roca: latente. `materiaInicial(seed, x, y)` la materializa al extraerla y lo anota como frontera.
- Aire: 1 lote por página de 16×16.
- Cuerpo: Tejido, Reserva y Digestivo, más Embrión si hay gestación.
- Objetos, cadáveres y piezas de obra: lotes con `Forma`, en una lista CSR por página.

**Unidades:** 1 cuanto = 1 mmol de unidades de fórmula, y energía en J. `T = calor/(0,025·átomos)`, que es Dulong–Petit: 25 J/(mol·K) por átomo.

### Contratos a congelar

Dos ficheros, `src/shared/materia.ts` y `src/world/materia/tipos.ts`, se commitean antes de repartir:

```ts
export const ELEMENTOS = ['H','C','N','O','P','Si','Ca','Fe'] as const; export const NE = 8;
export interface ConstantesElemento { valencia: number; chi: number; dPropia: number; pi: number; masa: number }
export declare const TABLA: readonly ConstantesElemento[];                 // src/shared/naturaleza.ts, calibrada en E0
export interface TipoEnlace { e: number; f: number; k: 1|2|3; d: number }  // d: J por cuanto, entero
export declare const TIPOS: readonly TipoEnlace[];                         // derivado de TABLA
export const ATOMOS_POR_UNIDAD = 8;          // resolución de representación (no tope de materia)
export type SustanciaId = number;            // u32 > 0, append-only, nunca reutilizado
export const enum Clase { Molecula = 1, Unidad = 2 }
export interface Propiedades { r: number; dMedia: number; tFusion: number; tEbullicion: number; qOxidacion: number;
  dureza: number; tenacidad: number; flexibilidad: number; polaridad: number; densidad: number; color: number }
export interface Sustancia { id: SustanciaId; clase: Clase; enlaces: Uint16Array /*[tipo,cuenta] ordenado = clave*/;
  atomos: Uint8Array /*NE*/; masa: number; energia: number /*−Σd·b, entero*/; prop: Propiedades }
export interface Reaccion { a: SustanciaId; b: SustanciaId /*0 = sola*/; nivelT: number;
  productos: readonly { id: SustanciaId; nu: number }[]; dH: number; ea: number; clase: 0|1|2 /*catálisis*/ }
export type LoteRef = number;
export const enum Rol { Suelo, Agua, Vida, Aire, Roca, Tejido, Reserva, Digestivo, Embrion, Objeto, Cadaver, Pieza }
export interface Forma { largo: number; ancho: number; grueso: number; hueco: number; filo: number }
export interface VistaLote { masa: number; T: number; fase: 0|1|2|3; dureza: number; tenacidad: number; sellado: number;
  aislamiento: number; energia: number; digerible: number; agua: number; color: number }
export interface Traslado { de: LoteRef; a: LoteRef; esp: SustanciaId; cuantos: number }   // mismo dueño
export const enum Intento { Tomar = 1, Dar, Golpear, Devolver }
export interface IntentoMateria { nonce: number; tipo: Intento; de: LoteRef; a: LoteRef; esp: SustanciaId | 0;
  parte: 0|1|2 /*exacta|digerible(κ)|agua*/; cuantos: number; dano?: number; vence: number }
export interface Libro { atomos: Float64Array /*NE*/; energia: number; enVuelo: Float64Array; fuentes: Float64Array /*NE+1*/ }
export interface Ecuacion { entradas: readonly { id: SustanciaId; nu: number }[]; salidas: readonly { id: SustanciaId; nu: number }[]; dH: number }
export interface Plantilla { id: number; partes: readonly { id: SustanciaId; fraccion: number }[]; sintesis: Ecuacion;
  kappa: readonly [number, number, number] /*C–O, C–N, C–C/C–H*/; captura: number; masaAdulta: number; m0: number; linaje: number }
export interface Cuerpo { tejido: LoteRef; reserva: LoteRef; digestivo: LoteRef; plantilla: number;
  gestacion?: { embrion: LoteRef; otro: string; inicio: number; bajoBasalDesde: number } }
export interface VistaCuerpo { hambre: number; sed: number; energia: number; salud: number; masa: number; carga: number; T: number }
export type Operacion = 'romper' | 'unir' | 'calentar' | 'mojar';
export interface Paso { op: Operacion; patron?: keyof Forma; hasta: { T?: number; ticks?: number } }
export interface ProcesoMaterial { lote: LoteRef; pasos: readonly Paso[]; i: number; desde: number; x: number; y: number }
export interface MateriaCheckpoint { epoca: number; tick: number; sustancias: Uint8Array; plantillas: Uint8Array;
  paginas: Uint8Array; enVuelo: Uint8Array; libro: Libro }
export interface ServicioQuimico { internar(b: Uint16Array): SustanciaId; sustancia(id: SustanciaId): Readonly<Sustancia>;
  reaccion(a: SustanciaId, b: SustanciaId, nivelT: number): Reaccion | null | undefined /*undefined = encolada*/ }
export interface ArenaMateria { nuevo(rol: Rol, pagina: number): LoteRef; liberar(l: LoteRef): void /*solo en barrera*/;
  cuantos(l: LoteRef, id: SustanciaId): number; mover(t: Traslado): number /*recorta, devuelve lo movido*/;
  moverCalor(de: LoteRef, a: LoteRef, j: number): number; vista(l: LoteRef): VistaLote; pedir(i: IntentoMateria): void }
```

Cambios de tipo para las leyes:

- `Person.cuerpo: Cuerpo`.
- `bonds: Record<string, {v: number; t: number}>`.
- `GENE_COUNT = 8`: el locus 8 es «escucha».
- `knownRecipes: {id, fuerza, ultimoUso}[]`.
- `Animal.cuerpo: Cuerpo`, y `species` pasa a `linajeFundador`.

## 3) Algoritmos y leyes

### 3.1 Química (`quimica.ts`, servicio de un solo escritor en su propio worker)

```
productos(A, B, ℓ):                                  // memo (A, B, ℓ); ℓ = 16 niveles log de T
  n ← átomos(A) + átomos(B)                          // ≤ 16 átomos
  para b en saturados(n) (ramificación y poda por energía):
    P ← reparto de b en sustancias de ≤ 8 átomos, cada una Molécula si realizable o Unidad
        (criterio: más moléculas gaseosas a T_ℓ; empate → menos especies; los reactivos intactos ganan empates)
    G ← −Σ D·b − T_ℓ·s·#gas(P)
  si min G < G(A)+G(B) − ε: devolver (P, dH = E(P)−E(A)−E(B), ea = γ·max D de los tipos que disminuyen,
                                       clase de catálisis = familia del enlace roto más fuerte)
```

Los fallos de memo se encolan y el resultado se publica en la barrera siguiente: la reacción ocurre un paso después, y nada se crea ni se pierde. El registro solo crece y solo lo escribe este servicio. Los productos quedan internados antes de que exista su fila, así que no hay carreras ni desalojos.

Paso de un lote (`paso.ts`, en CPU y en CUDA, con la misma semántica):

```
pasoLote(l, dt):   T ← calor/(0,025·átomos);  V ← Σ cant·vMolar(fase);  κ ← kappa del rol/plantilla
  para cada par (i ≤ j) de sustancias presentes, más (i, ∅):
    r ← REAC(i, j, ℓ);  si no hay r: seguir
    x ← ν·exp(−max(0, r.ea − κ[r.clase])/(R·T))·cant_i·cant_j/V·dt    // (i, ∅): ν·e^…·cant_i·dt
    si x > ½·min(cant_i, cant_j): partir dt
    ξ ← ⌊x⌋ + (u < x − ⌊x⌋)                                       // insesgado, 1 uniforme, sin Poisson
    ξ ← min(ξ, cant_i, cant_j, r.dH > 0 ? ⌊calor/r.dH⌋ : ∞)           // nunca negativos, nunca calor < 0
    cant_i −= ξ; cant_j −= ξ; productos += ξ·nu; calor −= ξ·r.dH
```

La tasa depende de cant/V, así que dividir un lote en dos no cambia la tasa total.

**Enmiendas de la integración (sprint/v23l-materia, 2026-11-24).** El contrato vigente está en `world/materia/tipos.ts` (`Reaccion`, `barreraEfectiva`, `nivelDeLote`) y en `shared/naturaleza.ts`. Lo que cambia del pseudocódigo de arriba:

- **Enmienda 1.** Q elige los coeficientes enteros (p, q), con 16 átomos como máximo por reacción. La familia catalítica es la del enlace catalizable **más débil** que disminuye, no la del más fuerte. La barrera era max(0, ea − κ, dH).
- **Enmienda 2** (validación independiente de los ciclos, `archivo/v23-orquesta/fin/`):
  - **Solo se catalizan exotérmicas.** b = max(0, ea − κ[familia]) si dH ≤ 0; b = ea (≥ dH) si dH > 0 o no hay familia. A ~295 K, una endotérmica solo es espontánea por la entropía del gas que suelta, unos 53 J por molécula. Catalizada era una fuente de H₂ sin retorno en el suelo: CH₂ → H₂ + C y 2 madera → 2 H₂ + C + CO₂.
  - **H–H tiene familia propia (3).** `Kappa` pasa a tener 4 entradas: C–O, C–N, C–C/C–H y H–H. El suelo usa [KAPPA_SUELO ×3, KAPPA_SUELO_HH = 175], así que 2 H₂ + O₂ → 2 H₂O va sin barrera en un suelo con O₂.
  - **Piso de nivel en lotes catalizados.** Un lote con algún κ > 0 elige productos al menos en el nivel `NIVEL_CATALIZADO` = 2 (282,84 K), aunque esté más frío; la tasa sigue usando su T real. El nivel 1 se calcula a 259,4 K, y ahí el NH₃ del modelo (que hierve a 273,6 K) no es gas, así que el suelo frío producía HCN, un sumidero absorbente.
  - **`copiar` mueve cada entrada y cada subproducto con su parte del calor** (`moverParte`, parte exacta).
  - **Medidas** en la caja cerrada (`tests/materia-caja.test.ts`, `tests/lib/caja-cerrada.ts`). Con 100 veces más aire por poro y sin herbívoro, el H₂ queda en el 0,06 % del H, frente al 96,8 % con la caja seca de antes. El suelo a 275 K y las estaciones cierran.
- **Enmienda 3** («química de principios»: filas 7 y 8 de la tabla de cordura y sumidero de HCN):
  - **Energía de dos centros de los metales** (`ConstantesElemento.dDosCentros`). Un enlace entre elementos distintos usa la media de las energías de dos centros; uno homonuclear sigue usando `dPropia`. En un metal, `dPropia` es cohesión de banda y solo existe entre átomos del metal, como E_red solo existe entre iones; su energía de dos centros es la D₀ del dímero: Fe 110 (Fe₂, 1,14 eV) y Ca 13 (Ca₂). En los no metales dDosCentros = dPropia y nada cambia. Con la cohesión en todo enlace, Pauling (solo suma k·96,5·Δχ² ≥ 0) daba ΔHf ≤ 0 a todo compuesto metal–no metal: C₃Fe₄ salía de 2 Fe₂ + 3 C con −186 (el Fe₃C real es +25) y el carburo ganaba ya en la fogata. Ahora C₃Fe₄ queda en +438, Fe–C = 274 y Fe–O = 367 con χ(Fe) = 1,86 (Pauling 1,83).
  - **Hierro.** 3 C + 2 Fe₂O₃ → 3 CO₂ + 2 Fe₂ tiene dH = 12·D(Fe–O) − 3.792 = 612 y suelta 3 gases, así que reduce desde T = 612/(3·0,18) = 1.133 K, dentro del nivel 10 (horno, desde 1.131 K) y no en el 9 (1.037,5 K). Ventana entera: D(Fe–O) ∈ [363, 371], es decir 1.037,5 < (12·D − 3.792)/0,54 ≤ 1.233,8; medida igual en el barrido: χ(Fe) ∈ [1,845, 1,870] con dDosCentros 110, y dDosCentros(Fe) ∈ [102, 119] con χ 1,86. El carburo (6 C + 2 Fe₂O₃ → 3 CO₂ + C₃Fe₄, también 3 gases) gana a la reducción exactamente cuando 12·D(C–C) − 12·D(Fe–C) < 6·D(C–C) − 6·D(Fe–Fe), es decir D(Fe–C) > (D(C–C) + D(Fe–Fe))/2 = 310,5, sea cual sea D(Fe–O). Con la cohesión en todos los enlaces, D(Fe–C) = 310,5 + 96,5·(2,55 − χ)² ≥ 310,5 (redondea a ≥ 311) para todo χ: ninguna constante arregla la fila, porque Pauling hace todo enlace mixto al menos tan fuerte como la media de los homonucleares. Con dDosCentros, D(Fe–C) − 310,5 = 96,5·(2,55 − χ)² − (275 − dDosCentros)/2: con 110 y 1,86, 274 (36 de margen). Sobre la recta D(Fe–O) = 367 la fila pasa con χ ∈ [1,75, 2,07] (dDosCentros 41–229); a 1,70 gana otra unidad (CO₃Fe₂, dH −3) en la fogata, y desde 2,08 (D(Fe–C) = 312) el carburo vuelve en el horno. El desplazamiento de Ca–O se anula en toda reacción entre compuestos de Ca (dos Ca–O por Ca a ambos lados): la tabla pasa entera con dDosCentros(Ca) en [0, 178]; 13 es la D₀ física.
  - **Regla del átomo lineal** (`realizable`). Un átomo con dos vecinos σ del núcleo, valencia ≥ 4 y sin H (dos π o más, ningún par libre: el C de un aleno, de un alquino o del CO₂, o un P con tres π) es lineal por VSEPR y no cabe en un anillo de ≤ 8 átomos (el menor aislable con uno es el ciclooctino, C₈H₁₂; los ciclo[n]carbonos, desde n ≈ 10). Se comprueba en la hoja del DFS de `realizable`: si los dos vecinos de ese átomo se alcanzan sin pasar por él, esa realización se descarta y se sigue buscando. Solo vuelve más estricta la realizabilidad, así que las cotas del solver siguen siendo válidas; el oráculo de fuerza bruta usa la misma `construirSustancia`. Mata C₃{C=C:3} (tres C sp en triángulo, sin tensión en el modelo: dH +240 contra T·ΔS 264 en el nivel 11, sublimaba del carbón en el horno) y todo anillo de C puro de ≤ 8 átomos; butatrieno, aleno, ceteno, carbodiimida, CO₂ y HCN siguen siendo moléculas. Enumeración de los vectores saturados y conexos de ≤ 8 átomos: solo C, 110 vectores, 17 pasan de molécula a red y queda ninguna molécula de C puro; H, C, N y O, 26.169 vectores, 1.715 cambios, todos de molécula a red y todos con un átomo lineal en un anillo.
  - **Catálisis por pares** (`Reaccion.paresCatalisis`, `barreraEfectiva`). La familia es la del enlace catalizable que disminuye con el **par** de electrones más débil (D/k; (D_k − D_k′)/(k − k′) si solo baja a orden k′), y la rebaja es κ por cada par que abre: b = max(0, ea − κ[familia]·pares) en una exotérmica. Un catalizador abre un múltiple par a par (como la hidratasa del cianuro con el C≡N). En los enlaces simples coincide con la enmienda 1 (1 par). El HCN que deja un fuego pobre en O₂ tenía ea = γ·D(C≡N) = 311,8 contra κ = 105 (k(295 K) ≈ 2·10⁻²⁸, el 46,8 % del C acumulado); con 3·105 = 315 ≥ 311,8 el suelo con O₂ lo oxida sin barrera, 3 O₂ + 3 HCN → NH₃ + 3 CO₂ + N₂ (el mínimo global en 16 átomos: un tercio del N vuelve como NH₃, dos tercios van a N₂, como en el fuego). En el tubo, 311,8 − 3·60 = 131,8: no se digiere. La hidrólisis no era salida: 2 HCN + 2 H₂O → 2 NH₃ + C + CO₂ es endotérmica (+18) en el modelo, y la enmienda 2 no cataliza endotérmicas. Alcance medido en el cierre de 100 sustancias a los niveles 2 y 9: de 5.892 reacciones (suelo y tubo) cambia la barrera de 590, todas a la baja y todas con un C≡N, C=N o C=O que se abre; las que pasan a rápidas en el suelo son oxidaciones del HCN, del HCNO y de unidades con C=N, y reducciones del CO₂ por hierro u orgánicos fosforados (CO₂ + 2 Fe₂O₂ → C + 2 Fe₂O₃, acotadas por el reductor y devueltas por C + O₂ en el suelo).
  - **Laboratorio** (`scripts/lab-materia.mts`). Fila 7: no reduce en fogata ni llama abierta, en horno da un metal (≥ la mitad de sus enlaces Fe–Fe) más duro y tenaz que la sílice, Fe₂O₂ + C → Fe₂ + CO₂ y ningún carburo de los niveles 8 a 11. Fila 8: SiO₂ y carbón estables en los niveles 10–15 y HCN + O₂ en el suelo con k > 10⁻². `--cajas` corre la batería de 74 cajas de la validación (`tests/lib/caja-param.ts`) con sus umbrales (`UMBRALES_CAJA`) y la expectativa de cada una.
  - **Cajas** (`npx tsx scripts/lab-materia.mts --cajas`, 2026-11-24 23:35, carga 77–97, 16 en paralelo: 1.022 s de pared, 33.180 recambios). 74 de 74 como se esperaba: 48 cierran, 7 controles (hallazgo 2: plantillas que solo toman NH₃ o H₃PO₄, y el fango sellado), 2 defectos abiertos y 17 contrafactuales de la validación que solo se miden. Frente a 703c6ef, en las 22 cajas corridas en los dos: 16 idénticas al cuanto y las 6 con fuego solo cambian en el HCN residual (0,01–0,04 % del C → 0,00) y en la biomasa final: ≤ 0,1 % en las tres que viven; en los tres controles que caen por el hallazgo 2, fuego-400 533 → 344, estricta-fuego-400 175 → 171 y repro40f 48.176 → 47.560 (−1,3 %). Ningún sumidero nuevo (el único, O₅P₂ en repro40f, es el hallazgo 2).
    - **HCN.** Fuego cada 2 recambios con la mitad del O₂: a 40 recambios, HCN 0,09 % del C (máx 0,25 %) frente a 4,6 % y subiendo en 703c6ef; a 400, 0,09 % (máx 0,25 %) frente a 46,7 % y subiendo en 703c6ef (la validación midió 46,8 %), donde el fuego fijaba el N₂ del aire en HCN (N fuera del N₂ ×5,03) y el H del HCN contaba como agua perdida (97,1 % frente a 99,5 %); la biomasa mínima pasa del 73 % al 80 %. Coste: dos tercios del N del HCN salen como N₂ (N fijado ×0,263; en 703c6ef quedaba en el HCN, inaccesible para las plantillas que solo toman NH₃), que las plantillas que fijan N₂ recuperan (biomasa mínima 80 %). El pulso de H₂ de ese fuego (0,51 % del H, igual en 703c6ef) es gas de síntesis de verdad y el suelo lo baja al 0,18 %: ahí el techo de H₂ se mira al final (`h2Pulso`).
    - **Agua.** Se mide como agua no perdida: 1 − (H que pasó a H₂ o a una sustancia que nadie espera) / (H del agua inicial). En las cajas secas el H₂O baja porque la planta crece con un depósito pequeño (muyseca: 43 % del H₂O inicial) y el H está en el tejido: agua no perdida 100 %.
    - **Defectos abiertos, anteriores a la enmienda 3 (idénticos en 703c6ef).** (1) Glicósido en suelo denso (`denso-sinherb-glic-600`): H₂ 15,4 % del H y agua no perdida 84 %. El glicósido {C–O:2, C–H:2} es un poliacetal (–CH₂–O–); en el suelo fermenta, 2 glic → 2 H₂ + C + CO₂ (dH −78; en el polioximetileno real, −39,5 kJ: también exotérmica). Es bimolecular (k·n²/V, `pasoLote`): con poros ÷100 va a 261 veces/tick (la deshidratación unimolecular, a 277) y con poros normales a 13,4 (frente a 772), así que produce ~522 H₂/tick contra 28,5. El suelo oxida casi todo su H₂ en cada tick (2 H₂ + O₂ sin barrera: 515 de 525 por tick, vida ≈ 1 tick, y ningún κ lo acelera), pero en sus poros solo está la fracción 1/(1 + V_aire/V_suelo) del gas: la meseta es ≈ producción × vida × (1 + V_aire/V_suelo) = 522 × 1,02 × 1.001 ≈ 533.000 H₂ (medido 525.730); con poros normales, 28,5 × 1,05 × 11 ≈ 330 (medido 316, el 0,009 %). Cifras de flujos de la corrida del auditor sobre la enmienda 2, cuyo H₂ final coincide con el de hoy al cuanto. No es una constante de la química: lo arreglaría que el H₂ que nace en un tick se oxide en el mismo paso antes de que `fluir` lo saque al aire (en un suelo real lo consumen en el mismo micrositio), o un orden cinético de primer orden para la reacción de una unidad de red consigo misma; las dos son del carril P, no de esta enmienda. (2) `auditoria-400`: aire con 400 cuantos de CO₂; la hojarasca pasa por carbón (madera → H₂O + C, rápida) y el carbón vuelve despacio (C + O₂, k(295 K) = 9,5·10⁻⁴ L/(cuanto·tick)), así que en estado estacionario retiene el 24 % del C (el CaCO₃ inicial, otro 55 %) y la planta, sin CO₂ libre, baja al 39 %.
    - **Prueba.** El subconjunto rápido (`tests/materia-caja-bateria.test.ts`, cuatro cajas de 40 recambios con su control cada una: HCN, H₂ y agua, N a N₂ con fuego, P bloqueado) va en su propio fichero: junto a la caja de 400 recambios con fuego de `materia-caja.test.ts` pasaba de los 600 s de `--test-timeout` por fichero con la torre cargada.

- **Cadencia:** los lotes con T > ambiente + 5 K, los cuerpos y los tocados en el paso corren en cada tick. Los quietos corren cada 10 ticks con dt = 10, la misma cadencia que la ecología de hoy, y la esperanza no cambia.
- **Propiedades por sustancia**, de la estructura (Fable P5):
  - r es la coordinación media del núcleo, sin átomos de valencia 1.
  - Dureza = (D̄/D_máx)·clamp((r−2,4)/1,6) (umbral de Maxwell).
  - Tenacidad = máxima cerca de r = 2,4, más la fracción metálica.
  - Fusión de una red: T_f = 2,9(r−1)D̄. Ebullición de una molécula: 15√M + 100·Σ(Δχ)² de sus enlaces con H.
  - Q = ΔH de la oxidación completa (Hess, exacta).
- **Propiedades del lote:** la mezcla es por percolación (la fase rígida endurece si supera 0,3 del volumen). El sellado es continuidad de la forma × (1 − fracción permeable). Aislamiento = 1 − conductancia de las fases.

### 3.2 Las tres leyes de uso (`leyes.ts`)

- **Romper** (A contra B, trabajo W):
  - P = W·(1+filo_A)·(1+tenacidad_A·largo_A/ancho_A); r = dureza_A/dureza_B.
  - Lo que se desprende de B es P·min(1, r²)/(tenacidad_B+ε). Sale como un lote nuevo con la misma química, más fino y con la forma del patrón.
  - A se desgasta en P·min(1, r⁻²)·(1−tenacidad_A).
  - Cubre talar, cavar, labrar, tallar, cazar, despiezar y moler.
- **Fluir** entre los compartimentos i y j a través de barreras s:
  - Materia: J = (μ_i·c_i − μ_j·c_j + g·Δh)·Π(1−sellado_s)·área·dt.
  - Calor: (T_i−T_j)·Π(1−aislamiento_s)·área·dt.
  - Cubre agua por pendiente, infiltración, evaporación con su calor latente, condensación al saturar el aire (lluvia), gases entre páginas, respiración, cocción, horno, vasija y techo.
  - El sol es una fuente declarada y la radiación un sumidero declarado.
- **Copiar** (`copiar.ts`):
  - Cada plantilla trae su `Ecuacion` balanceada al crearla (eliminación entera). Si no puede balancearse, el mutante no es viable.
  - Crecimiento: m = min(Liebig sobre las entradas accesibles, energía/dH, g·masa·dt).
  - La energía es luz·captura·(1−sombra) en las plantas. En animales y personas es la reserva quemada con O₂ por la misma tabla REAC.
  - Las salidas (O₂, H₂O) van al aire o al agua.
  - `quemar(cuerpo, W)` paga el trabajo de cualquier acción oxidando la reserva.

### 3.3 Cuerpos y leyes sin topes

- **Metabolismo.** La digestión es `pasoLote` del Digestivo con κ del genoma: herbívoro, carnívoro u omnívoro según qué enlaces rompe. Absorbe por fluir y excreta al Suelo.
  - Vistas para `choose`: hambre = 1 − Q_reserva/Q_objetivo; sed = 1 − agua_tejido/objetivo; energía = moléculas rápidas/objetivo; salud = tejido/plantilla.
  - La fatiga sigue siendo un escalar (`body.ts` `exertBody` y `restBody`).
  - Cargar no tiene tope: mover cuesta c·(masa + carga)·distancia y se paga con `quemar`.
- **Morir.** Los lotes del cuerpo pasan a ser un lote `Cadaver` en la celda, y la κ del suelo lo descompone. La senescencia de `demography.ts` se queda.
- **Gestación,** con un solo escritor: el dueño de la gestante.

```
fértil(g) = mortal ∧ edad ∈ [madurez, vejez) ∧ salud ≥ 0,55 ∧ sin gestación ∧ enfriamiento (gen)
            ∧ Q_reserva(g) ≥ m0·(Q_tejido + dH_síntesis)            // el cuerpo sabe si puede pagar
concebir(g): q ← mejor fértil de la FOTO pública a ≤ radioPareja, vínculo mutuo ≥ 0,3, ¬pariente
             g.gestacion ← {embrion: nuevo(Embrion), otro: q.id}; el genoma se hereda de g y q
gestar(g): copiar(embrion, plantilla(g), fuentes = reserva(g) + digestivo(g))    // átomos 1:1; la síntesis se paga quemando
  Q_reserva(g) < basal·1 día durante 1 día → aborto: unir(embrion → digestivo(g))  // los átomos vuelven
  masa(embrion) ≥ m0 → nace en la celda de g; el embrión pasa a ser el tejido de la cría
```

q solo aporta genoma (información), así que varias gestantes pueden elegirlo a la vez sin conflicto. Desaparecen el cupo, la ventana, el umbral de 0,08 y el gobernador.

- **Comunidades:**
  - El vínculo decae, v ← v·e^(−Δt/τ), y se borra por debajo de 0,01.
  - Comunidad = componente conexa (unión-búsqueda, en cada tick) de los vínculos mutuos ≥ 0,3 con ≥ 3 mortales.
  - La identidad pasa a la componente previa de mayor solapamiento si este es ≥ ½. Si no, es una comunidad nueva.
  - La fisión ocurre al cortarse el grafo y no hay oscilación: es función del grafo.
- **Fauna:** el mismo `Cuerpo` y la misma gestación pagada.
  - Todos deciden en cada tick, repartidos por el motor.
  - Sin tope por tesela: la densidad la acotan el alimento y el coste de moverse.
  - La edad máxima sale por alometría: L = L0·masa^0,25.
  - Presa elegida por rendimiento = Q digerible para su κ − persecución − riesgo. Desaparece `edible`.
- **Caza y ganadería** (`caza.ts`):
  - El miedo es cautela·(1−habituación)·amenaza por masa, más la alarma de la celda.
  - La habituación sube cerca de agentes grandes cuando la alarma es nula.
  - El daño se resuelve con romper.
  - La extracción no letal es un `Tomar` sobre la reserva o la fibra del animal; el dueño del animal la acepta si el miedo es menor que la reserva relativa.
  - La domesticación sale de la selección sobre la cautela.
- **Escucha:** P(oír) = escucha²·calma·audibilidad.
- **Recetas:** se olvidan por desuso, con un τ heredable de `learningRate`.

### 3.4 Concurrencia y durabilidad

- Cada lote tiene un dueño por época: el de su página u organismo, según el contrato del motor.
- Las reacciones nunca cruzan lotes. El oxidante llega antes por fluir, y aire y teselas de una página tienen el mismo dueño.
- **Entre dueños:** el origen descuenta al conceder y deja los cuantos en `enVuelo` con su nonce. El destino abona en la fase siguiente.
  - Si el destino ya no existe, los cuantos van al Suelo de su última celda (`Devolver`).
  - Un nonce repetido no tiene efecto.
- Unir varios lotes solo se hace con lotes propios: lo ajeno se toma antes. No hay transacción con varios dueños, ni esperas, ni interbloqueos.
- **Punto de control** en la barrera de la época E:
  1. vaciar las páginas de VRAM con sello E;
  2. serializar el depósito `enVuelo`;
  3. añadir las sustancias y plantillas nuevas;
  4. escribir las páginas binarias.
  - Al cargar se exige que todas las páginas lleven el sello E y que el libro sume lo guardado.
  - Si la GPU cae, se descarta la época y se vuelve al último punto. Nunca se sigue con un espejo atrasado.
  - La materia va fuera del `World` JSON: ni `clon.ts:77`, ni `bigint`, ni `exact-json.ts:121`.

### 3.5 Procesos técnicos (`proceso.ts`)

Sustituye la ejecución de una sola llamada de `finishProject` (`technology.ts:701-760`).

- Cada `Paso` se ejecuta en el mundo:
  - calentar = el lote en contacto con un fuego hasta T o durante n ticks;
  - mojar = en agua;
  - unir = juntar lotes;
  - romper con patrón = forma.
- Si se interrumpe, el lote intermedio queda en el sitio.
- La novedad se mide con `isGenuineFunctionalNovelty` (`tecnologia-complejidad.ts:124`) sobre el vector (propiedades del lote × forma).

### 3.6 Objeciones de la crítica

| Objeción | Resolución |
|---|---|
| Opus 1: NaN con N_e = 0; molécula y red indistinguibles | Sin Flory–Stockmayer. La clase sale de `realizable` y la fase de T_eb/T_f. |
| Opus 2: dividir cambia la tasa; calor negativo | Tasa ∝ cant_i·cant_j/V; ξ ≤ ⌊calor/dH⌋. |
| Opus 3: confirmación no transaccional; la arena abandona buffers | Un solo dueño, depósito con nonce; SAB crecible. |
| Opus 4: 222 M de Poisson; 12 GiB | Un uniforme por par activo, cadencia por lote; 360 B por tesela. |
| Opus 5 / GPT 4: recuperación y corte CPU–GPU | `MateriaCheckpoint` con sello de época; sin replay. |
| Fable 1: etano = metano + CH₂ | El etano es molécula realizable; la unidad CH₂ es otra clase con otra identidad. |
| Fable 2: 8 M claves | Memo perezoso solo de los pares que coinciden; ≤ 16 átomos por búsqueda; banco en E0. |
| Fable 3: u32 que se desborda | Float64 entero ≤ 2⁵³ y límite endotérmico. |
| Fable 4: carreras del registro | Un solo escritor, solo crece, nunca se desaloja. |
| Fable 5: `snapshot.ts:165` pierde inventarios | Codificador binario de páginas; la tesela V23 ya no guarda los escalares. |
| GPT 1: coste de `CanonicalGraph` | La clave es el vector de una unidad de ≤ 8 átomos, de coste O(tipos). |
| GPT 2: leyes sin ecuaciones | §3.1–3.3. |
| GPT 3: interbloqueo de propietarios | Sin bloqueos: reacciones dentro del lote y traslados de una sola dirección. |
| GPT 5: programa instantáneo | `ProcesoMaterial`. |
| Leyes 1: la gestación pierde masa | Traslado 1:1; la ineficiencia se paga quemando (sale CO₂ y H₂O). |
| Leyes 2: embarazos sobrescritos | Solo escribe el dueño de la gestante; la pareja aporta información. |
| Leyes 3: las etiquetas no se parten | Componentes conexas con identidad por solapamiento. |
| Leyes 4: huella inválida al crecer | Se elimina la huella. |
| Leyes 5: vínculos O(N²) | Decaen a 0 y se borran. |

## 4) Qué se borra y qué se conserva

| Se borra | Lo sustituye |
|---|---|
| `world/chemistry.ts` entero (977); `shared/chemistry.ts` entero (`geologyAt` :133) | `quimica.ts`; `materiaInicial` |
| `material-affordances.ts` (170) y `technology-water.ts` (381) enteros | fluir |
| `technology.ts:40-46` (6 capacidades, 8 operaciones, catalizadores), `:97` (`budgets`), `:135-162`, `:176-236` (`applyPhysicalOperation`), `:319-355` (`itemCapacities`, `bestTool`, `useTool`), la ejecución de `:701-760`; `shared/technology.ts:3-12`; `technology-catalogue.ts:24` (6⁶) y `:85` (32) | romper/fluir sobre lotes; `ProcesoMaterial`; olvido |
| `inventions.ts:20-21` (512/64), `:31-36` (`COMPONENTS`/`COSTS`) | piezas como lotes; servicios por fluir |
| `body.ts:21-69` (`advanceBody`, `assimilateFood`, `hydrateBody`) | vistas de `cuerpo.ts` |
| `index.ts:317-416` (ecología), `:1827-1866` (comer y beber escalares), `:1924-2004` (`HUNT_ORGANIC` … `tendNearbyAnimal`), `:2275-2293` (pérdidas), `:2295-2414` (`reproduce`, `fertile`, `ELECCION_POR_AFINIDAD`) | `mover`/`pedir`, `natalidad.ts`, `caza.ts` |
| `ecology-kernel.ts`, `ecologia-constantes.ts`, `ecosystem-kernel.ts:281-458`, `scripts/compute-ecology*` (8) | `paso.ts`, `materia.cu` |
| `ecosystem.ts:10,206,219`; `animals.ts:16-23,53,124-125,471,785-795,872-998` | átomos reales; sin especies en las reglas |
| `natalidad-local.ts` entero; `demography.ts:88-91` (umbrales escalares) | reserva pagada |
| `society.ts:604-621`, `:694-811` (48/64/96/40/32/360), `:813-895` (`% 120`, 0,3) | componentes |
| `server/governor.ts` entero; `app.ts:437-470,892` | nada: no hay freno de reloj |
| `whispers.ts:141-172` (cuando cierre el equipo de mensajes) | gen escucha |
| Los escalares de `Tile` (`shared/types.ts:27`) y `LAYOUT` (`soa/terreno.ts:40-50`) | vistas hasta E7; luego `Tile.mat` |

**Se conserva:**

- La búsqueda de programas: `proposeTechnologyProgram` :475, `advanceProject` :788 y `locallyUsefulDiscovery` :674.
- El reparto por mayores restos (`technology.ts:127`, generalizado a átomos), el archivo y los diarios.
- Los poliominós y la búsqueda de planos (`inventions.ts:111-153`, `:723-819`).
- `exertBody` y `restBody`; `genetics.ts`, con un locus más; regiones y páginas (`soa/region.ts`); los caminos (el empedrado pasa a ser piezas de piedra).

## 5) Migración por etapas

Cada etapa mantiene vivo un mundo de **laboratorio**. Se publica solo al final (V23, en un mundo nuevo).

| Etapa | Ficheros | Se da por buena si… |
|---|---|---|
| E0 Núcleo | C0, Q, A | Pasan I1–I7. La tabla de cordura da: agua líquida; madera que arde solo por encima del umbral; carbón por pirólisis; calor por masa madera < carbón < grasa; arcilla que endurece al cocer; cal que calcina y fragua; Fe desde la T de horno y no de fogata; planta frenada por el elemento escaso. Banco de `productos`: p99 < 50 ms con ≤ 16 átomos. |
| E1 Física | P, L, G | I5. Fenómenos en un mundo de 64×64. ms/lote en CPU con 1/28 hilos y en GPU. I8 entre P y G. |
| E2 Mundo material | W (+ S y R en paralelo) | Las vistas escriben los escalares de hoy, así que `choose` no cambia. Comer, beber y recolectar pasan a `mover` hacia un **sumidero declarado** (cuerpos aún escalares). 4 semillas × 3 réplicas × 10 días: mediana de población ≥ 0,8× el control, nacimientos cada día en ≥ 10/12 réplicas, ninguna extinta. Libro exacto con sumidero. |
| E3 Cuerpos y natalidad | B, N | Fuera el sumidero; libro exacto en cada tick. N1 de leyes-opus. |
| E4 Fauna y caza | F | F1 y H1; `grep` sin lecturas de especie. |
| E5 Tecnología y obra | T | Q1; procesos al día; A/B con y sin útil; cerámica, cal o metal en ≥ 2/4 semillas. |
| E6 Pantalla y escucha | V, E | Prueba de extremo a extremo por fenómeno; FPS sin regresión; W1. |
| E7 Poda y panel | I | Borrado de las vistas; `kill -9` → recuperación (I11); 4 × 3 × 30 días. |

**La demografía durante la migración:**

1. **Calibración por equivalencia de flujos.** En E2 los cuantos se escalan para que las vistas reproduzcan, ±20 %, el rebrote de comida a capacidad, el hambre por tick (0,00027) y el agua por trago de hoy. Se mide con las mismas semillas, sin cambiar todavía la conducta.
2. **Explosión imposible por física.** Nacer exige reserva pagada, y la reserva solo sale de la Vida, acotada por luz × Liebig. Nacimientos/día ≤ producción primaria accesible/(m0·(1+dH/Q)).
3. **Extinción vigilada.** Hay puertas en E2, E3 y E4: si fallan, la etapa no se integra (sin rescates en la ley). S e I son inmortales, como fuente declarada. Se mantienen el radio de cortejo y el aborto que devuelve los átomos.
4. Una regresión se ve solo con réplicas: 12 corridas por puerta.

## 6) Coste estimado (sin medir; E0/E1 lo miden)

| Recurso | Cálculo | Hoy (≈21 k teselas, ≈300 p, ≈650 a) | 1 M teselas | 16,7 M teselas |
|---|---|---|---|---|
| RAM de tesela | 3 lotes × 120 B + 8 | 7,7 MB | 370 MB | 6,2 GB |
| Cuerpos | 3 lotes | 0,3 MB | 40 MB (10 k p + 100 k a) | — |
| Registro / memo | 200 B / 64 B por fila | < 5 MB | 20 MB / 64 MB (10⁵ / 10⁶) | igual |
| Química por tick | lotes activos × ≤ 44 pares × ~35 ns | 1 hilo ≈ 9 ms; 28 hilos < 1 ms | 28 hilos ≈ 20 ms; GPU ≈ 1–2 ms | GPU ≈ 15–25 ms |
| Par nuevo | búsqueda ≤ 16 átomos | 0,1–50 ms, asíncrono | 10³–10⁵ en toda la vida | — |
| Punto de control | binario de las páginas sucias | < 8 MB | ≤ 370 MB | ≤ 6 GB, incremental |

El coste es lineal en lotes activos más pares nuevos. A la escala de hoy, CPU basta; la GPU compensa desde unos 10⁵ lotes activos y se elige midiendo. FP32 para las tasas, enteros para las cantidades.

## 7) Invariantes y pruebas que sustituyen a la paridad

- **I1** Átomos por elemento: Σ lotes + `enVuelo` = inicial + fuentes declaradas (frontera de chunks, S/I) − sumideros. Igualdad entera, en cada tick del laboratorio y cada 2.400 en producción.
- **I2** Energía química + calor = inicial + sol − radiación ± fuentes. Exacta en J enteros.
- **I3** `cant` y `calor` son enteros ≥ 0 y finitos.
- **I4** Toda sustancia es saturada, de ≤ 8 átomos y de clase coherente; toda fila de memo conserva átomos.
- **I5** Dividir un lote en dos mitades da la misma distribución de productos (KS, p > 0,01).
- **I6** La tabla de cordura (E0).
- **I7** Fuzz con 32 hilos y 10⁵ intentos con nonces repetidos y destinos muertos: enviados = abonados + devueltos.
- **I8** Equivalencia estadística entre 1 hilo, 28 hilos y GPU: prueba de permutación con Bonferroni.
- **I9** Sumideros de N, P, Ca y Fe sin camino de vuelta (alcanzabilidad en el memo) bajo un umbral a 30 días.
- **I10** Un `grep` falla si reaparecen los topes de la decisión 7 o lecturas de `species`.
- **I11** Recuperación tras `kill -9` sin resimular.
- Pruebas por ley: aborto que devuelve; sin reserva no se concibe; un grafo cortado se parte en dos comunidades; la presa rápida escapa; el animal habituado tolera la extracción.

## 8) Cómo se ve en pantalla

- **Tesela:** color mezclado de sus 3 sustancias superficiales, con agua y Vida encima. Las vetas salen de la composición real, no de `geologyAt` (`road-geology-art.ts:152`, `telemetry-hud.ts:255`).
- **Fenómenos:** fuego con color de cuerpo negro según T; humo proporcional al gas liberado; hornos y metal al rojo; pudrición que oscurece; cadáveres que se consumen; regiones que se secan.
- **Ficha:** barra de los 8 átomos, enlaces dominantes, fase, propiedades y nombre derivado (por ejemplo «red Si–O rígida»). En el cuerpo: reserva, agua, tejido, embrión y carga. También la barra de escucha.
- **Panel «Materia»:** reparto de cada elemento entre roca, suelo, agua, aire, vida, cuerpos y objetos a lo largo del tiempo (el ciclo), y sustancias aparecidas (quién, dónde y con qué proceso).
- **Otras capas:** el grafo de comunidades con fisiones; líneas de persecución; cautela cerca y lejos de las aldeas.
- **Cable:** `Tile.mat` (3 ids y fracciones) y `Tile.T`; `WorldView.sustancias` lleva solo las referenciadas. `PROTOCOL_VERSION` pasa a 11 (`types.ts:21`). En la cinta son +9 B por tesela en cada fotograma clave.

## 9) Riesgos y mitigaciones

1. **Calibración de 40 constantes más ν, γ, s y κ₀** (mundo estéril o que arde entero). La tabla de cordura es una puerta de E0.
2. **Colapso en E3.** Equivalencia de flujos y puertas de 12 réplicas; las vistas permiten volver atrás.
3. **Sumidero de nutrientes a semanas vista** (I9). El panel de 8 × 60 puede descubrirlo después de publicar.
4. **Coste de búsqueda o registro grande.** Banco en E0; el memo se puede desalojar en barrera.
5. **Incendios sin freno.** Los frena el calor latente del agua y el combustible es finito. Se mide la fracción quemada.
6. **Autoridad entre CPU y GPU.** Sello de época; ante un fallo se descarta y se recarga.
7. **Conflictos en `index.ts`.** Partición previa y un integrador.
8. **Aproximaciones:** los isómeros se funden y hay 8 átomos por unidad de fórmula.

## 10) Consecuencias y decisiones para el orquestador

**Consecuencias que Steven debe conocer:**

- La química es plausible, no real: isómeros y aductos son la misma sustancia; hay una valencia por elemento (no hay FeO ni Fe₃O₄); y lo de más de 8 átomos se representa como agregado de unidades.
- La población y la fauna las regula la materia. El equilibrio no se conoce antes del panel, y pueden desaparecer linajes («se perdieron los lobos»).
- La lluvia sale del vapor real: hay regiones que se secarán.
- Abrir chunks y la inmortalidad de S e I son fuentes declaradas.
- Siguen existiendo números de la naturaleza (en `naturaleza.ts`): la tabla, ν, γ, s, κ₀, τ y θ de los vínculos, y la alometría.
- V23 no tiene física de cargas en las obras: se degradan por química y desgaste.
- La memoria por tesela es unas 5 veces la de hoy.

**Decisiones abiertas:**

1. Confirmar los 8 elementos (sale S).
2. Confirmar la resolución de 8 átomos tras el banco de E0.
3. ¿Quién parte `index.ts`? Propongo el motor, antes de la ola 1.
4. El replay de `store.ts` y la integración de `MateriaCheckpoint` son del motor y de la cinta.
5. Qué plantillas fundadoras quedan: 6 linajes animales más una plantilla vegetal por bioma.
6. Si `reproductionEnabled` queda como pausa manual.

## Carriles

| Carril | Ficheros en propiedad exclusiva | Depende de | Dificultad | Cómo se verifica |
|---|---|---|---|---|
| C0 Contratos | `shared/materia.ts`, `shared/naturaleza.ts`, `world/materia/tipos.ts`, enmienda de `.specify/memory/constitution.md` | — | baja | typecheck; revisión de Opus |
| Q Química | `world/materia/{quimica,servicio}.ts`, `scripts/lab-materia.mts`, `tests/materia-quimica.test.ts` | C0 | extrema | I4, I6, banco de búsqueda |
| A Arena y libro | `world/materia/{arena,libro,checkpoint}.ts`, `tests/materia-arena.test.ts` | C0 | alta | I1, I3, I7; crecer con lectores; ida y vuelta |
| P Cinética y transporte | `world/materia/{paso,fluir,paso-worker}.ts` | C0 (Q y A por contrato) | alta | I2, I5; banco ms/lote |
| L Leyes de uso | `world/materia/{romper,copiar}.ts` (síntesis, `quemar`, balance de plantillas) | C0 | alta | pruebas por ley; Liebig |
| G Kernel GPU | `scripts/gpu/materia.cu`, `world/gpu/materia-gpu.ts` | C0; tablas de Q; disposición de A | alta | I1–I3 en GPU; I8 frente a P |
| W Mundo material | `world/materia/{mundo,vistas}.ts`; `ecosystem.ts`, `terrain.ts`, `forest.ts`, `agua.ts`; borra la ecología (§4) | Q, A, P, L | alta | puerta E2 |
| S Comunidades | `society.ts`, `lineage.ts`, `params.ts` (social) | C0 | media | C1 |
| R Reguladores de servidor | `server/governor.ts` (borrar), `server/app.ts:437-470,892`, `server/hardware-limits.ts` | — | baja | arranque y 1 h de humo |
| B Cuerpos | `world/materia/cuerpo.ts`, `body.ts`, `demography.ts` | W | extrema | causas de muerte frente al control |
| N Natalidad | `world/natalidad.ts`, borrar `natalidad-local.ts`, `params.ts` (poblacion), zona `reproduce` de `actuar/` | B (contrato, con un esbozo escalar mientras) | alta | N1 |
| F Fauna y caza | `animals.ts`, `world/caza.ts`, zonas de caza y cuidado de `actuar/` | B, L | alta | F1, H1, I10 |
| T Tecnología y obra | `technology*.ts`, `shared/technology.ts`, `tecnologia-complejidad.ts`, `inventions.ts`, `shared/life.ts`, `world/materia/proceso.ts`; borra `chemistry.ts` (ambos), `material-affordances.ts` y `technology-water.ts` | B, L, P | extrema | Q1; puerta E5 |
| E Escucha | `genetics.ts`, `whispers.ts` | cierre del equipo de mensajes | baja | W1 |
| V Pantalla | `client/{landscape,terrain-field,structure-art,telemetry-hud,inspector-view,road-geology-art}.ts` y el panel Materia, `world/proyeccion.ts`, `shared/types.ts` | C0; W (datos); cierre de la UI v24 | media | extremo a extremo; FPS |
| I Integrador | `world/index.ts` (o `decision/` y `actuar/` tras la partición) | todos | alta | typecheck, suite, puertas |

## Orden

1. **Paso 0, secuencial (≤ 1 día):** commit de C0 (contratos, naturaleza y enmienda de la constitución). El motor parte `index.ts` en `decision/` y `actuar/` sin cambiar la conducta.
2. **Ola 1, en paralelo:** Q, A, P, L, G (contra el contrato, con tablas de prueba), S, R; V con datos de prueba. E en cuanto cierre el equipo de mensajes.
3. **Ola 2:** W, cuando estén integrados Q, A, P y L. **Puerta E2.**
4. **Ola 3:** B; después N y F en paralelo (ficheros disjuntos). **Puerta demográfica** (N1, F1).
5. **Ola 4:** T; con ella, la caza de F que usa romper con útiles. **Puerta E5.**
6. **Ola 5:** poda (cada carril borra lo suyo; I retira las vistas y el sumidero), ensayo de recuperación y panel de 4 × 3 × 30 → V23. Después, el panel de 8 × 60.

Lo que debe esperar sí o sí: W espera al núcleo; B espera a W; N, F y T esperan a B. Todo lo demás corre en paralelo desde la ola 1.
