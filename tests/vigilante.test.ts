/**
 * Carril 0D: el vigilante de systemd reinicia un mundo parado, pero no toca una unidad detenida
 * a propósito ni una que aún está cargando en frío. `systemctl` y `curl` son dobles en el PATH.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve('scripts/systemd/torre/vigilante.sh');

/** Un entorno aislado: el estado, el registro de reinicios y los dobles viven en un directorio temporal. */
function entorno(t: test.TestContext, { activa, haceSegundos }: { activa: boolean; haceSegundos: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'vigilante-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'), reinicios = join(dir, 'reinicios');
  const escribir = (nombre: string, cuerpo: string) => { const ruta = join(bin, nombre); writeFileSync(ruta, `#!/bin/sh\n${cuerpo}\n`); chmodSync(ruta, 0o755); };
  mkdirSync(bin);
  escribir('systemctl', `case "$*" in
  *is-active*) exit ${activa ? 0 : 3} ;;
  *show*) echo "@$(( $(date +%s) - ${haceSegundos} ))" ;;
  *restart*) echo "$*" >> "${reinicios}" ;;
esac`);
  escribir('curl', 'echo "$FAKE_CODIGO"; [ "$FAKE_CODIGO" != 000 ]');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: join(dir, 'estado'), ATLAS_VIGILANTE_ARRANQUE: '900' };
  const correr = (codigo: string) => spawnSync('sh', [SCRIPT], { env: { ...env, FAKE_CODIGO: codigo }, encoding: 'utf8' });
  const cuantosReinicios = () => existsSync(reinicios) ? readFileSync(reinicios, 'utf8').trim().split('\n').length : 0;
  return { correr, cuantosReinicios };
}

test('un 200 no reinicia nada y borra la cuenta de consultas sin respuesta', t => {
  const { correr, cuantosReinicios } = entorno(t, { activa: true, haceSegundos: 5000 });
  correr('000'); correr('000'); correr('200'); correr('000'); correr('000');
  assert.equal(cuantosReinicios(), 0, 'la cuenta volvió a cero con el 200');
});

test('un 503 reinicia al momento y tres consultas sin respuesta, a la tercera', t => {
  const { correr, cuantosReinicios } = entorno(t, { activa: true, haceSegundos: 5000 });
  correr('503');
  assert.equal(cuantosReinicios(), 1);
  correr('000'); correr('000');
  assert.equal(cuantosReinicios(), 1);
  correr('000');
  assert.equal(cuantosReinicios(), 2);
});

test('una unidad detenida a propósito no se reinicia, aunque no responda', t => {
  const { correr, cuantosReinicios } = entorno(t, { activa: false, haceSegundos: 5000 });
  for (let i = 0; i < 5; i++) correr('000');
  correr('503');
  assert.equal(cuantosReinicios(), 0);
});

test('durante la carga en frío no se cuenta nada; pasado el plazo, una unidad muda se reinicia', t => {
  const cargando = entorno(t, { activa: true, haceSegundos: 240 });
  for (let i = 0; i < 6; i++) cargando.correr('000');
  cargando.correr('503');
  assert.equal(cargando.cuantosReinicios(), 0, 'cuatro minutos de carga no son un fallo');
  const colgada = entorno(t, { activa: true, haceSegundos: 1200 });
  for (let i = 0; i < 3; i++) colgada.correr('000');
  assert.equal(colgada.cuantosReinicios(), 1, 'a los veinte minutos sin responder ya sí');
});
