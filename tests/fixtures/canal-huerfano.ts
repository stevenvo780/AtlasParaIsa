// Abre un canal con el servidor de prueba, publica su pid y muere sin cerrar nada, como un motor que cae.
import { fileURLToPath } from 'node:url';
import { CanalCompartido } from '../../src/world/gpu/canal.js';

const canal = new CanalCompartido(0, {
  script: fileURLToPath(new URL('./fallo-gpu-percibir.py', import.meta.url)),
  entorno: { ...process.env, CARTA_GPU_PRUEBA_FASE: 'canal', CARTA_GPU_PRUEBA_MARCA: '/dev/null' },
});
canal.iniciar(30_000);
process.stdout.write(`${canal.pid}\n`, () => process.kill(process.pid, 'SIGKILL'));
