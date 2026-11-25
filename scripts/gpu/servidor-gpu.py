#!/usr/bin/env python3
"""Un contexto CUDA por tarjeta. stdin/stdout llevan controles, fd 3 lleva datos."""
import argparse
import ctypes as C
import json
import mmap
import os
from pathlib import Path
import struct
import sys
from time import perf_counter


def enlace(lib, nombre, *tipos):
    funcion = getattr(lib, nombre)
    funcion.argtypes = tipos
    funcion.restype = C.c_int

    def llamar(*args):
        codigo = funcion(*args)
        if codigo:
            raise RuntimeError(f'{nombre}: {codigo}')

    return llamar


class Dispositivo:
    def __init__(self, indice, nvrtc):
        driver = C.CDLL('libcuda.so.1')
        p, d, z, u, i = C.c_void_p, C.c_uint64, C.c_size_t, C.c_uint, C.c_int
        enlace(driver, 'cuInit', u)(0)
        atributo = enlace(driver, 'cuDeviceGetAttribute', C.POINTER(i), i, i)
        mayor, menor = i(), i()
        atributo(C.byref(mayor), 75, indice)
        atributo(C.byref(menor), 76, indice)
        self.contexto = p()
        enlace(driver, 'cuCtxCreate_v2', C.POINTER(p), u, i)(C.byref(self.contexto), 0, indice)
        self.destruir = enlace(driver, 'cuCtxDestroy_v2', p)
        self.alojar = enlace(driver, 'cuMemAlloc_v2', C.POINTER(d), z)
        self.liberar = enlace(driver, 'cuMemFree_v2', d)
        self.subir = enlace(driver, 'cuMemcpyHtoD_v2', d, p, z)
        self.bajar = enlace(driver, 'cuMemcpyDtoH_v2', p, d, z)
        self.copiar = enlace(driver, 'cuMemcpyDtoD_v2', d, d, z)
        self.lanzar = enlace(driver, 'cuLaunchKernel', p, u, u, u, u, u, u, u, p, C.POINTER(p), p)
        self.sync = enlace(driver, 'cuCtxSynchronize')
        self.buffers = {}

        try:
            fuente = Path(__file__).with_name('percibir.cu').read_bytes()
            ptx = compilar(nvrtc, fuente, f'compute_{mayor.value}{menor.value}')
            modulo = p()
            enlace(driver, 'cuModuleLoadData', C.POINTER(p), p)(C.byref(modulo), ptx)
            funcion = enlace(driver, 'cuModuleGetFunction', C.POINTER(p), p, C.c_char_p)
            self.actualizar, self.percibir = p(), p()
            funcion(C.byref(self.actualizar), modulo, b'actualizar_percepcion')
            funcion(C.byref(self.percibir), modulo, b'percibir')
        except Exception:
            self.cerrar()
            raise

    def buffer(self, nombre, bytes_, conservar=False):
        puntero, capacidad = self.buffers.get(nombre, (None, 0))
        if capacidad >= max(1, bytes_):
            return puntero
        nuevo = C.c_uint64()
        tamano = max(1, bytes_)
        self.alojar(C.byref(nuevo), tamano)
        if puntero is not None:
            if conservar:
                self.copiar(nuevo, puntero, capacidad)
            self.liberar(puntero)
        self.buffers[nombre] = nuevo, tamano
        return nuevo

    def kernel(self, funcion, bloques, *argumentos):
        if bloques:
            argv = (C.c_void_p * len(argumentos))(*(C.addressof(arg) for arg in argumentos))
            self.lanzar(funcion, bloques, 1, 1, 256, 1, 1, 0, None, argv, None)

    def ejecutar(self, orden, mm):
        subida, bajada, salida = (orden[k] for k in ('subida', 'bajada', 'salida'))
        if not 0 <= subida <= salida <= salida + bajada <= len(mm):
            raise ValueError('Lote fuera del canal GPU.')
        lote = self.buffer('lote', subida)
        resultado = self.buffer('resultado', bajada)
        terreno = self.buffer('terreno', orden['terrenoBytes'], conservar=True)
        cerebro = self.buffer('cerebro', orden['cerebroBytes'], conservar=True)
        ocupantes = self.buffer('ocupantes', orden['organismosBytes'], conservar=True)
        direccion = C.addressof(C.c_ubyte.from_buffer(mm))
        inicio = perf_counter()
        self.subir(lote, direccion, subida)
        self.kernel(self.actualizar, orden['parches'], lote, terreno, cerebro, ocupantes)
        self.kernel(self.percibir, orden['n'], lote, resultado, terreno, cerebro, ocupantes)
        if bajada:
            self.bajar(direccion + salida, resultado, bajada)
        else:
            self.sync()
        return (perf_counter() - inicio) * 1000

    def cerrar(self):
        self.destruir(self.contexto)


def compilar(nvrtc, fuente, arquitectura):
    lib = C.CDLL(nvrtc, mode=C.RTLD_GLOBAL)
    p, z = C.c_void_p, C.c_size_t
    programa = p()
    enlace(lib, 'nvrtcCreateProgram', C.POINTER(p), C.c_char_p, C.c_char_p, C.c_int, p, p)(
        C.byref(programa), fuente, b'percibir.cu', 0, None, None)
    destruir = enlace(lib, 'nvrtcDestroyProgram', C.POINTER(p))
    opciones = (C.c_char_p * 2)(f'--gpu-architecture={arquitectura}'.encode(), b'--std=c++11')
    try:
        try:
            enlace(lib, 'nvrtcCompileProgram', p, C.c_int, C.POINTER(C.c_char_p))(programa, len(opciones), opciones)
        except RuntimeError as error:
            tamano = z()
            enlace(lib, 'nvrtcGetProgramLogSize', p, C.POINTER(z))(programa, C.byref(tamano))
            log = C.create_string_buffer(tamano.value)
            enlace(lib, 'nvrtcGetProgramLog', p, p)(programa, log)
            raise RuntimeError(log.value.decode()) from error
        tamano = z()
        enlace(lib, 'nvrtcGetPTXSize', p, C.POINTER(z))(programa, C.byref(tamano))
        ptx = C.create_string_buffer(tamano.value)
        enlace(lib, 'nvrtcGetPTX', p, p)(programa, ptx)
        return ptx
    finally:
        destruir(C.byref(programa))


def emitir(respuesta):
    datos = json.dumps(respuesta, separators=(',', ':')).encode()
    sys.stdout.buffer.write(struct.pack('<I', len(datos)) + datos)
    sys.stdout.buffer.flush()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', type=int, required=True)
    parser.add_argument('--nvrtc', required=True)
    parser.add_argument('--fd', type=int, required=True)
    args = parser.parse_args()
    mm = None
    gpu = Dispositivo(args.device, args.nvrtc)
    try:
        emitir({'listo': True})
        while cabecera := sys.stdin.buffer.read(4):
            (largo,) = struct.unpack('<I', cabecera)
            if largo > 4096:
                raise ValueError('Orden de control demasiado grande.')
            orden = json.loads(sys.stdin.buffer.read(largo))
            if orden['kind'] != 'percibir':
                raise ValueError('Orden GPU desconocida.')
            capacidad = os.fstat(args.fd).st_size
            if mm is None or len(mm) != capacidad:
                if mm is not None:
                    mm.close()
                mm = mmap.mmap(args.fd, capacidad)
            ms = gpu.ejecutar(orden, mm)
            # Eco del despacho: el motor descarta la respuesta que no sea la del lote que espera.
            emitir({'ok': True, 'ms': ms, 'tick': orden['tick'], 'despacho': orden['despacho']})
    finally:
        if mm is not None:
            mm.close()
        gpu.cerrar()


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, ValueError) as error:
        emitir({'error': str(error)[:360]})
