"""Servidor del protocolo M3 para matar el proceso sin CUDA ni esperas aleatorias."""
import argparse
import json
import mmap
import os
from pathlib import Path
import signal
import struct
import sys
import time


def emitir(dato):
    datos = json.dumps(dato).encode()
    sys.stdout.buffer.write(struct.pack('<I', len(datos)) + datos)
    sys.stdout.buffer.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--device', type=int, required=True)
    parser.add_argument('--nvrtc', required=True)
    parser.add_argument('--fd', type=int, required=True)
    args = parser.parse_args()
    fase = os.environ.get(f'CARTA_GPU_PRUEBA_FASE_GPU{args.device}', os.environ['CARTA_GPU_PRUEBA_FASE'])
    marca = Path(os.environ['CARTA_GPU_PRUEBA_MARCA'])

    def matar(nombre):
        if fase == nombre:
            marca.write_text(nombre)
            os.kill(os.getpid(), signal.SIGKILL)

    matar('arranque')
    emitir({'listo': True})
    while cabecera := sys.stdin.buffer.read(4):
        matar('antes-de-leer')
        largo = struct.unpack('<I', cabecera)[0]
        orden = json.loads(sys.stdin.buffer.read(largo))
        with mmap.mmap(args.fd, os.fstat(args.fd).st_size) as zona:
            if fase == 'canal':
                desde = orden['desde']
                valor = struct.unpack_from('<I', zona, desde)[0]
                struct.pack_into('<I', zona, desde, valor + 1)
                emitir({'valor': valor})
                continue
            assert orden['kind'] == 'percibir'
            subida, bajada, salida = (orden[k] for k in ('subida', 'bajada', 'salida'))
            assert 0 < subida <= salida <= salida + bajada <= len(zona)
            assert bajada > 0 and any(zona[:subida])
            if fase.startswith('broker'):
                if fase == 'broker-expira':
                    time.sleep(0.1)
                if fase == 'broker-retiene' and orden['dueno'] == 8:
                    marca.touch()
                    while not marca.with_suffix('.libre').exists():
                        time.sleep(0.001)
                if fase == 'broker-retiene' and orden['dueno'] == 17:
                    parches, total = struct.unpack_from('<2I', zona, 12 * 4)
                    # El primer paquete de este dueño expiró en cola. El nuevo debe traer los pesos completos.
                    assert any(
                        destino == 1 and palabras >= 212 and struct.unpack_from('<f', zona, fuente)[0] == 0.25
                        for destino, _, fuente, palabras in struct.iter_unpack('<4I', zona[parches:parches + total * 16])
                    )
                ventanas = orden['n'] * 225
                inicio = salida + bajada - ventanas
                if fase in ('broker-valido', 'broker-retiene'):
                    n, q, v, _ = struct.unpack_from('<4I', zona)
                    zona[salida:inicio] = bytes(inicio - salida)
                    zona[salida:salida + n * q * 4] = b'\xff' * (n * q * 4)
                    refs = salida + ((n * q * 10 + 7) // 8) * 8
                    zona[refs:refs + n * v * 8] = struct.pack('<d', -1) * (n * v)
                zona[inicio:salida + bajada] = b'\xff' * ventanas
                for fila in range(orden['n']):
                    zona[inicio + fila * 225 + 112] = 253
                eco = {k: orden[k] for k in ('generacion', 'epoca', 'dueno', 'tick', 'despacho')}
                if fase == 'broker-rancio':
                    eco['generacion'] -= 1
                emitir({'ok': True, 'ms': 1, **eco})
                continue
            matar('entrada-leida')
            zona[salida:salida + min(bajada, 4)] = b'\xba' * min(bajada, 4)
            matar('salida-parcial')
            zona[salida:salida + bajada] = b'\xbd' * bajada
            matar('antes-de-confirmar')
            if fase == 'plazo':
                marca.write_text(fase)
                sys.stdin.buffer.read(1)
            if fase == 'eco':
                # Una salida completa con el eco de otro despacho: el motor debe rechazarla.
                marca.write_text(fase)
                emitir({'ok': True, 'ms': 0, 'tick': orden['tick'], 'despacho': orden['despacho'] + 1})


if __name__ == '__main__':
    main()
