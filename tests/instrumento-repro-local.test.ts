import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneWorld, createWorld, stepWorld, type Person, type World } from '../src/world/index.js';
import { digestoCanonico } from '../src/world/digesto.js';
import { disponibilidadCorporal, reproductiveReadiness } from '../src/world/family.js';
import { demographicTraits } from '../src/world/demography.js';
import { parseParams, paramsOf, setParams } from '../src/world/params.js';
import { InstrumentoReproLocal } from '../scripts/lab/instrumentos.js';

/**
 * Instrumento D2 (S2/S3): solo lectura. S2 cuenta evaluaciones de m_L con histograma;
 * S3 anota phi al nacer + foto de fertiles-no-concebidos por ventana. Puertas: digestos
 * identicos con/sin instrumento (ley on y off, 6x1200) y salida determinista.
 */
const PHI = 0.5;
const paramsLey = (extra = '') => parseParams(`poblacion.reproLocal=${PHI}${extra}`);

/** Corre pasos llamando los hooks y cerrando cada dia (como replica.ts). */
function correrConInstrumento(world: World, pasos: number): unknown[] {
  const inst = new InstrumentoReproLocal();
  const dias: unknown[] = [];
  for (let n = 1; n <= pasos; n++) {
    stepWorld(world);
    inst.despuesDelPaso(world);
    if (world.tick % 2400 === 0) dias.push(inst.metricasDia(world));
  }
  return dias;
}

test('Inst S2: un dia acumula evaluaciones con histograma coherente', { timeout: 300000 }, () => {
  const world = createWorld(9201, paramsLey());
  const dias = correrConInstrumento(world, 2400) as { evalM: { n: number; fracGt15: number; hist: number[] }; ventanas: unknown[] }[];
  assert.equal(dias.length, 1);
  const { n, fracGt15, hist } = dias[0]!.evalM;
  assert.equal(dias[0]!.ventanas.length, 20);
  assert.ok(n > 1000, `evaluaciones/dia: ${n}`);
  assert.equal(hist.length, 6);
  assert.equal(hist.reduce((a, b) => a + b, 0), n);
  assert.equal(fracGt15, (hist[2]! + hist[3]! + hist[4]! + hist[5]!) / n);
});

test('Inst S3: phi al nacer y fertiles-no-concebidos por ventana', { timeout: 300000 }, () => {
  const world = createWorld(9202, paramsLey());
  const place = world.places[0]!;
  for (const tile of world.tiles) tile.drinkingWater = 1;
  const cuerpo = paramsOf(world).cuerpo;
  const aptos = world.people.filter(p => p.role === 'neighbor'
    && p.demography.age >= demographicTraits(p.genome, cuerpo).maturityAge
    && p.demography.age < demographicTraits(p.genome, cuerpo).senescenceStart);
  assert.ok(aptos.length >= 4);
  const parejas = [aptos.slice(0, 2), aptos.slice(2, 4)];
  const enPareja = new Set(parejas.flat().map(p => p.id));
  parejas.forEach(([a, b], i) => {
    for (const [persona, dx] of [[a, 0], [b, 1]] as const) {
      persona!.x = place.x + dx; persona!.y = place.y + i * 2;
      persona!.target = { x: persona!.x, y: persona!.y };
      persona!.action = 'rest'; persona!.decisionAt = world.tick + 1000;
      persona!.inventory = 0.14; persona!.thirst = 0; persona!.hunger = 0.2;
      persona!.lastBirth = world.tick - 10000;
    }
    a!.bonds[b!.id] = 0.5; b!.bonds[a!.id] = 0.5;
  });
  for (const person of world.people) {
    if (person.role === 'neighbor' && !enPareja.has(person.id)) { person.inventory = 0; person.thirst = 0; }
  }
  const inst = new InstrumentoReproLocal();
  for (let n = 1; n <= 120; n++) { stepWorld(world); inst.despuesDelPaso(world); }
  const dia = inst.metricasDia(world);
  assert.equal(dia.ventanas.length, 1);
  assert.equal(dia.ventanas[0]!.ventana, 0);
  assert.equal(dia.ventanas[0]!.phiNacimientos.length, 2);
  for (const phi of dia.ventanas[0]!.phiNacimientos) assert.ok(phi === null || (typeof phi === 'number' && phi >= 0));
  const f = dia.ventanas[0]!.fertiles;
  assert.ok(f.n + f.nSinLugar >= 1, 'hay fertiles en riesgo');
  assert.equal(f.n, f.histPhi.reduce((a, b) => a + b, 0) + f.nPhiNull);
  assert.equal(f.mediana === null, f.histPhi.reduce((a, b) => a + b, 0) === 0);
});

test('Inst puerta corporal: con ley off coincide con readiness; con ley on la contiene', { timeout: 300000 }, () => {
  for (const ley of [false, true]) {
    const world = ley ? createWorld(9203, paramsLey()) : createWorld(9203);
    for (let n = 1; n <= 240; n++) {
      stepWorld(world);
      if (n % 60 === 0) {
        for (const person of world.people) {
          const cuerpo = disponibilidadCorporal(world, person);
          const lista = reproductiveReadiness(world, person);
          if (ley) assert.ok(!lista || cuerpo, 'el freno solo restringe');
          else assert.equal(lista, cuerpo);
        }
      }
    }
  }
});

test('Inst digestos identicos con/sin instrumento, ley on y off, 6x1200', { timeout: 600000 }, () => {
  for (const ley of [true, false]) {
    for (const seed of [9201, 9202, 9203, 9204, 9205, 9206]) {
      const con = ley ? createWorld(seed, paramsLey()) : createWorld(seed);
      correrConInstrumento(con, 1200);
      const sin = ley ? createWorld(seed, paramsLey()) : createWorld(seed);
      for (let n = 1; n <= 1200; n++) stepWorld(sin);
      assert.equal(digestoCanonico(con), digestoCanonico(sin), `ley ${ley ? 'on' : 'off'} semilla ${seed}`);
    }
  }
});

test('Inst salida determinista: misma semilla, mismo JSON', { timeout: 300000 }, () => {
  const correr = (): string => {
    const world = createWorld(9204, paramsLey());
    const dias = correrConInstrumento(world, 240);
    return JSON.stringify(dias);
  };
  assert.equal(correr(), correr());
});

test('Inst sobrevive a cloneWorld por paso (rama --gobernador servidor)', { timeout: 300000 }, () => {
  let world = createWorld(9205, paramsLey());
  const inst = new InstrumentoReproLocal();
  for (let n = 1; n <= 240; n++) {
    const draft = cloneWorld(world);
    stepWorld(draft);
    inst.despuesDelPaso(draft);
    world = draft;
  }
  const dia = inst.metricasDia(world);
  assert.equal(dia.ventanas.length, 2);
  assert.ok(dia.evalM.n > 100, `evaluaciones con clones: ${dia.evalM.n}`);
});

test('Inst forma del JSON diario', () => {
  const world = createWorld(9206, paramsLey());
  stepWorld(world);
  const inst = new InstrumentoReproLocal();
  inst.despuesDelPaso(world);
  const dia = JSON.parse(JSON.stringify(inst.metricasDia(world))) as Record<string, unknown>;
  assert.deepEqual(Object.keys(dia).sort(), ['evalM', 'ventanas']);
  assert.deepEqual(Object.keys(dia.evalM as object).sort(), ['fracGt15', 'hist', 'n']);
});

/** Puerta F05 pedida por el orquestador (29-09): con la ley ACTIVA el digesto SIN
 * `world.reproLocal` (la forma de frenos {m,phi} difiere de 3dc4fd6 a proposito) coincide con
 * 3dc4fd6 cada 120 pasos, 6 semillas x 1200, CON foto y (9201) cierre de dia + drenaje.
 * Dorados generados en el arbol 3dc4fd6 con auditoria-muse/digest-f05.mts. */
const DORADOS_F05_3DC4FD6: Record<number, readonly string[]> = {
  9201: [
    '631a1426a418c1c4dce7aacc16be30d5b7b7ed73a04e1f0e2b1379a9ca61e633',
    '8328150006253f8d29c5e38452a83505d9338e74225d947d805b39a275ba0a61',
    '620cf6ab92431c082f1be76622f5d4d1bcde3f5934ffdd2629af47cf71c1f485',
    'dffc30e79d2539455450e1ceca5b88dd6ff380c8ebef57718156c98005d8932f',
    'b562786c364c00c4fba924ae85e0ff9b0aa6baf556478bdd88ba7ec556d9f956',
    '6437d4a7a743a39cd7263d9059db6a453c4277a5fa238992f49178283e1f877c',
    'e88605e58c8e0fabe260f5878008a8112353420c083fe9cee4830cddee270aef',
    '4a64b7a1dae0c0811d4a23fa70289c31ca0e27a107e4dc756f389eb574a6d745',
    '06a8d83b9308c45e606bb62380bca51c193feecf541ae571dcf19972ca54f4d6',
    '5cd2b804b9475322008d35ad5e6099d48be09834930b9f0b2ca1dfba4a4b6ee1',
  ],
  9202: [
    'a77b88aff5d22b1b03cf75fddcc93d15baee87abee88bf1ab9009e7383668b21',
    'e556e43c2c258382d08410da7a9d71d151f90a77496b4c70d90cdd1f5822194b',
    '544d41a67848f43cc6c12ec9a77684fd5f3e87065c3eefddad59f6048410848b',
    '0199dbf581259236aef61b57f3ad39f38c174bc00378aa960e5e620d2a28c35e',
    'dbe956959c5819cdea5195f7ab8a52cad2fb84eac834b1d260bddf225212f8c9',
    'd6dcc9a5d245f3e846021d2700443f9c08074bc63be0c6852a5915fd939b690b',
    '06017b1eaa601e45fb611019e0f8dca33e2fef3c46b738d0c80e996b3d4cfdba',
    '878e78c92cc87caa0aa59b3193787ed842d0bb7a79a28468af9dc1071682335d',
    '57340f1849e6b9d1313915a4ea8220ee98d46868cd2abd0cbf61100ce4b32832',
    'e3f5926d2a2de64501c418ef9c3d1abf4cdd1ace62ec7488e43193e2e8e6d81b',
  ],
  9203: [
    '2b0418ae58c00937ed897a1449b1bc7f17d1338eaf86dd571c0935d8226f4dd2',
    'db4247e6ce1966e35393d6949c909a9af50379f8e5ee6b336e9a4f2ff4144dd3',
    '706b71eed3b9e686a0983e2a2ac49cd9113fc0ba2838e8a872fa86ad0a594739',
    '6bb7f3b24a2fe75e35abe120543970dd1aeca9025b787dbbf979889138d3d1e9',
    '44352d52e45cc80afea3dac8888fa5feb81a9b00157efa67fd54de1799e30d67',
    'd12bf0bcc67f603e40b4f6650ad8cc60651835ccba123fd66d56c5cc740eace3',
    '1b95b5ce8f7ef7b5ba7fd6fff86db30fe3444f4412f41cd5add4f96867c383bb',
    '02e07d3dadd2cb796653e86ac3ed93901a175428f344b36b22ac2bee8f06c0ef',
    '75bd0610b71d4e809199dea095b300d37aac881dcfca5a7d3f3c336f0b5536fd',
    '2c451ddd887ee18071b59e4f0070e1acf166ce72d5bfddece8e4761600f117ae',
  ],
  9204: [
    'a7e1269f22a9abd9bb9fc761b2c38b0877206c109c70889c8929cc8d7ea7942f',
    '491871e9c1744505eecd17419b5d5c2550721ee2a8e07b7499e0f263ef0ba970',
    'c59e4da8daa3d6fdeecbf858903195c404f0db73ed551766e02dbb418fe8c7e5',
    '00e41ab86fe82418d9badc519a30cca6e0ec0e5b8bf53d349fb90f9a3205d03f',
    '17443128de91466348c2d6e2cfa088df0338046c28d30de5da4fbdbac83069f5',
    'bf5ee0a08ea773700b6f9f1197d9f9de913db26e321eb5639362d799e6e07434',
    'fa9b3ac2a7076576b63cbc8b9caef0b4ae45ff4a0d45dd5694a80163bee26a8d',
    'fa70898562718763c64b3bf95b70be2b6dc5e5d32b08047ae6af47d4d3a8c70d',
    '0753d093fe7f7e3cc01947e3fbc45106c04833e1dde2f1cd095b13fad51e279b',
    'f62a34926c648441f4e65075af7601de36dcf2bffbf537b7b1c3f6321cb95189',
  ],
  9205: [
    'e375a01587ab448f26da69df7154a77ca6d695580b122731b5d610ee92d696d0',
    'c1f2b12736950a9387397eab42ee18e6508349add6bf75ff4fc67d2e5e235eee',
    '8796651265d235032dc22328aa4f75b61a2d9a96190afadce4722e9e4182923d',
    '2da4a43722f38521f46bcea687f5e82a8ce55f991852055e56dae1ad1204bb44',
    '07b48b0393646d28b8fa7f30e080834f9affb7ad62bcd0439735838d12bd303b',
    '8d669f21a7b585dcd78ec8271f7ec9d87652c759c7f5299266d1c42fc98a3dd1',
    '13a291c602a6aba044501c139ddb6d8ab2a8a0c88b7432d5b0d2b56759a04bcd',
    'fb4610f9443f6e57b9d152e177632deb70c75859526c750583270eb00fc92095',
    '2c88771016c7d21e9938444ab734e764c603c1833fa7a139369bef020979d502',
    'f29fe93697981e0e981116d00a2a66511a46ea974348bff171069fb660fd247d',
  ],
  9206: [
    '0fe3c50197b9d1faa58d6e23ac634aded280f36ca2808111a69df07a5880fcfa',
    '7255c218daad095cb88af504c027a9e1a63aad5a05d25280c8e0b35a6ab58b71',
    '6ffa45ced5678f72cc3bc5391c2fc31e5b2b900b3b478b4edfe1be292969ae1a',
    'ba3931d7af5314c12e4953c54c3a784b013d748326822e980d00f4b131a5239b',
    '6c06c5864e1967e3606a39055618f97ea7b194d451e92ddca066a248613d4b81',
    '52794a51dcdc94ee40f82ea201efa3475b53c14b9234a0e340fa19d8477a2cdd',
    'b6eb91213f149f0d73151ce584281d693945524726c57830be433d6de355d1eb',
    'facfc02c8a9bebe413786f1c6af709d60371b215d563b4c1f145433dcf2bc249',
    'a1658912c14de08d024a464480f37b61e244a788367093ee0f815f16dae79751',
    '2c8e22ebd7ed17a272010060f8c6856832661f388a8ebcd98d525819fc45e13a',
  ],
};
const DORADO_F05_9201_2400 = '267053b8ab7e4f3daa82713124efbda2e226cd0b1b38c543234d0b3d1487fee3';

test('Inst puerta F05: ley activa == 3dc4fd6 sin reproLocal, 6x1200 + dia con drenaje', { timeout: 900000 }, () => {
  const mundoF05 = (seed: number): World => {
    const world = createWorld(seed);
    const base = paramsOf(world);
    setParams(world, parseParams({ ...base,
      poblacion: { ...base.poblacion, reproLocal: 0.5 },
      social: { ...base.social, radioConvivencia: 12 } }));
    return world;
  };
  const sinRonda = (world: World): string => {
    const clon = cloneWorld(world);
    (clon as unknown as Record<string, unknown>).reproLocal = undefined;
    return digestoCanonico(clon);
  };
  for (const seed of [9201, 9202, 9203, 9204, 9205, 9206]) {
    const world = mundoF05(seed);
    const inst = new InstrumentoReproLocal();
    const limite = seed === 9201 ? 2400 : 1200;
    for (let n = 1; n <= limite; n++) {
      stepWorld(world);
      inst.despuesDelPaso(world);
      if (n % 120 === 0 && n <= 1200) assert.equal(sinRonda(world), DORADOS_F05_3DC4FD6[seed]![n / 120 - 1], `semilla ${seed} tick ${n}`);
    }
    if (seed === 9201) {
      inst.metricasDia(world); // drena el sidecar: solo memoria del laboratorio
      assert.equal(sinRonda(world), DORADO_F05_9201_2400, 'semilla 9201 tick 2400 tras drenaje');
    }
  }
});
