"""Orden de materia dentro del contexto CUDA del servidor de percepción."""
import ctypes as C
from time import perf_counter

BYTES_ESPECIE = 128
BYTES_CANAL = 88
BYTES_TRIPLETA = 24
PAGINA = 4096
HILOS = 128
LOTES_COMPACTADOS = HILOS // 32

memcmp = C.CDLL(None).memcmp
memcmp.argtypes = C.c_void_p, C.c_void_p, C.c_size_t
memcmp.restype = C.c_int


class MateriaKernel:
    def __init__(self, gpu):
        self.gpu = gpu
        self.perfil_arranque = {}
        self.paso, self.offsets, self.compactar = gpu.cargar(
            'materia.cu', b'materia', b'offsets_materia', b'compactar_materia', perfil=self.perfil_arranque)
        self.flujo = C.c_void_p()
        gpu.crear_flujo(C.byref(self.flujo), 1)  # CU_STREAM_NON_BLOCKING
        self.host = {}
        self.eventos = []
        self.lote = None
        self.vistos = 0

    def fijar(self, nombre, bytes_):
        puntero, capacidad = self.host.get(nombre, (0, 0))
        if capacidad >= bytes_:
            return puntero
        nuevo = C.c_void_p()
        tamano = max(bytes_, capacidad * 3 // 2)
        self.gpu.fijar_host(C.byref(nuevo), tamano)
        if puntero:
            self.gpu.soltar_host(puntero)
        self.host[nombre] = nuevo.value, tamano
        return nuevo.value

    def cambios(self, origen, fijado, bytes_):
        if not self.vistos:
            return [(0, bytes_)]
        cambios = []
        inicio = None
        for off in range(0, bytes_, PAGINA):
            fin = min(off + PAGINA, bytes_)
            if fin > self.vistos or memcmp(origen + off, fijado + off, fin - off):
                if inicio is None:
                    inicio = off
            elif inicio is not None:
                cambios.append((inicio, off))
                inicio = None
        if inicio is not None:
            cambios.append((inicio, bytes_))
        return cambios

    def ejecutar(self, orden, direccion, inicio):
        gpu, flujo = self.gpu, self.flujo
        n, max_tripletas, cabecera, bajada = (orden[k] for k in ('n', 'maxTripletas', 'cabecera', 'bajada'))
        if n <= 0 or max_tripletas <= 0 or cabecera != (n + 2) // 2 * 8 or bajada != cabecera + max_tripletas * BYTES_TRIPLETA:
            raise ValueError('Dimensiones del despacho material inválidas.')
        subida, destino = orden['subida'], direccion + orden['salida']
        if subida <= 0:
            raise ValueError('Entrada del despacho material vacía.')

        lote = gpu.buffer('materia_lote', subida, crecer=True)
        entrada_anterior = self.host.get('entrada')
        entrada = self.fijar('entrada', subida)
        if lote is not self.lote or self.host['entrada'] is not entrada_anterior:
            self.lote = lote
            self.vistos = 0
        cambios = self.cambios(direccion, entrada, subida)
        especies = gpu.buffer('materia_especies', orden['nEspecies'] * BYTES_ESPECIE, crecer=True)
        canales = gpu.buffer('materia_canales', orden['nCanales'] * BYTES_CANAL, crecer=True)
        temporal = gpu.buffer('materia_temporal', max_tripletas * BYTES_TRIPLETA, crecer=True)
        cuentas = gpu.buffer('materia_cuentas', n * 4, crecer=True)
        desde = gpu.buffer('materia_offsets', cabecera, crecer=True)
        salida = gpu.buffer('materia_salida', max_tripletas * BYTES_TRIPLETA, crecer=True)
        indices = self.fijar('indices', cabecera)

        perfil = orden.get('perfil')
        if perfil and not self.eventos:
            for _ in range(6):
                evento = C.c_void_p()
                gpu.crear_evento(C.byref(evento), 0)
                self.eventos.append(evento)

        def marcar(i):
            if perfil:
                gpu.grabar_evento(self.eventos[i], flujo)

        def ms(a, b):
            tiempo = C.c_float()
            gpu.elapsed(C.byref(tiempo), self.eventos[a], self.eventos[b])
            return tiempo.value

        for a, b in cambios:
            C.memmove(entrada + a, direccion + a, b - a)
        marcar(0)
        bytes_h2d = 0
        for a, b in cambios:
            gpu.subir_async(lote.value + a, entrada + a, b - a, flujo)
            bytes_h2d += b - a
        marcar(1)

        lanzar = perf_counter()
        gpu.kernel(self.paso, (n + HILOS - 1) // HILOS, lote, C.c_uint(n), especies, canales,
                   temporal, cuentas, hilos=HILOS, flujo=flujo)
        gpu.kernel(self.offsets, 1, cuentas, C.c_uint(n), desde, hilos=1, flujo=flujo)
        gpu.kernel(self.compactar, (n + LOTES_COMPACTADOS - 1) // LOTES_COMPACTADOS,
                   lote, C.c_uint(n), temporal, desde, salida, C.c_uint(max_tripletas), hilos=HILOS, flujo=flujo)
        lanzado = perf_counter() - lanzar
        marcar(2)
        gpu.bajar_async(indices, desde, cabecera, flujo)
        marcar(3)
        sincronizar = perf_counter()
        gpu.esperar_flujo(flujo)
        sincronizado = perf_counter() - sincronizar

        elementos = C.c_uint32.from_address(indices + n * 4).value
        if elementos % 3 or elementos // 3 > max_tripletas:
            raise RuntimeError('Longitud de tripletas inválida.')
        tripletas = elementos // 3
        bytes_ = tripletas * BYTES_TRIPLETA
        if bytes_:
            datos = self.fijar('datos', bytes_)
            marcar(4)
            gpu.bajar_async(datos, salida, bytes_, flujo)
            marcar(5)
        C.memmove(destino, indices, cabecera)
        if bytes_:
            sincronizar = perf_counter()
            gpu.esperar_flujo(flujo)
            sincronizado += perf_counter() - sincronizar
            C.memmove(destino + cabecera, datos, bytes_)
        self.vistos = subida
        resultado = {'tripletas': tripletas, 'ms': (perf_counter() - inicio) * 1000}
        if perfil:
            resultado.update(msH2D=ms(0, 1) if bytes_h2d else 0, msKernel=ms(1, 2),
                             msD2H=ms(2, 3) + (ms(4, 5) if bytes_ else 0), msLanzar=lanzado * 1000,
                             msSincronizar=sincronizado * 1000, bytesH2D=bytes_h2d, bytesD2H=cabecera + bytes_)
        return resultado

    def cerrar(self):
        try:
            self.gpu.esperar_flujo(self.flujo)
        finally:
            for puntero, _ in self.host.values():
                self.gpu.soltar_host(puntero)
