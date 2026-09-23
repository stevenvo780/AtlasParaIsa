// Puente TCP de la torre al servidor público del portátil (2026-09-23): el proxy del dominio sigue apuntando a
// 100.64.0.1:3000 (torre) y este reenvío lo lleva a 100.64.0.2:3000 (portátil, tailnet). TCP puro: Host, Origin,
// cookies y WebSocket pasan intactos. Sin dependencias; lo arranca atlas-puente.service.
import net from 'node:net';

const [LISTEN_HOST, LISTEN_PORT] = [process.env.PUENTE_ESCUCHA ?? '100.64.0.1', Number(process.env.PUENTE_PUERTO ?? 3000)];
const [UP_HOST, UP_PORT] = [process.env.PUENTE_DESTINO ?? '100.64.0.2', Number(process.env.PUENTE_DESTINO_PUERTO ?? 3000)];

const server = net.createServer(cliente => {
  const destino = net.connect(UP_PORT, UP_HOST);
  const cerrar = () => { cliente.destroy(); destino.destroy(); };
  cliente.on('error', cerrar); destino.on('error', cerrar);
  cliente.on('close', cerrar); destino.on('close', cerrar);
  cliente.pipe(destino); destino.pipe(cliente);
});
server.on('error', error => { console.error(`puente: ${error.message}`); process.exit(1); });
server.listen(LISTEN_PORT, LISTEN_HOST, () => console.log(`puente ${LISTEN_HOST}:${LISTEN_PORT} → ${UP_HOST}:${UP_PORT}`));
