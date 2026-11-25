"""Orden de materia dentro del contexto CUDA del servidor de percepción."""
import ctypes as C
from struct import unpack_from

BYTES_ESPECIE = 128
BYTES_CANAL = 88
BYTES_TRIPLETA = 24
HILOS = 128


class MateriaKernel:
    def __init__(self, gpu):
        self.gpu = gpu
        self.paso, self.offsets, self.compactar = gpu.cargar(
            'materia.cu', b'materia', b'offsets_materia', b'compactar_materia')

    def ejecutar(self, orden, lote, destino, mm):
        gpu = self.gpu
        n, max_tripletas, cabecera, bajada = (orden[k] for k in ('n', 'maxTripletas', 'cabecera', 'bajada'))
        if n <= 0 or cabecera != (n + 2) // 2 * 8 or bajada != cabecera + max_tripletas * BYTES_TRIPLETA:
            raise ValueError('Dimensiones del despacho material inválidas.')
        especies = gpu.buffer('materia_especies', orden['nEspecies'] * BYTES_ESPECIE)
        canales = gpu.buffer('materia_canales', orden['nCanales'] * BYTES_CANAL)
        temporal = gpu.buffer('materia_temporal', max_tripletas * BYTES_TRIPLETA)
        cuentas = gpu.buffer('materia_cuentas', n * 4)
        desde = gpu.buffer('materia_offsets', cabecera)
        gpu.kernel(self.paso, (n + HILOS - 1) // HILOS, lote, C.c_uint(n), especies, canales, temporal, cuentas, hilos=HILOS)
        gpu.kernel(self.offsets, 1, cuentas, C.c_uint(n), desde, hilos=1)
        gpu.bajar(destino, desde, cabecera)
        (elementos,) = unpack_from('<I', mm, orden['salida'] + n * 4)
        if elementos % 3 or elementos // 3 > max_tripletas:
            raise RuntimeError('Longitud de tripletas inválida.')
        tripletas = elementos // 3
        if tripletas:
            bytes_ = tripletas * BYTES_TRIPLETA
            salida = gpu.buffer('resultado', bytes_)
            gpu.kernel(self.compactar, n, lote, temporal, desde, salida, hilos=HILOS)
            gpu.bajar(destino + cabecera, salida, bytes_)
        return tripletas
