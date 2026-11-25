"""Servidor del protocolo M3 para matar el proceso sin CUDA ni esperas aleatorias."""
import argparse
import json
import mmap
import os
from pathlib import Path
import signal
import struct
import sys


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
    fase = os.environ['CARTA_GPU_PRUEBA_FASE']
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
            matar('entrada-leida')
            zona[salida:salida + min(bajada, 4)] = b'\xba' * min(bajada, 4)
            matar('salida-parcial')
            zona[salida:salida + bajada] = b'\xbd' * bajada
            matar('antes-de-confirmar')
            if fase == 'plazo':
                marca.write_text(fase)
                sys.stdin.buffer.read(1)


if __name__ == '__main__':
    main()
