import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store, type SnapshotSlot } from '../../src/server/store.js';
import { ELEMENTOS } from '../../src/shared/naturaleza.js';
import { Rol, type Sustancia } from '../../src/world/materia/tipos.js';
import { calidadEmpedrado, lotesEnObra } from '../../src/world/materia/piezas.js';
import { ctxMateriaDe } from '../../src/world/motor/acceso.js';
import { unSoloDueno } from '../../src/world/motor/contratos.js';
import { crearMotor } from '../../src/world/motor/coordinador.js';
import { projectWorld } from '../../src/world/projection.js';

const USO = 'Uso: node --import tsx scripts/lab/exportar-cortes-demo.mts <sqlite-sellado> <directorio-nuevo> <slot-anterior> <slot-posterior> <x> <y>';

function entero(s: string | undefined): number {
  assert.ok(s && /^-?\d+$/.test(s) && Number.isSafeInteger(Number(s)), USO);
  return Number(s);
}

function slot(s: string | undefined): SnapshotSlot {
  const n = entero(s);
  assert.ok(n === 0 || n === 1 || n === 2, USO);
  return n;
}

async function sello(path: string): Promise<string> {
  assert.ok(statSync(path).isFile(), 'La fuente debe ser un archivo de guardado.');
  assert.ok(!existsSync(`${path}-journal`) && (!existsSync(`${path}-wal`) || statSync(`${path}-wal`).size === 0),
    'La fuente debe estar sellada y sin transacciones pendientes en un WAL.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function nombrar(s: Readonly<Sustancia>): string {
  const formula = ELEMENTOS.flatMap((elemento, i) => {
    const cantidad = s.atomos[i]!;
    return cantidad > 0 ? [`${elemento}${cantidad === 1 ? '' : cantidad}`] : [];
  }).join('');
  return formula === 'O2Si' ? 'Sílice (SiO₂)' : formula;
}

async function proyectar(store: Store, numero: SnapshotSlot, foco: { x: number; y: number }) {
  const { instantanea, epoca, digest } = store.leerCorteParaProyeccion(numero);
  const { world, materia } = instantanea;
  assert.ok(materia, 'La escena de empedrado requiere materia verificable.');
  const motor = crearMotor(world, unSoloDueno(world.seed));
  try {
    motor.cargar(instantanea, epoca);
    const ctx = ctxMateriaDe(world);
    const viewport = { x: foco.x - 20, y: foco.y - 14, width: 41, height: 29 };
    const residentes = new Map(world.tiles.map(t => [`${t.x},${t.y}`, t]));
    for (let y = viewport.y; y < viewport.y + viewport.height; y++) {
      for (let x = viewport.x; x < viewport.x + viewport.width; x++) {
        assert.ok(residentes.has(`${x},${y}`), 'El encuadre excede las teselas guardadas del corte.');
      }
    }
    const tesela = residentes.get(`${foco.x},${foco.y}`)!;
    const pavimento = calidadEmpedrado(ctx, tesela);
    const vista = projectWorld(world, viewport, store.context);
    const visible = vista.tiles.find(t => t.x === foco.x && t.y === foco.y);
    assert.ok(visible && vista.tick === world.tick, 'La proyección perdió el foco o el tick.');
    assert.equal(visible.paved ?? 0, pavimento, 'El pavimento de la vista debe proceder de la materia del corte.');

    const lotes = [];
    for (const ref of lotesEnObra(ctx, ctx.terreno.celda(foco.x, foco.y), Rol.Pieza).sort()) {
      const v = ctx.materia.vista(ref);
      const s = ctx.quimica.sustancia(v.principal);
      assert.ok(pavimento > 0, 'El foco debe ser empedrado material fuera de una obra.');
      (vista.lotes ??= []).push({ ...foco, rol: 'pieza', forma: v.forma, principal: v.principal, masa: v.masa, T: v.T });
      const sustancias = vista.sustancias ??= [];
      if (!sustancias.some(item => item.id === s.id)) {
        sustancias.push({ id: s.id, clase: s.clase, atomos: [...s.atomos], enlaces: [...s.enlaces], masa: s.masa, prop: s.prop });
      }
      lotes.push({ id: String(ref), sustancia: nombrar(s), masaKg: v.masa });
    }
    assert.equal(world.tick, vista.tick, 'La proyección debe conservar el reloj del guardado.');
    const cuerpo = JSON.stringify(vista);
    return { semilla: world.seed, cuerpo, corte: { tick: world.tick, slot: numero, pavimento, lotes,
      digest: createHash('sha256').update(cuerpo).digest('hex'), digestGuardado: digest } };
  } finally { await motor.cerrar(); }
}

const [origen, salida, anterior, posterior, x, y, ...extras] = process.argv.slice(2);
try {
  assert.ok(origen && salida && !extras.length, USO);
  assert.ok(!process.env.CARTA_MATERIA_FRIA_DIR, 'La proyección debe montar la materia en RAM.');
  const fuente = resolve(origen), destino = resolve(salida);
  const foco = { x: entero(x), y: entero(y) }, slots = [slot(anterior), slot(posterior)];
  assert.notEqual(slots[0], slots[1], USO);
  const fuenteSha256 = await sello(fuente);
  const store = new Store(fuente, { readOnly: true });
  const cuadros = [];
  try {
    for (const numero of slots) cuadros.push(await proyectar(store, numero, foco));
  } finally { store.close(); }
  assert.equal(await sello(fuente), fuenteSha256, 'La fuente cambió durante la proyección.');
  assert.equal(cuadros[0]!.semilla, cuadros[1]!.semilla, 'Los cortes deben pertenecer al mismo mundo.');
  assert.ok(cuadros[0]!.corte.tick < cuadros[1]!.corte.tick, 'Los cortes deben estar en orden de tiempo.');
  mkdirSync(destino, { mode: 0o700 });
  for (const { corte, cuerpo } of cuadros) writeFileSync(join(destino, `${corte.tick}.json`), cuerpo, { mode: 0o600, flag: 'wx' });
  const manifiesto = { version: 1, foco, cortes: cuadros.map(({ corte }) => corte), fuenteSha256 };
  writeFileSync(join(destino, 'cortes.json'), `${JSON.stringify(manifiesto, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify(manifiesto));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
