#!/usr/bin/env python3
"""Reenvío TCP transparente 0.0.0.0:<escucha> → 127.0.0.1:<destino> (para exponer en LAN una
instancia de laboratorio que sólo escucha en loopback). Sin inspección, WebSocket incluido."""
import asyncio, sys

LISTEN, TARGET = int(sys.argv[1]), int(sys.argv[2])

async def pipe(r, w):
    try:
        while True:
            data = await r.read(65536)
            if not data: break
            w.write(data); await w.drain()
    except Exception: pass
    finally:
        try: w.close()
        except Exception: pass

async def handle(reader, writer):
    try: tr, tw = await asyncio.open_connection('127.0.0.1', TARGET)
    except Exception: writer.close(); return
    await asyncio.gather(pipe(reader, tw), pipe(tr, writer))

async def main():
    server = await asyncio.start_server(handle, '0.0.0.0', LISTEN)
    async with server: await server.serve_forever()

asyncio.run(main())
