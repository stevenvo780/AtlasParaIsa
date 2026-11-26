/** Trayectorias cortas desde una siembra natural, con dos controles por reparto.
 * node --import tsx scripts/lab/cotejo-fisico-v24.mts [--dual] [--semilla 7] [--poblacion 64] [--pasos 12] [--zona 0,0,48,32]
 * Para --dual, COMPUTE_NVRTC debe apuntar a la biblioteca instalada. La salida es JSONL. Código 2 indica una
 * diferencia física o informativa y código 3, actividad CUDA insuficiente o fallos del corredor. Orden y digestos
 * brutos se informan aparte. Las referencias sin resolver conservan su valor original y se cuentan por brazo.
 * Los IDs textuales de organismos, obras y otros entes del mundo se conservan.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { deserialize } from 'node:v8';
import type { ChronicleEvent } from '../../src/shared/types.js';
import type { StructureView } from '../../src/shared/life.js';
import type { ProcesoTecnicoDatos } from '../../src/shared/technology.js';
import { NE } from '../../src/shared/naturaleza.js';
import type { Animal } from '../../src/world/animals.js';
import { digestoCanonico } from '../../src/world/digesto.js';
import { closeEcosystemWorkers } from '../../src/world/ecosystem.js';
import { assertWorld, createWorld, RULES_VERSION, type World } from '../../src/world/index.js';
import { codificarCheckpoint, decodificarEnVuelo, decodificarPaginas, saldoEnVuelo } from '../../src/world/materia/checkpoint.js';
import { plantillaPorId } from '../../src/world/materia/cuerpo.js';
import { balancePares, comprobarConservacion } from '../../src/world/materia/libro.js';
import { estadoObra } from '../../src/world/materia/piezas.js';
import type { Cuerpo } from '../../src/world/materia/tipos.js';
import { ctxMateriaDe } from '../../src/world/motor/acceso.js';
import { duenoSi } from '../../src/world/motor/contexto.js';
import { genDe, REF_NULA, slotDe, type Motor } from '../../src/world/motor/contratos.js';
import { crearMotor } from '../../src/world/motor/coordinador.js';
import { paramsOf, setParams } from '../../src/world/params.js';
import { worldContext } from '../../src/world/spatial.js';
import type { Chunk } from '../../src/world/terrain.js';
import { archivoDeChunks, paramsDeCorrida, poblar, zona } from './poblacion.mjs';

type Dato = null | undefined | boolean | number | bigint | string | Dato[] | { [key: string]: Dato };
const ordenar = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function canonico(valor: unknown): Dato {
  if (valor === null || valor === undefined || typeof valor === 'number' || typeof valor === 'bigint' ||
    typeof valor === 'boolean' || typeof valor === 'string') return valor;
  if (Array.isArray(valor)) return valor.map(canonico);
  if (ArrayBuffer.isView(valor) && !(valor instanceof DataView)) return Array.from(valor as Float64Array, canonico);
  assert.ok(typeof valor === 'object' && (Object.getPrototypeOf(valor) === Object.prototype || Object.getPrototypeOf(valor) === null),
    'Estado fuera del dominio del cotejo');
  const objeto = valor as Record<string, unknown>;
  return Object.fromEntries(Object.keys(objeto).sort(ordenar).map(clave => [clave, canonico(objeto[clave])]));
}

/** Codificación por valor, con etiquetas que mantienen el tipo y distinguen −0 y ausencias. */
function huella(dato: Dato): string {
  const json = JSON.stringify(dato, function (this: object, clave, valor: Dato) {
    switch (typeof valor) {
      case 'number': return Object.is(valor, -0) ? 'n-0' : `n${valor}`;
      case 'bigint': return `i${valor}`;
      case 'string': return `s${valor}`;
      case 'undefined': return Object.hasOwn(this, clave) ? 'u' : 'a';
      default: return valor;
    }
  });
  return sha(Buffer.from(json));
}
const porClave = <T,>(lista: readonly T[], clave: (elemento: T) => string) => {
  const entradas = lista.map(elemento => [clave(elemento), elemento] as const);
  assert.equal(new Set(entradas.map(([id]) => id)).size, entradas.length, 'Identidad duplicada');
  return Object.fromEntries(entradas);
};
const punto = (p: { x: number; y: number }): string => `${p.x},${p.y}`;

function celda(c: number): string | null {
  if (c < 0) return null;
  const pagina = Math.floor(c / 256), dentro = c % 256;
  const px = Math.floor(pagina / 2 ** 21) - 2 ** 20, py = pagina % 2 ** 21 - 2 ** 20;
  return `${px * 16 + dentro % 16},${py * 16 + Math.floor(dentro / 16)}`;
}

function sumarGrupos<T>(lista: readonly T[], clave: (elemento: T) => string): object {
  const grupos = new Map<string, Dato[]>();
  for (const elemento of lista) {
    const grupo = clave(elemento), valor = canonico(elemento), valores = grupos.get(grupo);
    if (valores) valores.push(valor); else grupos.set(grupo, [valor]);
  }
  for (const valores of grupos.values()) {
    // Empareja lotes indistinguibles por contenido exacto y conserva su multiplicidad.
    const ordenados = valores.map(valor => [huella(valor), valor] as const).sort(([a], [b]) => ordenar(a, b));
    valores.splice(0, valores.length, ...ordenados.map(([, valor]) => valor));
  }
  return Object.fromEntries(grupos);
}

function datosEvento(evento: ChronicleEvent) {
  const { id: _id, death, ...base } = evento;
  const { previous: _anteriores, ...muerte } = death ?? {};
  return { ...base, ...(death && { death: muerte }) };
}

interface Corrida {
  nombre: string; mundo: World; motor: Motor; inicial: string; archivar: () => void; archivo: Map<string, Buffer>;
  porUid: Map<number, string>; uidPorId: Map<string, number>; eventos: Map<string, string>; repeticionesEvento: Map<string, number>;
}

function capturar(corrida: Corrida) {
  corrida.archivar();
  const { world, materia } = corrida.motor.instantanea(), dueno = duenoSi(corrida.mundo), q = dueno?.quimica;
  assert.ok(materia && dueno && q && materia.tick === world.tick, 'Falta un corte material del mismo tick');
  assertWorld(world, RULES_VERSION, worldContext(corrida.mundo));
  const { lotes } = decodificarPaginas(materia.epoca, materia.paginas), codificado = codificarCheckpoint(materia);
  const porRef = new Map(lotes.map(lote => [lote.ref, lote]));
  const saldo = Array<bigint>(NE + 1).fill(0n), especies = new Map<number, string>();
  const sustancia = (id: number) => q.sustancia(id);
  const firma = (id: number): string => {
    if (id === 0) return 'calor';
    let clave = especies.get(id);
    if (clave === undefined) { clave = Array.from(sustancia(id).enlaces).join(','); especies.set(id, clave); }
    return clave;
  };
  const pares = (datos: Float64Array) => Array.from({ length: datos.length / 2 }, (_, i) => [datos[i * 2]!, datos[i * 2 + 1]!] as const);
  const contenido = (datos: Float64Array): object => Object.fromEntries(pares(datos).map(([id, n]) => [firma(id), n]));
  for (const lote of lotes) balancePares(pares(lote.pares), sustancia).forEach((n, i) => { saldo[i] = saldo[i]! + n; });
  const enVuelo = saldoEnVuelo(materia.enVuelo, sustancia);
  comprobarConservacion(materia, saldo, enVuelo);

  const archivo = [...corrida.archivo.values()].map(bytes => deserialize(bytes) as Chunk);
  const fuera = [...world.retiredChunks, ...archivo];
  const activos = [...world.people, ...world.animals];
  const fr = dueno.frente;
  const uidsFrente: number[] = [];
  for (let slot = 0; slot < fr.alta; slot++) if (fr.vivo[slot] === 1) uidsFrente.push(fr.uid[slot]!);
  const uids = activos.map(o => o.uid);
  assert.equal(new Set(uids).size, uids.length, 'UID vivo duplicado');
  assert.deepEqual(uidsFrente.sort((a, b) => a - b), uids.sort((a, b) => a! - b!), 'Identidades del frente y del corte distintas');
  for (const organismo of [...activos, ...fuera.flatMap(c => c.animals ?? [])]) {
    if (organismo.uid === undefined) continue;
    const anterior = corrida.porUid.get(organismo.uid), uid = corrida.uidPorId.get(organismo.id);
    assert.ok(Number.isSafeInteger(organismo.uid) && organismo.uid > 0, `UID inválido de ${organismo.id}`);
    assert.ok((anterior === undefined || anterior === organismo.id) && (uid === undefined || organismo.uid === uid),
      `La identidad persistente de ${organismo.id} cambió de UID`);
    corrida.porUid.set(organismo.uid, organismo.id);
    corrida.uidPorId.set(organismo.id, organismo.uid);
  }
  porClave(activos, o => o.id);
  const desconocidos = new Set<number>();
  const idUid = (uid: number) => {
    if (!uid) return uid;
    const id = corrida.porUid.get(uid) ?? dueno.idDe(uid);
    if (!id) desconocidos.add(uid);
    return id ?? { uidSinResolver: uid };
  };

  const diario = world.chronicleJournal;
  for (const evento of [...(diario?.pending ?? []), ...world.events]) {
    if (corrida.eventos.has(evento.id)) continue;
    const base = huella(canonico(datosEvento(evento))), vez = (corrida.repeticionesEvento.get(base) ?? 0) + 1;
    corrida.repeticionesEvento.set(base, vez);
    corrida.eventos.set(evento.id, `${base}/${vez}`);
  }
  const causasSinResolver = new Set<string>();
  const idEvento = (id: string): string => {
    if (!id) return id;
    const clave = corrida.eventos.get(id);
    if (!clave) causasSinResolver.add(id);
    return clave ?? `sin-resolver:${id}`;
  };
  const evento = (e: ChronicleEvent) => ({ ...datosEvento(e), id: idEvento(e.id),
    ...(e.death && { death: { ...e.death, previous: e.death.previous.map(idEvento) } }) });

  const anclas = new Map<number, string[]>();
  const lote = (ref: number, ruta: string, caducable = false) => {
    if (ref === REF_NULA) return null;
    const valor = porRef.get(ref);
    if (!valor) { assert.ok(caducable, `Lote ausente en ${ruta}`); return { caducado: true }; }
    const previas = anclas.get(ref);
    if (previas) previas.push(ruta); else anclas.set(ref, [ruta]);
    return { celda: celda(valor.celda), rol: valor.rol, forma: valor.forma, composicion: contenido(valor.pares) };
  };
  const registro = (id: number): string | number => {
    if (id < 0) return id;
    const bytes = dueno.globales.registro.leer(id);
    assert.ok(bytes, `Entrada ausente del registro: ${id}`);
    return sha(bytes);
  };
  const contextoMaterial = ctxMateriaDe(corrida.mundo);
  const cuerpo = (c: Cuerpo | undefined, ruta: string, archivado = false) => {
    if (!c) return c;
    const plantilla = plantillaPorId(contextoMaterial, c.plantilla);
    const { id: _id, partes, sintesis, ...caracteristicas } = plantilla;
    const compuestos = (items: typeof partes) => items.map(({ id, nu }) => ({ sustancia: firma(id), nu }));
    return { plantilla: { ...caracteristicas, partes: compuestos(partes), sintesis: { ...sintesis,
      entradas: compuestos(sintesis.entradas), salidas: compuestos(sintesis.salidas) } },
    tejido: lote(c.tejido, `${ruta}.tejido`, archivado), reserva: lote(c.reserva, `${ruta}.reserva`, archivado),
    digestivo: lote(c.digestivo, `${ruta}.digestivo`, archivado), gestacion: c.gestacion && { ...c.gestacion,
      otro: idUid(c.gestacion.otro), embrion: lote(c.gestacion.embrion, `${ruta}.embrion`, archivado) } };
  };
  const paso = (p: ProcesoTecnicoDatos['pasos'][number]) => p.op === 'unir' ? { ...p, insumo: firma(p.insumo) } : p;
  const proceso = (p: ProcesoTecnicoDatos, ruta: string, archivado = false) => ({ ...p,
    lote: lote(p.lote, `${ruta}.lote`, archivado), pasos: p.pasos.map(paso) });
  const personas = world.people.map(p => {
    const { uid: _uid, cuerpo: c, carga, technology, experiences, habits, ...resto } = p, ruta = `persona.${p.id}`;
    const { tecnica, ...conocimiento } = technology, enCurso = tecnica?.proceso;
    return { ...resto, cuerpo: cuerpo(c, ruta), carga: carga?.map((ref, i) => lote(ref, `${ruta}.carga.${i}`)),
      experiences: experiences.map(e => ({ ...e, causeId: idEvento(e.causeId) })),
      habits: habits.map(h => ({ ...h, evidence: h.evidence.map(e => ({ ...e, eventId: idEvento(e.eventId) })) })),
      technology: { ...conocimiento, tecnica: tecnica && { ...tecnica,
        recetas: tecnica.recetas.map(r => ({ ...r, id: registro(r.id), padres: r.padres.map(registro) })),
        proceso: enCurso && { ...enCurso, receta: registro(enCurso.receta), padres: enCurso.padres.map(registro),
          proceso: proceso(enCurso.proceso, `${ruta}.proceso`), original: enCurso.original?.map(paso) },
      } } };
  });
  const fauna = (a: Animal, archivado = false) => {
    const { uid: _uid, cuerpo: c, fauna: f, ...resto } = a;
    return { ...resto, cuerpo: cuerpo(c, `animal.${a.id}`, archivado), fauna: f && { ...f,
      persigue: idUid(f.persigue), huyeDe: idUid(f.huyeDe), pareja: idUid(f.pareja), heridoPor: idUid(f.heridoPor),
      extraido: f.extraido && { ...f.extraido, por: idUid(f.extraido.por) } } };
  };
  const obra = (s: StructureView, archivado = false) => {
    const o = estadoObra(s), ruta = `obra.${s.id}`;
    if (!o) return s;
    return { ...s, obraMaterial: { ...o, agua: lote(o.agua, `${ruta}.agua`, true), comida: lote(o.comida, `${ruta}.comida`, true),
      piezas: o.piezas.map((p, i) => ({ ...p, lote: lote(p.lote, `${ruta}.piezas.${i}`, archivado) })),
      pendiente: o.pendiente && { ...o.pendiente, lote: lote(o.pendiente.lote, `${ruta}.pendiente`, archivado),
        proceso: o.pendiente.proceso && proceso(o.pendiente.proceso, `${ruta}.pendiente.proceso`, archivado) } } };
  };
  const chunk = (c: Chunk) => ({ ...c, tiles: porClave(c.tiles, punto), animales: c.animals?.map(a => fauna(a, true)),
    structures: c.structures?.map(s => obra(s, true)), animals: undefined });

  const idRef = (ref: number) => {
    if (ref === REF_NULA) return null;
    const slot = slotDe(ref);
    return fr.vivo[slot] === 1 && fr.gen[slot] === genDe(ref) ? idUid(fr.uid[slot]!) : { caducado: true };
  };
  const pendientes = decodificarEnVuelo(materia.enVuelo).map(i => {
    const { nonce: _nonce, de, a, celda: lugar, lote: ref, materia: composicion, ...resto } = i;
    // La garantía puede tener un destino caducado. Conserva su saldo, destinatario y destino físico.
    return { ...resto, de: idRef(de), a: idRef(a), celda: celda(lugar), lote: lote(ref, 'garantia', true),
      composicion: composicion && contenido(composicion) };
  });
  const {
    people: _p, animals: _a, tiles: _t, structures: _s, retiredChunks: _r, events, chronicleJournal: _j,
    siguienteUid: _uid, eventCounter, ...mundo
  } = world;
  const fisica = canonico({ personas: porClave(personas, p => p.id), animales: porClave(world.animals.map(a => fauna(a)), a => a.id),
    teselas: porClave(world.tiles, punto), obras: porClave(world.structures.map(s => obra(s)), s => s.id),
    archivado: porClave(archivo.map(chunk), c => c.key), retirado: world.retiredChunks.map(chunk), mundo,
    materia: { lotes: sumarGrupos(lotes.map(l => ({ celda: celda(l.celda), rol: l.rol, forma: l.forma,
      composicion: contenido(l.pares), uso: anclas.get(l.ref)?.sort(ordenar) ?? [] })), l => `${l.celda}/${l.rol}/${l.forma}/${l.uso.join(',')}`),
    pendientes: sumarGrupos(pendientes, i => `${i.tipo}/${i.celda}`),
    libro: { inicial: materia.inicial, fuentes: materia.fuentes, sumideros: materia.sumideros, saldo, enVuelo } } });
  const informacion = canonico({ eventCounter, eventos: porClave(events.map(evento), e => e.id),
    diario: diario && { ...diario, pending: porClave(diario.pending.map(evento), e => e.id) } });
  const orden = canonico({ personas: world.people.map(p => p.id), animales: world.animals.map(a => a.id),
    teselas: world.tiles.map(punto), obras: world.structures.map(s => s.id), eventos: events.map(e => idEvento(e.id)) });
  return { fisica, informacion, orden, bruto: { mundo: digestoCanonico(world), materia: sha(codificado) },
    cobertura: { personas: personas.length, animales: world.animals.length, teselas: world.tiles.length,
      lotes: lotes.length, garantias: pendientes.length, uidsSinResolver: desconocidos.size, causasSinResolver: causasSinResolver.size },
    gpu: corrida.motor.telemetria().gpuBrokers };
}

function primeraDiferencia(a: Dato, b: Dato, ruta: string[] = []): { ruta: string[]; izquierda: unknown; derecha: unknown } | null {
  if (Object.is(a, b)) return null;
  const resumir = (v: Dato) => typeof v === 'bigint' ? { entero: String(v) }
    : typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0)) ? { numero: Object.is(v, -0) ? '-0' : String(v) }
    : v === undefined ? { ausente: true } : v && typeof v === 'object' ? { llaves: Object.keys(v).slice(0, 5) } : v;
  const diferencia = () => ({ ruta, izquierda: resumir(a), derecha: resumir(b) });
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return diferencia();
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return { ruta: [...ruta, 'length'], izquierda: a.length, derecha: b.length };
  const izq = a as Record<string, Dato>, der = b as Record<string, Dato>;
  for (const clave of new Set([...Object.keys(izq), ...Object.keys(der)])) {
    if (Object.hasOwn(izq, clave) !== Object.hasOwn(der, clave)) return { ruta: [...ruta, clave], izquierda: resumir(izq[clave]), derecha: resumir(der[clave]) };
    const cambio = primeraDiferencia(izq[clave], der[clave], [...ruta, clave]);
    if (cambio) return cambio;
  }
  return null;
}

const { values: args } = parseArgs({ options: { dual: { type: 'boolean' }, semilla: { type: 'string', default: '7' },
  poblacion: { type: 'string', default: '64' }, pasos: { type: 'string', default: '12' }, zona: { type: 'string', default: '0,0,48,32' } } });
const semilla = Number(args.semilla), poblacion = Number(args.poblacion), pasos = Number(args.pasos), area = zona(args.zona);
assert.ok([semilla, poblacion, pasos].every(Number.isSafeInteger) && semilla >= 0 && poblacion > 0 && pasos > 0, 'Semilla, población o ventana inválidas');
if (args.dual) {
  assert.ok(process.env.COMPUTE_NVRTC && existsSync(process.env.COMPUTE_NVRTC), 'Falta COMPUTE_NVRTC');
  process.env.CARTA_PERCEPCION_DUENOS = '1';
  process.env.CARTA_PERCEPCION_COSTE_DUENOS = '0';
}
const corridas: Corrida[] = [];
function abrir(nombre: string, hilos: number, gpu: number[]) {
  const base = paramsDeCorrida({ regimen: 'abierto', hasta: 'rebalanceo', hilos: 1, gpu: [] });
  const mundo = createWorld(semilla, base);
  poblar(mundo, { n: poblacion, zona: area, siembra: semilla });
  const inicial = digestoCanonico(mundo), params = paramsOf(mundo);
  setParams(mundo, { ...params, v23: { ...params.v23, rebalanceo: false }, motor: { ...params.motor, hilos, gpu } });
  const motor = crearMotor(mundo, { hilos, gpu, decisionGpu: 'siempre', verificar: false, semilla, medirBrokerGpu: !!gpu.length });
  corridas.push({ nombre, inicial, mundo, motor, ...archivoDeChunks(mundo), porUid: new Map(), uidPorId: new Map(),
    eventos: new Map(), repeticionesEvento: new Map() });
  return motor;
}

const anotar = (valor: unknown): void => { console.log(JSON.stringify(valor)); };
const comparaciones = [[0, 1], [2, 3], ...(args.dual ? [[2, 4], [3, 4]] : [])] as const;
const primeras = new Map<string, object>();
const primeraAceptacion = new Map<number, number>();
const referenciasSinResolver = new Map<string, { uids: number; causas: number }>();
let difiere = false;
try {
  abrir('cpu1-a', 1, []); abrir('cpu1-b', 1, []); abrir('cpu2-a', 2, []); abrir('cpu2-b', 2, []);
  const dual = args.dual ? abrir('dual', 2, [0, 1]) : undefined;
  assert.equal(new Set(corridas.map(c => c.inicial)).size, 1, 'Las corridas parten de estados distintos');
  const lista = await dual?.prepararBrokerGpu?.();
  anotar({ tipo: 'inicio', version: 1, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    instrumentoSha256: sha(readFileSync(new URL(import.meta.url))), node: process.version,
    semilla, poblacion, area, pasos, inicial: corridas[0]!.inicial, brazos: corridas.map(c => c.nombre), rebalanceo: false,
    ...(dual && { arranqueGpu: lista, dispositivos: dual.telemetria().gpuBrokers }) });
  for (let tick = 1; tick <= pasos; tick++) {
    for (const c of corridas) assert.equal(c.motor.paso([]).tick, tick);
    const cortes = corridas.map(capturar), huellas = cortes.map(c => ({ fisica: huella(c.fisica), informacion: huella(c.informacion), orden: huella(c.orden) }));
    cortes.forEach(({ cobertura }, i) => {
      const nombre = corridas[i]!.nombre, anterior = referenciasSinResolver.get(nombre);
      referenciasSinResolver.set(nombre, { uids: Math.max(anterior?.uids ?? 0, cobertura.uidsSinResolver),
        causas: Math.max(anterior?.causas ?? 0, cobertura.causasSinResolver) });
    });
    if (dual) for (const tarjeta of cortes.at(-1)!.gpu ?? []) {
      if (!primeraAceptacion.has(tarjeta.dispositivo) && tarjeta.detalle?.aceptadas.some(n => n > 0)) primeraAceptacion.set(tarjeta.dispositivo, tick);
    }
    for (const [izq, der] of comparaciones) {
      const par = `${corridas[izq!]!.nombre}/${corridas[der!]!.nombre}`;
      for (const dimension of ['fisica', 'informacion', 'orden'] as const) {
        if (huellas[izq!]![dimension] === huellas[der!]![dimension]) continue;
        const clave = `${par}/${dimension}`;
        if (dimension !== 'orden') difiere = true;
        if (!primeras.has(clave)) {
          const campo = primeraDiferencia(cortes[izq!]![dimension], cortes[der!]![dimension]);
          assert.ok(campo, `Huella desigual sin diferencia de valor en ${clave}`);
          primeras.set(clave, { par, dimension, tick, campo });
        }
      }
    }
    anotar({ tipo: 'tick', tick, brazos: Object.fromEntries(cortes.map((c, i) => [corridas[i]!.nombre,
      { ...huellas[i], bruto: c.bruto, cobertura: c.cobertura, gpu: c.gpu }])) });
  }
  const gpu = dual?.telemetria().gpuBrokers;
  const cudaAcreditada = dual ? lista === true && [0, 1].every(id => gpu?.some(t => t.dispositivo === id && t.lista && t.detalle &&
    t.detalle.aceptadas.some(n => n > 0) && t.detalle.subidaConfirmadaBytes > 0 && t.detalle.bajadaConfirmadaBytes > 0 &&
    t.detalle.erroresCanal === 0 && t.detalle.cpuSinCanal === 0)) : null;
  anotar({ tipo: 'fin', pasos, conservacion: true, cudaAcreditada, primeraAceptacion: Object.fromEntries(primeraAceptacion),
    primeras: [...primeras.values()], referenciasSinResolver: Object.fromEntries(referenciasSinResolver), gpu });
  if (cudaAcreditada === false) process.exitCode = 3;
  else if (difiere) process.exitCode = 2;
} finally {
  await Promise.all(corridas.map(c => c.motor.cerrar()));
  await closeEcosystemWorkers();
}
