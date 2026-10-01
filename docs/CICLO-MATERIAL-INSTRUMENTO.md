# Observación del ciclo material — objetivo 9

El observador añade evidencia prospectiva de construcciones. Sus acumuladores
permanecen fuera de `World`, parámetros, azar, crónica y esquema persistido.
Se habilita explícitamente en el laboratorio; no modifica las leyes materiales.

```ts
import { createMaterialObserver } from '../src/world/material-observer.js';
import { stepWorld } from '../src/world/index.js';

const observation = createMaterialObserver();
observation.ingest(world); // Antes del primer paso y del primer Store.save.
stepWorld(world);
observation.ingest(world); // Confirmar el paso aceptado, antes de Store.save.
const report = observation.exportRows(); // Copia independiente, no destructiva.
```

Los hooks capturan construcción, consumo útil de granero/cisterna, descanso
adicional, desgaste, reparación y activación/retiro. También capturan extracciones
de alimento que no acreditan uso útil. El muestreo final por sí solo no identifica
una rotura que se repare durante el mismo paso.

| Medida | Significado y límite |
|---|---|
| `daily.uses` | Incrementos positivos del contador existente, separados en comida, agua y descanso. No son visitas, ocupación ni toda protección corporal de un techo. |
| Usuarios/clases | Identidades deduplicadas por estructura y día; mortales, S/I y desconocidos separados. Un usuario puede ejecutar varios usos. |
| `activeExposureTicks` | Duración del reloj de residencia activa, sumando intervalos `[from,to)`. No cuenta frames ejecutados. Una activación y evaluación de desgaste en la misma marca puede dar exposición cero y una evaluación. |
| `wearEvaluations` | Evaluaciones reales de la ley de desgaste, contadas independientemente de la duración residente. |
| Condición y cruces | Estado inicial/final/mínimo observado, cruces de condición ≤0,1 y llegada a cero, incluso si después se repara. |
| Ruina | `brokenObserved` y `conditionZeroObserved` son observaciones; `explicitRuinInModel=false` declara la ausencia actual de una ley de ruina/desmontaje. |
| Reparaciones | Número y débitos observados de madera y trabajo; no acreditan recuperación de material de una ruina. |
| Depósitos | Último saldo observado de alimento y agua. No presume que una región dormida haya avanzado físicamente. |
| Salvamento potencial | Cota nominal de costes de plano, con recuperación sin implementar. No mide masa remanente ni inventario recuperado. Coste de construcción pagado sólo si se observó construir; refugios iniciales quedan sin ese dato. |

El día 1 comprende `(0,2400]`: eventos en 2400 pertenecen al día 1; en 2401,
al día 2. Una ventana de 1200 pasos es parcial. `coverage` declara el inicio,
adjuntos/cargas y huecos; historia previa y estructuras archivadas que nunca
se vieron permanecen desconocidas. Un cierre conserva días incompletos y huecos,
sin convertirlos en cero uso o conservación acreditada.

`cloneWorld` hereda captura provisional; sólo `ingest` del candidato aceptado
confirma sus eventos. `discard` separa un candidato abandonado. El punto de
restauración conserva la captura externa pendiente para rollback del paso;
no se puede deshacer una observación ya confirmada. Las escrituras manuales
de campos materiales fuera de operaciones instrumentadas no están cubiertas.

`benefitByKind` reproduce las escalas existentes de cada clase de servicio.
No sumar comida, hidratación y recuperación como un balance físico. Tampoco
sumar trabajo nominal con madera/piedra como materia recuperable.

La puerta de aceptación exige identidad con `main` en al menos seis semillas
por 1200 pasos, coste ≤1 %, pruebas, typecheck y suite. Su ejecución y límites
se registran con el protocolo y resultados del objetivo 9; este documento
describe el instrumento y no afirma que la puerta esté cumplida.

Resultado del objetivo 9: identidad y cobertura pasan en seis semillas,
96 mundos y 115.200 pasos medidos. La puerta de coste queda **NO CUMPLIDA**:
el límite superior del IC95 % supera el 1 % en tres de las cuatro métricas.
Typecheck y suite pasan (1.636 pruebas aprobadas y 9 omitidas). El candidato
se conserva sólo en su rama local. Ver [entrega y evidencia](../balance/ciclo-material-20261001/ENTREGA.md)
y [diseño de la ley](../balance/ciclo-material-20261001/DISENO-CICLO-MATERIAL-20261001.md).

La ley futura requiere diseño, crítica y autorización independientes. La
instrumentación no implementa desgaste lejano, pérdidas nuevas, desmontaje ni
recuperación material, y no cierra la aceptación biológica de GOAL.

## Anexo DESG-D (rama de laboratorio `sprint/desg-d-lab-20261001`, Muse #1)

Sobre el observador A intacto (ley 0: cero huella — ningún campo nuevo en eventos ni
filas): con `material.desgasteDormido=1` cada evento material lleva `desgaste` =
{N, R, ancla, proyectada} (horizonte vigente al enganchar + ancla copiada + q/Q
proyectada), y `exportDesgaste()` devuelve los despertares
{structureId, tick, conditionAlDespertar, dormidaTicksPrevios, N, R, ancla, proyectada}.
Las filas `structures`/`daily` conservan la condición cruda observada (documentado:
el censo proyectado vive en `scripts/lab/instrumento-desg-d.ts`, que `replica.ts`
escribe como `desgD` diario + `material.json` final). Puerta de identidad ley 0 y 1
en `tests/desg-d-lab.test.ts`.
