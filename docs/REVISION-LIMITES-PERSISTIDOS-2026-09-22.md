# T100: límites persistidos y compatibilidad histórica

La integración `39ac4b8` aplica los cuatro límites declarados de terreno, chunks,
comunidades y fauna en validación y transporte. Los snapshots de reglas9 escriben
parámetros completos y un perfil v2 que declara su aplicación y los cuatro valores
efectivos. El lector comprueba la versión de reglas antes de buscar páginas; el
encoder admite las cantidades antes de construir las tuplas de terreno.
**T100 y GateA0 permanecen abiertos.** Esta entrega no resuelve todavía límites
por hardware, admisión al materializar regiones ni los gates conductuales antiguos.

## Compatibilidad que la primera propuesta rompía

T102 permitía conservar números reservados sin aplicarlos. Un mundo antiguo con
limites.teselasActivas=1 era válido aunque tuviese más terreno. Activar ahora ese
número al cargarlo lo rechazaba. La revisión reprodujo el fallo mediante bases
SQLite creadas con el Store anterior, no mediante un mock del lector nuevo.

El parámetro tipado `limites.aplicacion` distingue `historicos` y `parametros`.
Una copia antigua sin las marcas nuevas conserva **todos sus números originales**
y recibe modo historicos; los guardas efectivos siguen siendo los anteriores.
Guardar y recargar no activa los números reservados. Los mundos nuevos usan modo
parametros; una selección explícita puede elegir ese modo. No se consulta RAM,
heap o cgroup durante carga, migración o paso.

La clave nueva pertenece al digesto completo. Por ello el digesto anterior cambia;
la comparación física conserva cada valor, orden, alias y bit numérico. No se
elimina la clave del digesto para fingir igualdad. El roundtrip nuevo exige su
digesto entero exacto. Perfil y modo contradictorios, o ausencia de una de las
marcas v2, se rechazan. V9 no puede distinguir un legacy auténtico de un documento
al que se hayan quitado ambas marcas: aplica los guardas históricos. La ley10
deberá exigir las marcas. El perfil v1 experimental conserva su interpretación.

Otra revisión halló un modo heredado por prototype y una clave extra propia que
la API directa aceptaba, aunque JSON/parseParams lo rechazaban. Ahora se exigen
las claves propias exactas y serializables antes de asociar parámetros. Los
negativos cubren propiedades no enumerables y símbolos, además del guardado
compacto/paginado y su rollback.

## Gates

- Suite conjunta con la reparación de backups: **1251/1251, cero fallos y cero
  omisiones**,170,868s. Typecheck verde; cgroup12GiB sin swap, heap4GiB,
  concurrencia8 y NVRTC explícito.
- Build y smoke del SHA exacto `39ac4b8` pasan en un worktree aislado.
- El primer full pasó1233/1234: un test de checkpoint tecnológico asumía que
  defaults no viajaban en el codec. Ahora extrae y compara todos los parámetros
  antes de comprobar el World. Sus14 controles pasan; se conserva el rojo y se
  repitió la suite conjunta completa, sin retirar ninguna aserción de estado.
- Seis trayectorias de1200 ticks, semillas1/51926/20260905, compacto/páginas
  forzadas, save20, recarga600/1200 y clones descartados. World físico, orden,
  bits, aliases y diez tablas durables coinciden con main022b809. Cada parámetro
  anterior coincide. El digesto nuevo es distinto del antiguo y exactamente
  igual al calculado por el motor anterior sobre una vista a la que sólo se
  añade la clave declarada. Máximo RSS575520KiB, sin pretensión de benchmark.
- Revisión independiente de la fuente `ac0703d`:42/42 controles de límites y
  propiedad,2/2 negativos originales de versión/admisión, y cuatro cadenas
  legacy load→step→save→reopen. Se conservan números reservados, arrays ordenados,
  -0 y el resto de parámetros; sólo cambia el modo declarado. Sin omisiones.

[Gates y procedencia](evidencia-2026-09-22/t100-limits-integration-gates.json).
No se repitió Chromium ni se reinició el servidor público. El test grande2M se
ejecuta aparte contra fuente fija y todavía no forma parte de este resultado.

## Fallo real conservado

La continuación reservada baseline1001, con motor V6 congelado, falló su validación
al día26/tick62400. El snapshot tiene checksum válido y **65792 teselas**, por encima
del antiguo máximo65536; conserva212 habitantes,156 lugares y120 eventos. El
resultado original sigue siendo error, precedido por el timeout de su primer
intento. No se cambia el motor ni se rescata ese lote para hacerlo pasar.
El caso exige impedir una materialización parcial antes de confirmar un mundo que
excede su admisión; ese trabajo sigue pendiente en el frente siguiente de T100.
