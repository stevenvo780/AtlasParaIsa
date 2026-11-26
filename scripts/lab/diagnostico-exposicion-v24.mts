/** Ventana posterior a un guardado material de laboratorio, en CPU1.
 * node --import tsx scripts/lab/diagnostico-exposicion-v24.mts --fixture copia.sqlite [--pasos 24]
 * Los días se numeran como en el panel. Un día parcial cuenta solo las transiciones dentro de la ventana.
 * La dosis integra fracciones de intemperie por paso. El daño evitado estima la diferencia en ese mismo
 * cuerpo y paso; otra trayectoria a lo largo de varios días requiere su propia corrida.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { constants, copyFileSync, createReadStream, existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Store } from '../../src/server/store.js';
import { assertWorld, RULES_VERSION, TICKS_PER_DAY } from '../../src/world/index.js';
import { CANAL_EXPOSICION, type MuestraExposicion } from '../../src/world/lineage.js';
import { crearMotor } from '../../src/world/motor/coordinador.js';
import type { Motor } from '../../src/world/motor/contratos.js';
import { paramsOf, setParams } from '../../src/world/params.js';
import { worldContext } from '../../src/world/spatial.js';
import { balanceConservacion } from './encender.mjs';

function acumular() {
  return { pasos: 0, pasosConCuerpoMaterial: 0, pasosLluvia: 0, pasosTechoMaterial: 0, pasosTechoLegado: 0,
    pasosLluviaConTecho: 0, pasosLluviaConPrenda: 0, dosisExterior: 0, dosisResidual: 0,
    dano: { starvation: 0, dehydration: 0, exposure: 0, senescence: 0 },
    exposicionSinTechoNiPrenda: 0, exposicionSoloTecho: 0, danoEvitadoTecho: 0, danoEvitadoPrenda: 0,
    desgasteEdad: 0, golpeSorteoSenescencia: 0, riesgoSenescenciaMax: 0, reparacion: 0, variacionSalud: 0,
    saludMin: 1, vitalidadMin: 1, hambreMax: 0, sedMax: 0, reservaMinJ: null as number | null, aguaMinKg: null as number | null,
    muertes: { starvation: 0, dehydration: 0, exposure: 0, senescence: 0 }, muertesEvitadas: 0 };
}

type Acumulado = ReturnType<typeof acumular>;
function agregar(a: Acumulado, m: MuestraExposicion): void {
  a.pasos++;
  if (m.lluvia) {
    a.pasosLluvia++;
    a.pasosLluviaConTecho += Number(m.techo > 0);
    a.pasosLluviaConPrenda += Number(m.prenda > 0);
    a.dosisExterior++;
    a.dosisResidual += 1 - m.abrigoEfectivo;
  }
  a.pasosTechoMaterial += Number(m.tipoTecho === 'material');
  a.pasosTechoLegado += Number(m.tipoTecho === 'legado');
  a.dano.starvation += m.dano.starvation;
  a.dano.dehydration += m.dano.dehydration;
  a.dano.exposure += m.dano.exposure;
  a.dano.senescence += m.dano.senescence;
  a.exposicionSinTechoNiPrenda += m.exposicionSinTechoNiPrenda;
  a.exposicionSoloTecho += m.exposicionSoloTecho;
  a.danoEvitadoTecho += m.exposicionSinTechoNiPrenda - m.exposicionSoloTecho;
  a.danoEvitadoPrenda += m.exposicionSoloTecho - m.dano.exposure;
  a.desgasteEdad += m.desgasteEdad;
  a.golpeSorteoSenescencia += m.golpeSorteoSenescencia;
  a.riesgoSenescenciaMax = Math.max(a.riesgoSenescenciaMax, m.riesgoSenescencia);
  a.reparacion += m.reparacion;
  a.variacionSalud += m.despues.health - m.antes.health;
  a.saludMin = Math.min(a.saludMin, m.antes.health, m.despues.health);
  a.vitalidadMin = Math.min(a.vitalidadMin, m.antes.vitality, m.despues.vitality);
  a.hambreMax = Math.max(a.hambreMax, m.hambre);
  a.sedMax = Math.max(a.sedMax, m.sed);
  if (m.cuerpo) {
    a.pasosConCuerpoMaterial++;
    a.reservaMinJ = Math.min(a.reservaMinJ ?? Infinity, m.cuerpo.reservaJ);
    a.aguaMinKg = Math.min(a.aguaMinKg ?? Infinity, m.cuerpo.aguaReservaKg);
  }
  if (m.causaTerminal) a.muertes[m.causaTerminal]++;
  a.muertesEvitadas += Number(m.muerteEvitada !== null);
}

interface Individuo { primero: MuestraExposicion; ultimo: MuestraExposicion; valores: Acumulado }
interface Dia { mortales: Acumulado; figurasProtegidas: Acumulado; individuos: Map<string, Individuo> }
const anotar = (fila: object): void => { console.log(JSON.stringify(fila)); };
const { values: args } = parseArgs({ options: { fixture: { type: 'string' }, pasos: { type: 'string', default: '24' } } });
const pasos = Number(args.pasos);
assert.ok(args.fixture && Number.isSafeInteger(pasos) && pasos > 0, 'Indica --fixture con una copia sellada y --pasos como entero positivo');
const original = realpathSync(args.fixture), repo = fileURLToPath(new URL('../../', import.meta.url));
const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const principal = dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
for (const raiz of [resolve(repo, 'data'), resolve(principal, 'data'), resolve(principal, '../AtlasParaIsa-anexo/mundos')]) {
  const operativa = existsSync(raiz) ? realpathSync(raiz) : raiz;
  assert.ok(original !== operativa && !original.startsWith(operativa + sep), 'El fixture debe estar fuera de los mundos operativos');
}
assert.ok(statSync(original).isFile() && !['-wal', '-shm', '-journal'].some(sufijo => existsSync(original + sufijo)),
  'El fixture debe ser un SQLite sellado sin archivos laterales');
const temporal = mkdtempSync(join(tmpdir(), 'atlas-exposicion-v24-')), diagnostico = channel(CANAL_EXPOSICION);
let store: Store | undefined, motor: Motor | undefined;
let suscrito = false;
const dias = new Map<number, Dia>();
const observar = (valor: unknown): void => {
  const muestra = valor as MuestraExposicion, dia = Math.floor((muestra.tick - 1) / TICKS_PER_DAY) + 1;
  let corte = dias.get(dia);
  if (!corte) { corte = { mortales: acumular(), figurasProtegidas: acumular(), individuos: new Map() }; dias.set(dia, corte); }
  let individuo = corte.individuos.get(muestra.id);
  if (!individuo) { individuo = { primero: muestra, ultimo: muestra, valores: acumular() }; corte.individuos.set(muestra.id, individuo); }
  individuo.ultimo = muestra;
  agregar(individuo.valores, muestra);
  agregar(muestra.rol === 'neighbor' ? corte.mortales : corte.figurasProtegidas, muestra);
};

try {
  const copia = join(temporal, 'world.sqlite');
  copyFileSync(original, copia, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  const huella = createHash('sha256');
  for await (const bloque of createReadStream(copia)) huella.update(bloque);
  store = new Store(copia);
  const carga = store.cargarGuardadoCompleto();
  assert.ok(carga?.instantanea.materia && carga.metadatos.slot === 0, 'El fixture requiere un punto vigente con materia');
  const { world } = carga.instantanea, desde = world.tick, hasta = desde + pasos, params = paramsOf(world);
  assert.ok(Number.isSafeInteger(hasta) && !params.v23.materiaGpu, 'El corte requiere materia en CPU y ticks exactos');
  setParams(world, { ...params, motor: { ...params.motor, hilos: 1, gpu: [] } });
  motor = crearMotor(world, { hilos: 1, gpu: [], decisionGpu: 'siempre', verificar: false, semilla: world.seed });
  motor.cargar(carga.instantanea, carga.epoca);
  const inicial = balanceConservacion(world);
  assert.ok(inicial?.ok, 'Balance material inicial inválido');
  const muertesIniciales = { ...world.demographyDynamics.causes };
  anotar({ tipo: 'inicio', version: 1, commit: git('rev-parse', 'HEAD'), semilla: world.seed, fixtureSha256: huella.digest('hex'),
    desdeExclusivo: desde, hastaInclusivo: hasta,
    pasosPorDia: TICKS_PER_DAY, hilos: 1, fase: 'demografia-posaccion', leyes: params.v23, conservacion: inicial });
  diagnostico.subscribe(observar);
  suscrito = true;
  for (let tick = desde + 1; tick <= hasta; tick++) assert.equal(motor.paso([]).tick, tick);
  assertWorld(world, RULES_VERSION, worldContext(world));
  const final = balanceConservacion(world);
  assert.ok(final?.ok && dias.size, 'Falta conservación o muestras en la ventana');
  for (const [causa, antes] of Object.entries(muertesIniciales) as [keyof typeof muertesIniciales, number][]) {
    const observadas = [...dias.values()].reduce((n, corte) => n + corte.mortales.muertes[causa], 0);
    assert.equal(observadas, world.demographyDynamics.causes[causa] - antes, `Causa terminal sin conciliar: ${causa}`);
  }
  for (const [dia, corte] of dias) {
    const observados = [...corte.individuos.values()];
    const primerTick = Math.min(...observados.map(individuo => individuo.primero.tick));
    const ultimoTick = Math.max(...observados.map(individuo => individuo.ultimo.tick));
    anotar({ tipo: 'dia', dia, primerTick, ultimoTick, individuos: observados.length, mortales: corte.mortales, figurasProtegidas: corte.figurasProtegidas });
    for (const { primero, ultimo, valores } of observados) anotar({ tipo: 'individuo-dia', dia, id: primero.id,
      uid: primero.uid, rol: primero.rol, ...valores, primero, ultimo });
  }
  anotar({ tipo: 'fin', tick: world.tick, conservacion: final });
} finally {
  if (suscrito) diagnostico.unsubscribe(observar);
  try { await motor?.cerrar(); }
  finally { store?.close(); rmSync(temporal, { recursive: true, force: true }); }
}
