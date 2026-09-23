# Guía de arte — pixel-art procedural

> Dirección de arte elegida por Steven (2026-09-23): **pixel-art, eficiencia primero** (el
> renderizador sigue siendo procedural — canvas 2D con caché por chunk / WebGL2 según
> `src/client/gpu-terrain.ts` —, no sprites pintados a mano). Referencia visual:
> `/datos/tmp-atlas-lab/arte/estilos/estilo-A.png`. Auditoría «antes» y el caso de estudio de la
> zona del habitante 739 (borde bosque/humedal con campo cultivado y lago) en
> `/datos/tmp-atlas-lab/arte/antes/` y `/datos/tmp-atlas-lab/arte/b739/`.

## Diagnóstico que motiva esta guía

`src/client/landscape.ts` producía dos defectos legibles en la captura de la zona 739 («la mancha
marrón derretida» y «la orilla en escalera»):

1. **`groundMaterial` (suelo por tesela)** mezclaba RGB de forma continua según fertilidad y
   humedad (`mix(mineral, humus, fertility * .72)`, `mix(green, …, (1 - moisture) * .6)`): con 13
   niveles de fertilidad × 13 de humedad salían más de cien tonos de tierra casi indistinguibles,
   un degradado en vez de una paleta.
2. **`bakeTileBase` (horneado del suelo)** interpolaba bilinealmente **por píxel** entre los 4
   vecinos de celda (`wa*a + wb*b + wc*c + wd*d` canal a canal). Un blend bilineal continuo sobre
   colores ya casi-continuos es exactamente lo que produce un borrón: sin bordes, sin textura,
   «derretido».
3. **`bakeCoast` (orilla)** dibujaba franjas de arena con un ancho aleatorio por columna
   (`rnd(...) * 3`) sin ningún patrón: ruido en vez de un borde diseñado, lo que se lee como una
   orilla en escalera irregular en vez de una costa con intención.

La corrección (mismo commit que esta guía referencia en su historial) no es cosmética por encima:
cambia el mecanismo. Ya no hay una función continua de fertilidad/humedad a color; hay una paleta
fija y un patrón de tramado determinista para pasar de una tesela a otra.

## Paleta

Fuente de verdad: `src/client/paleta.ts` (constantes en hex, generadas y documentadas ahí; lámina
de muestra en `/datos/tmp-atlas-lab/arte/paleta.png`, fuera del repo por ser un artefacto de
trabajo). Se obtuvo cuantizando `estilo-A.png` y muestreando colores por **máxima distancia** (no
por frecuencia de píxeles), para que zonas pequeñas del cuadro de referencia (roca, espuma, piel,
ropa) no quedaran tapadas por el césped y el trigal, que dominan en superficie. 28 colores, sin
casi-duplicados (distancia euclidiana RGB ≥ 20 entre cualquier par), organizados por familia:
césped/pradera, bosque, humedal, desierto/arena, montaña/roca, agua (profunda / somera / espuma),
suelo trabajado (pisado / arado / cultivo), madera, paja, piel (varios tonos), ropa, sombra, luz.

**Regla:** el renderizador sólo pinta con estos colores, o con una mezcla discreta de dos de ellos
vía tramado. Ningún `mix()`/`lerp()` canal a canal a resolución de píxel, y ninguna interpolación
bilineal continua entre vecinos. Sombra y luz son universales: para oscurecer u iluminar un tono de
cualquier familia se trama contra `SOMBRA`/`LUZ`; no se fabrica una variante clara/oscura nueva por
familia (eso volvería a inflar la paleta hacia el degradado continuo del diagnóstico).

## Reglas de estilo

- **Tesela de arte: 16 px** (`ART` en `src/client/landscape.ts`). Todo elemento nuevo dibuja en esa
  cuadrícula; no hay medias-teselas ni offsets sub-píxel salvo donde ya existían por diseño (p. ej.
  el vaivén decorativo de sprites, que es una traslación de sprite completo, no un color mezclado).
- **Colores solo de la paleta.** Cualquier color nuevo se añade a `paleta.ts` con su familia y
  nombre; no se escriben literales `rgb()`/hex sueltos para terreno. Los sprites de figuras
  (`life-art.ts`) pueden seguir usando su paleta local histórica mientras se migran; lo nuevo que se
  toque va contra `paleta.ts`.
- **Sin degradados RGB.** Ninguna mezcla continua canal-a-canal (`a + (b - a) * t` con `t`
  proveniente de un valor de mundo continuo) para decidir el color final de un píxel de terreno. Un
  valor de mundo (fertilidad, humedad, tránsito…) puede seguir siendo continuo en los datos; lo que
  no puede ser continuo es su traducción a color. La traducción pasa por un número pequeño y fijo de
  swatches de la paleta.
- **Transiciones con tramado ordenado de Bayer.** Cuando dos materiales compiten por un mismo
  píxel (borde entre dos teselas, orilla, sombreado), la elección por píxel se decide comparando la
  fracción de mezcla contra una matriz de Bayer (4×4 u 8×8), no promediando canal a canal ni
  sorteando con ruido independiente por columna/fila. El tramado ordenado da una textura con
  intención (moteado repetible) donde el promedio daba borrón y el ruido puro daba «escalera».
- **Variación determinista por hash de celda.** Cualquier variación visual (qué swatch exacto, qué
  variante de mota, qué offset de una brizna) sale de `rnd(x, y, sal)`/`hash3` con coordenadas de
  mundo, nunca de `Math.random()` ni del reloj. Debe ser reproducible: mismo mundo, mismo píxel,
  siempre.
- **Contorno oscuro de 1 px en figuras.** Personas, animales, árboles y estructuras llevan un borde
  de 1 px con `SOMBRA` (o el tono `sombra`/`*Oscura` de su propia familia si necesita separarse del
  fondo por hue, no sólo por valor) alrededor de su silueta opaca, para leerse contra cualquier
  fondo de terreno tramado. No es un `stroke` con antialiasing: es una fila/columna de píxeles
  sólidos en el borde exterior de la silueta.
- **Luz arriba-izquierda.** La cara superior-izquierda de un volumen (techo, copa, torso, roca) usa
  el tono base o `LUZ` tramado sobre él; la cara inferior-derecha usa el tono base o `SOMBRA`
  tramado. Consistente en todo sprite nuevo, para que la escena entera lea una sola fuente de luz.

## Qué cambia y qué no

- `src/world`, `src/server` y la carta de S e I no se tocan por esto: es puramente el cliente
  (`src/client`), y sólo cómo se pinta lo que el servidor ya decidió.
- La migración de `life-art.ts` y del resto de `landscape.ts` (agua, costas ya cubiertas, HUD) a
  `paleta.ts` es incremental; esta guía es el contrato para el código nuevo y para lo que se toque,
  no una reescritura de una sola vez.
