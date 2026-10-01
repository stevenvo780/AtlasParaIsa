import json
import os
import ctypes
from pathlib import Path
from datetime import datetime

ctypes.CDLL(None).prctl(15,b'codex8-compose',0,0,0)
os.sched_setaffinity(0,range(6,32))
os.setpriority(os.PRIO_PROCESS,0,19)
initial={'nice':os.getpriority(os.PRIO_PROCESS,0),'cpus':sorted(os.sched_getaffinity(0))}
assert initial=={'nice':19,'cpus':list(range(6,32))}
assert os.environ.get('TMPDIR')=='/datos/tmp-atlas-lab'
ROOT=Path('/datos/tmp-atlas-lab/balance')
data=json.loads((ROOT/'codex8-datos-final/publicos.json').read_text())
revision=json.loads((ROOT/'codex8-revision-final.json').read_text())
assert revision['verdict']=='PASS_OBJETIVO_8_AUDITORIA' and revision['blockingFindings']==0
last={v:next(b for b in reversed(data['backups']) if b['version']==v) for v in ('v13','v12')}
def n(x,d=3):
    return f'{x:.{d}f}' if isinstance(x,float) else str(x)
def table(headers,rows):
    return '\n'.join(['|'+'|'.join(headers)+'|','|'+'|'.join(['---']*len(headers))+'|',*['|'+'|'.join(str(x) for x in row)+'|' for row in rows]])+'\n\n'
text=['# Auditoría de realismo y de la especificación — 30-09-2026\n\n']
summary=[
'Se auditaron seis copias de respaldos, dos mundos de semilla 51926 y 42 réplicas de laboratorio con 2.428 diarios.',
'V13 día 126,750: 855 obras construidas, 3 con cero beneficios directos registrados (0,35 %); V12 día 227,250: 1.015 y 2 (0,20 %).',
'Esto contradice que la mayoría jamás presta servicio; no demuestra ocupación actual ni utilidad marginal de cada nueva obra.',
'V13/V12 conservan 66/101 obras rotas y 52/93 de condición cero; falta desmontaje, recuperación material y estado explícito de ruina.',
'Entre los dos últimos cortes, 40/53 obras dormidas conservan exactamente su registro durante 58,708/109,208 días de calendario.',
'Sí hay desgaste sin uso en regiones activas: una cubierta ordinaria cruza condición 0,1 en 13,39–20,83 días activos sin reparación.',
'Los reservorios rotos retienen 13,067/22,124 unidades de alimento y 29,430/44,590 de agua sin pérdida ambiental.',
'V13/V12 acumulan 348.801/459.520 recetas; 237.929/310.262 no registran aplicación mecánica o bebida acumulada.',
'Consumir una receta como sustrato no suma uses: 16.844/11.082 recetas con uses=0 sí alimentan procesos en los diez días retenidos.',
'Las reservas adultas medias bajan en los siete grupos; no hay evidencia para llamar a esos recursos nunca consumidos.',
'Faltan uso por estructura/día, exposición activa, ocupantes y edad/procedencia de lotes; desconocido no se convierte en cero.',
'C1–C8 cubren un gate biológico parcial: se proponen 16 instrumentos/enmiendas para los 14 frentes de GOAL.',
'C8 v3 sigue fallando 0/6 y 0/10 en ambos brazos; la diversidad entre comunidades aumenta de nivel, no sustituye crecimiento.',
'El 96,3–97,2 % del descenso medio de C8 corresponde a oficio dominante; sharing converge a 1 en los cortes públicos tardíos.',
'Se proponen tres leyes locales con predicción y refutación; quedan para Steven, sin aplicar cambios a reglas ni criterios.'
]
text.append('\n'.join(f'{i}. {s}' for i,s in enumerate(summary,1))+'\n\n')
text.append('**Estado:** FINAL — auditoría del objetivo 8 completada; [revisión independiente PASS](codex8-revision-final.md), sin hallazgos bloqueantes. Fecha real de composición: '+datetime.now().astimezone().isoformat()+'.\n\n')
text.append('## A — Dinámicas observadas y mecanismos\n\n')
text.append('### A1. Procedencia y alcance\n\n')
text.append('Base de código `bb483260b2489fe62b113d620e5f56e5f3676dbc`, rama propia `sprint/auditoria-realismo-20260930`; los módulos de reglas citados no se modificaron. Se copiaron el primer respaldo retenido, el central y el último disponible al corte 30-09 22:19:54 −05 de cada versión. El último V13 era el de las 22:00; el último V12, el detenido a las 07:25. No se persiguieron respaldos posteriores. Todos los datos públicos se leen de copias privadas por `mode=ro&immutable=1`, sin cargar simulación ni consultar servicios.\n\n')
manifest=json.loads(Path('/datos/tmp-atlas-lab/datos-lab/codex8-respaldos/manifest.json').read_text())
text.append(table(['Mundo','Respaldo','Día simulado','Habitantes totales','SHA256 gzip'],[
 [b['version'],b['backup'],n(b['day']),b['people'],r['sha256_gz']]
 for b,r in zip(data['backups'],manifest['backups'])]))
text.append('Datos completos: [publicos.json](codex8-datos-final/publicos.json); manifiesto de fuentes [respaldos-manifest.json](codex8-respaldos-manifest.json). Se verifican SHA del snapshot, cada chunk usado y las estadísticas acumulativas; el lector deduplica por clave→último tick≤horizonte y da prioridad a regiones activas. Las tres estructuras `structure-legacy-*` de cada mundo son paisaje inicial, excluidas de «construidas» y del contador 1…N. Las edades de esas tres no son fechas de construcción físicas.\n\n')
text.append('### A2. Construidas, servicios, edad y condición\n\n')
text.append(table(['Mundo / día','Construidas','Activas / archivadas','uses=0','Rotas ≤0,1 / cero','Edad calendario mediana / máxima (d)','Condición mediana'],[
 [b['version']+' / '+n(b['day']),b['structureCounter'],f"{b['structures']['active']['n']} / {b['structures']['archived']['n']}",b['structures']['built']['usesZero'],f"{b['structures']['built']['broken']} / {b['structures']['built']['conditionZero']}",f"{n(b['structures']['built']['calendarAgeDays']['median']) if b['structureCounter'] else 'NA'} / {n(b['structures']['built']['calendarAgeDays']['max']) if b['structureCounter'] else 'NA'}",n(b['structures']['built']['condition']['median']) if b['structureCounter'] else 'NA'] for b in data['backups']]))
text.append('`uses` cuenta alivio por comer del granero, beber de la cisterna o recuperación al descansar superior al exterior; no cuenta presencia, duración, riego ni toda protección demográfica (`src/world/inventions.ts:365`, `:379`, `:399`, `:431`; `src/world/lineage.ts:156`). Así, cero es **cero beneficios directos registrados desde construcción**, no «nadie entró». Las 3/2 obras de cero usos de los últimos cortes tienen más de 20 días de calendario y están archivadas; sus condiciones no son todas 1. La fracción cero es 3/855 y 2/1015.\n\n')
text.append(table(['Mundo','ID','Edad calendario (d)','Condición','Última observación (día)','Estado'],[
 [v,s['id'],n((b['tick']-s['builtAt'])/2400),n(s['condition'],6),n(s['observedTick']/2400),'archivada' if not s['active'] else 'activa']
 for v,b in last.items() for s in b['structureRows'] if s['id'][10:].isdigit() and s['uses']==0]))
text.append('V13/V12 acumulan '+f"{last['v13']['inventionDynamics']['repairs']}/{last['v12']['inventionDynamics']['repairs']}"+' reparaciones. Cada una debita 1 madera y 30 trabajo y aumenta condición hasta 0,4, con techo 1 (`inventions.ts:457`). La conservación de casas viejas también puede ser mantenimiento; una condición alta por sí sola no prueba ausencia de desgaste. La admisión de nuevas obras mira el arreglo activo y deja de construir al alcanzar 512; reactivar obras archivadas puede superar esa cifra: el corte V12 contiene 575 construidas activas, además de las tres legacy. No es un tope al patrimonio total (`inventions.ts:346`; `spatial.ts:141`).\n\n')
text.append('### A3. Trayectorias y uso por estructura y día\n\n')
text.append(table(['Mundo / ventana (d)','IDs construidos comunes','Δuses=0','Condición baja / sube neto / igual','Mismo registro dormido'],[
 [i['version']+' / '+n(i['dayFrom'])+'–'+n(i['dayTo']),i['matched'],i['usesNoIncrease'],f"{i['conditionDecreased']} / {i['conditionIncreasedNet']} / {i['conditionEqual']}",i['sameArchivedRecord']] for i in data['intervals']]))
text.append('Cada CSV adjunto tiene una fila por ID y ventana, condición antes/después, Δuses y `usesPerCalendarDayInterval=Δuses/Δdías`. Esa tasa es del intervalo observado; **no reconstruye el uso de cada día**. Hay cero campos durables de usuarios/ocupación/lastUsedAt por casa, y los diarios del laboratorio tampoco registran usos o condición por estructura. El historial diario solicitado no puede recuperarse de estos contadores; A y B proponen el instrumento que falta, sin simular visitas ni repartir uniformemente los usos.\n\n')
examples=[]
for i in data['intervals']:
    candidates=[r for r in i['rows'] if r['sameArchivedRecord'] and r['conditionFrom']>.1]
    if candidates:
        r=candidates[0];examples.append([i['version'],r['id'],n(i['dayTo']-i['dayFrom']),n(r['conditionFrom'],6),r['usesDelta'],r['stockUnchanged']])
text.append(table(['Mundo','Ejemplo ID dormido','Intervalo calendario (d)','Condición idéntica','Δuses','Stocks idénticos'],examples))
text.append('Al retirar una región se copia su estado y se restaura sin compensar el tiempo transcurrido (`src/world/spatial.ts:121`, `:185`). Para estructuras activas, condición baja cada 10 ticks en 0,00018 seco o 0,00028 lluvia, dividido por durabilidad 1 o 1,5 (`inventions.ts:466`; `ecologia-constantes.ts:14`). Son 240 revisiones por día activo: −0,0432/−0,0672 para durabilidad 1; desde condición 1, el cruce 0,1 ocurre aproximadamente en 20,83/13,39 días activos sin reparar. Edad calendario y exposición activa son denominadores distintos.\n\n')
text.append('### A4. Depósitos, objetos y residuos\n\n')
text.append(table(['Mundo último','Comida / agua activa','Comida / agua archivada','Comida / agua en rotas','Productos actuales / masa entera','Sin pérdida de masa desde fabricar','Ítems sin desgaste de masa y edad≥20d'],[
 [v,f"{n(b['structures']['active']['food'])} / {n(b['structures']['active']['water'])}",f"{n(b['structures']['archived']['food'])} / {n(b['structures']['archived']['water'])}",f"{n(b['structures']['built']['stockOnBroken']['food'])} / {n(b['structures']['built']['stockOnBroken']['water'])}",f"{b['stocks']['technologyItems']} / {b['stocks']['technologyItemIntegerMass']}",b['stocks']['itemsUnworn'],b['stocks']['itemsUnwornAge20']] for v,b in last.items()]))
text.append('Los saldos archivados son **última observación** a diferentes relojes, no materia simultánea global que pueda sumarse para cerrar un balance. La comida/agua de edificios no se pudre/evapora; rotos quedan inaccesibles para las extracciones ordinarias hasta reparar (`inventions.ts:375`, `:466`). Productos secos pierden masa por trabajo, sustrato y reciclaje, no por calendario (`technology.ts:106`, `:230`, `:265`); el agua portátil sí fuga (`technology-water.ts:219`). Masa inicial intacta no significa nunca usado: beber puede dejar la masa seca intacta.\n\n')
text.append(table(['Mundo último','Comida corporal portátil','Madera / piedra corporal','Residuo tecnológico madera / piedra / agua','Edad máxima producto actual (d)'],[
 [v,n(b['stocks']['bodyFoodInventory']),f"{n(b['stocks']['bodyMaterialUnits']['wood'])} / {n(b['stocks']['bodyMaterialUnits']['stone'])}",' / '.join(str(b['stocks']['technologyResidueIntegerMass'].get(k,0)) for k in ('wood','stone','water')),n(b['stocks']['itemCalendarAgeDays']['max'])] for v,b in last.items()]))
text.append('Los dos sistemas de materia tienen escalas distintas; no se suman unidades corporales con cuantos tecnológicos. Los residuos son tres acumuladores por persona sin edad/lote; esos saldos no identifican recursos jamás consumidos. Entre cortes medios y finales, V13/V12 comparten 35/9 IDs de productos; 1/4 conserva masa, todos esos casos corresponden a mortales en ambos extremos. No se atribuye ausencia de uso por esa igualdad.\n\n')
text.append('### A5. Inventos creados frente a aplicaciones\n\n')
text.append(table(['Mundo último','Recetas creadas','uses=0 (% histórico)','utility=0','uses=0 y edad≥20d','Manufacturadas / usos acumulados','Máxima generación / firmas funcionales acumuladas'],[
 [v,b['recipes']['counts']['recipes'],f"{b['recipes']['counts']['usesZero']} ({n(100*b['recipes']['counts']['usesZero']/b['recipes']['counts']['recipes'],2)} %)",b['recipes']['counts']['utilityZero'],b['recipes']['counts']['usesZeroAge20'],f"{b['recipes']['sums']['manufactured']} / {b['recipes']['sums']['uses']}",f"{b['technologyCatalogue']['maxGeneration']} / {b['technologyCatalogue']['functionalDiversity']}"] for v,b in last.items()]))
text.append('Son estadísticas acumulativas de **todas las definiciones** del archivo, reconciliadas con el catálogo, no las 256 recetas residentes. Todas las recipes con uses=0 sí tienen manufactured>0. `recipe.uses` cuenta aplicación mecánica —incluso con beneficio cero— y bebida; consumir un producto como insumo no lo incrementa (`technology.ts:230`, `:272`; `technology-water.ts:289`). Las firmas funcionales acumuladas tienen un espacio cuantizado finito de 6^6=46.656 y no representan funciones útiles actualmente ejecutadas (`technology-catalogue.ts:23`, `:48`).\n\n')
text.append(table(['Mundo','Recibos retenidos / eliminados por poda','Ventana real retenida (d)','Recetas con beneficio use/water','Recetas insumo distintas','Insumos con uses=0 histórico','Recetas catalizadoras distintas'],[
 [v,f"{b['receipts']['retainedCount']} / {b['receipts']['prunedCount']}",f"{n(b['receipts']['firstTick']/2400)}–{n(b['receipts']['lastTick']/2400)}",b['receipts']['usefulRecipes'],b['receipts']['recipeInputsDistinct'],b['receipts']['inputRecipesWithZeroLifetimeUses'],b['receipts']['catalystRecipesDistinct']] for v,b in last.items()]))
text.append('No debe rotularse 68,21 %/67,52 % como «inventos nunca usados»: al menos 16.844/11.082 de los uses=0 fueron sustratos de research/craft en los recibos retenidos. El prefijo podado solo conserva cuentas por kind, no atribución individual; no permite reconstruir nunca-consumo de cada receta (`store.ts:815`, `:945`). La ventana nominal de 24.000 ticks coincide aquí con 10 días; los extremos incluyen el tick de apertura.\n\n')
text.append('### A6. Hogares, lugares y mecanismos sin retorno completo\n\n')
text.append(table(['Mundo último','Obras sin home exacto de persona viva','Personas con home / coordenadas distintas','Lugares / cero gatherings'],[
 [v,f"{b['structures']['built']['noLivingHomeReference']} / {b['structureCounter']}",f"{b['livingHomes']['peopleWithHome']} / {b['livingHomes']['distinctCoordinates']}",f"{b['places']['n']} / {b['places']['zeroGatherings']}"] for v,b in last.items()]))
text.append('No tener referencia home en este censo no demuestra casa vacía: varios hogares pueden compartir una obra y otros vecinos consumir sus servicios. `gatherings` cuenta reparto social de alimento en un lugar, no visitas (`index.ts:950`). El home distante pierde confianza de retorno, pero puede conservarse almacenado; faltan abandonedAt y último usuario (`society.ts:233`). Los cambios de home diarios sí son dinámicos y se cuantifican en el anexo de laboratorio.\n\n')
text.append(table(['Mecanismo','Bucle vigente / hueco demostrado','Fuente'],[
 ['Obras dormidas','0 avance físico mientras archivadas; al reactivar vuelven stocks y condición','src/world/spatial.ts:121,185'],
 ['Obras rotas','66/101 presentes; no desmontaje ni salvamento, casilla shelter sigue bloqueando obra','src/world/inventions.ts:346,466'],
 ['Protección residual','La fatiga de lluvia comprueba terrain=shelter, sin condición; no toda protección cesa al romperse','src/world/index.ts:382'],
 ['Depósitos','Comida/agua sin pérdidas ambientales, incluyendo stocks bloqueados por rotura','src/world/inventions.ts:375,466'],
 ['Productos secos','No corrosión por edad; sí desgaste pagado, consumo como sustrato y reciclaje','src/world/technology.ts:106,230,265'],
 ['Residuos','Pueden reciclarse/consumirse, pero sin lotes ni fecha; no son necesariamente eternos','src/world/technology.ts:198,241,307'],
 ['Lugares','Permanecen aunque nadie tenga home; no transición explícita abandono→ruina','src/world/inventions.ts:354; src/world/spatial.ts:200'],
 ['Catálogos','Creadas, diversidad acumulada y settlementCount crecen; no indican servicio vigente','src/world/technology-catalogue.ts:272; src/world/inventions.ts:354'],
 ['Territorio','Fuera de vecindarios de personas se congela, independientemente de cámaras','src/world/spatial.ts:144; docs/REGLAS.md:192'],
 ['Aprendizaje','Práctica útil sube habilidades/normas con saturación; no desuso en esa ley','src/world/index.ts:880,893']]))
text.append('### A7. Réplicas de laboratorio: cobertura completa al corte\n\n')
lab=(ROOT/'codex8-laboratorio-borrador.md').read_text()
groups=lab.split('## Grupos:',1)[1].split('\n\n',1)[1].split('## Observabilidad y validación',1)[0]
text.append('Se midieron las 12 réplicas primarias COM-D′ y las **30 identidades canónicas de cupo**: 42 únicas, 2.428 diarios, 35 con 60 días y 7 parciales. Los 30 brazos de cupo comprenden CUPO2/6/20, COM12 y COM12C20, semillas 8101–8106; primario CDC/CDD usa 9501–9506. Tres cortes de copia declarados preservan versiones anteriores y excluyen prefijos sustituidos/copias muertas como observaciones independientes. Es descripción al corte, sin P1–P6 ni veredicto de cupo.\n\n')
text.append(groups)
text.append('Por réplica, edades de ventana, creadas d1/d20/dúltimo, uso útil, recursos, cambios de hogar y rarefacción están en [laboratorio](codex8-laboratorio-borrador.md) y [JSON](codex8-laboratorio-cifras.json). Los primeros diez días de madera/piedra tienen solo 8 puntos (d3–10), porque d1–2 son null en las 42 réplicas; no se sustituyeron por cero. Distintas/día no es unión histórica; uso mecánico útil diario excluye bebidas kind=water. Las 42 réplicas carecen de campos estructurales de condición/usos/stocks: ese frente queda **no observable**, cubierto por las copias públicas y las propuestas B.\n\n')
text.append((ROOT/'codex8-brechas-borrador.md').read_text().replace('# B —','## B —',1))
text.append('\n\n**Cruce con A:** los «No medido V13 aquí» de la tabla B identifican el alcance documental de ese subfrente; A aporta ahora sus medidas observacionales. Sigue sin haber ablaciones de utilidad marginal, balances corporales completos, continuidad de lotes, transmisión multigeneracional o migración causal. La ruina explícita requiere decisión de Steven; no se ha supuesto que GOAL ya fije una tasa de demolición.\n\n')
text.append((ROOT/'codex8-c8-borrador.md').read_text().replace('# C —','## C —',1))
text.append('\n\n## Prioridad de defectos y decisiones\n\n')
text.append(table(['Prioridad','Defecto verificable / incertidumbre','Decisión propuesta'],[
 ['P0.1','Ciclo físico incompleto: 66/101 rotas; stocks bloqueados; condición dormida congelada','Instrumentar exposición/ruina/salvamento y decidir ley material fuera de regiones activas (B02–B04)'],
 ['P0.2','C8 negativo12/12primarias; 96–97% del descenso compuesto viene del oficio; sharing=1 tardía','Mantener criterio creciente; criticar primero ley2 de utilidad relativa, con controles/refutación C5'],
 ['P0.3','0historia diaria estructural y0lotes recursos; contador uses no cubre toda función','Ledger ID/día/usuario/servicio/stock/exposición; medir ocupación y trabajo marginal (B01/B04)'],
 ['P0.4','C7 admite S/I y usar ajeno no prueba conocer ni reponer','Añadir cadena mortal conocimiento→fabricación→uso→recambio, sin tocar congelado (B03/B06)'],
 ['P1.1','693/826 obras sin home exacto, sin abandono formal; migración causal desconocida','Distinguir visita, home, uso y traslado sostenido con trayectoria y escasez (B08)'],
 ['P1.2','Cupo global40/día y fundación64; paquete COM-D′ no aísla disolución','Preservar paneles existentes; nuevos contrastes con parámetros idénticos y motivos de freno (B12)'],
 ['P1.3','348.801/459.520 definiciones no equivalen a novedades funcionales vigentes','Separar catálogo histórico, sustratos, funciones/beneficios y rarefacción (B07/B09)'],
 ['P2','Persistencia, interfaz, rendimiento, carta y neuroevolución fuera del gate biológico','Gates separados B13–B16; revisión personal de Steven pendiente; no publicar por esta auditoría']]))
text.append('## Reproducción, validación y límites finales\n\n')
text.append('Instrumento de solo lectura: `scripts/lab/auditar-realismo.py --output /datos/tmp-atlas-lab/balance/codex8-datos-final`, usando `TMPDIR=/datos/tmp-atlas-lab`, CPUs 6–31 y nice19. Las copias SQLite permanecen locales y no se versionan. Verificador independiente: [script](codex8-verificar-publicos.py), [resultado](codex8-revision-instrumento.json), [lectura](codex8-revision-instrumento.md). Verificación del lector: 19/19 sintéticos; seis copias SQLite y gzip, dos catálogos y cuatro intervalos, 133.166 comparaciones sin diferencia. Incluye checksum, precedencia activo/archivado, horizonte, legacy, duplicados e identidad.\n\n')
text.append('Typecheck y suite del worktree propio: exit0; **1.629 tests, 1.620 PASS, 9 SKIP, 0 FAIL**, 433,124 segundos de suite; 1.297 muestras de recursos del proceso principal sin incidencia, nice19/CPUs6–31. No build: solo instrumentos Python y documentación, sin cambio del producto ni publicación. El cómputo inicial/final aceptado de las tres mediciones tiene guardas de prioridad/afinidad; copias iniciales indicaron nice/taskset sin guarda continua. Algunos replays abortaron por prioridad desviada y se preservaron como fallidos, sin sustituir cifras válidas; no se atribuye causa ni se cambió servicio alguno.\n\n')
text.append('Revisión final independiente: **105.429 comparaciones de datos y 22.260 celdas de 1.590 filas CSV, 0 diferencias**; 57 filas numéricas exactas del informe, 2.428 diarios, 20 series C8 y seis snapshots. El SHA exacto del lector final pasó 19/19 sintéticos, con guardas inicial/final nice19/CPUs6–31. Evidencia: [JSON](codex8-revision-final.json), [verificador](codex8-final-verificar.py) y [ampliación](codex8-final-verificar-extra.py). El [recálculo del laboratorio](codex8-laboratorio-recalcular.py) y la [guía de reproducción](codex8-REPRODUCIR.md) completan el paquete. Tras la revisión solo se cerraron esta línea de estado y este párrafo de validación; las tablas y cifras conservan el contenido revisado.\n\n')
text.append('La auditoría observa datos y código; no ejecutó nuevos controles de causalidad ni implementó leyes. Cero registros de ocupación/servicios no observados no implican cero eventos. Una semilla pública y sus tres cortes no son réplica causal entre versiones, ni ventana diaria completa. Stocks archivados tienen relojes diferentes. C8 se mantiene por crecimiento; ni nivel de F, ni recetas creadas, ni passing tests cierran la meta completa. Informe para decisión de Steven; cierre codex8 se refiere a esta auditoría.\n')
assert initial=={'nice':os.getpriority(os.PRIO_PROCESS,0),'cpus':sorted(os.sched_getaffinity(0))}
(ROOT/'auditoria-realismo-20260930.md').write_text(''.join(text))
print(json.dumps({'report':str(ROOT/'auditoria-realismo-20260930.md'),'bytes':(ROOT/'auditoria-realismo-20260930.md').stat().st_size,'summaryLines':len(summary),'resources':initial}))
