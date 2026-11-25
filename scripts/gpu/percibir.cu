// ABI de percibir-gpu.ts. NVRTC compila sin dependencias de headers del host.
using u32 = unsigned int;
using u64 = unsigned long long;
using byte = unsigned char;

constexpr int RADIO = 7;
constexpr int LADO = 2 * RADIO + 1;
constexpr int CELDAS = LADO * LADO;
constexpr int CENTRO = RADIO * LADO + RADIO;
constexpr int ENTRADAS = 12, OCULTAS = 8, ACCIONES = 12, RASGOS = 8;
constexpr int B1 = ENTRADAS * OCULTAS, W2 = B1 + OCULTAS, B2 = W2 + ACCIONES * OCULTAS;
constexpr int PESOS = B2 + ACCIONES, HILOS = 256, WARPS = HILOS / 32;
constexpr u32 MASCARA_WARP = 0xffffffffu, NO_ENCONTRADO = 0xffffffffu;

struct Cabecera {
    u32 n, q, v, a;
    u32 actores, planes, indices, organismosN, rejilla, rejillaMask, anchoFila, nCampos;
    u32 parches, parchesN, terrenoBytes, cerebroBytes;
};
struct Actor { u32 slot, plan; float x, y; int paginas[4]; u32 reservado; };
struct Plan { u32 transitable, transitablesN, celdas, celdasN, organismos, organismosN, acciones, w; };
struct ConsultaCelda { u32 terminos, terminosN, filtros, filtrosN; float pesoDist, pesoPasos; u32 alcanzable; };
struct ConsultaOrg { float radio; u32 clase, filtros, filtrosN, criterio, columna; };
struct Termino { u32 campo; float peso; };
struct Filtro { u32 indice; float minimo, maximo; };
struct CeldaCsr { double x, y; u32 inicio, cantidad; };
struct Organismo { u32 slot, gen; float x, y; u32 clase, reservado; };
struct Parche { u32 destino, offset, fuente, palabras; };

static_assert(sizeof(Cabecera) == 64 && sizeof(Actor) == 36 && sizeof(Plan) == 32, "ABI lote");
static_assert(sizeof(ConsultaCelda) == 28 && sizeof(ConsultaOrg) == 24 && sizeof(Filtro) == 12 && sizeof(Termino) == 8, "ABI consultas");
static_assert(sizeof(CeldaCsr) == 24 && sizeof(Organismo) == 24 && sizeof(Parche) == 16, "ABI rejilla y parches");

template<typename T> __device__ inline const T* en(const byte* datos, u32 inicio) {
    return reinterpret_cast<const T*>(datos + inicio);
}

extern "C" __global__ void actualizar_percepcion(const byte* lote, byte* terreno, byte* cerebro, byte* ocupantes) {
    const Cabecera& cab = *en<Cabecera>(lote, 0);
    const Parche p = en<Parche>(lote, cab.parches)[blockIdx.x];
    const u32* fuente = en<u32>(lote, p.fuente);
    byte* espejo = p.destino == 0 ? terreno : p.destino == 1 ? cerebro : ocupantes;
    u32* destino = reinterpret_cast<u32*>(espejo + p.offset);
    for (u32 i = threadIdx.x; i < p.palabras; i += blockDim.x) destino[i] = fuente[i];
}

__device__ inline double valorTerreno(const double* campos, u32 anchoPagina, int celda, u32 campo) {
    return campos[(static_cast<u64>(celda >> 8) * anchoPagina + campo) * 256 + (celda & 255)];
}

__device__ inline bool filtrosCelda(const Filtro* filtros, u32 n, const double* campos, u32 anchoPagina, int celda) {
    for (u32 i = 0; i < n; ++i) {
        const Filtro f = filtros[i];
        const double valor = valorTerreno(campos, anchoPagina, celda, f.indice);
        if (!(valor >= static_cast<double>(f.minimo) && valor <= static_cast<double>(f.maximo))) return false;
    }
    return true;
}

// Una fila de la ventana por carril. Una expansión de los cuatro vecinos por nivel de distancia.
__device__ void bfs(int* pasos, int carril) {
    unsigned transitables = 0;
    if (carril < LADO) {
        for (int x = 0; x < LADO; ++x) {
            if (pasos[carril * LADO + x] == -2) transitables |= 1u << x;
        }
    }
    unsigned frontera = carril == RADIO ? 1u << RADIO : 0;
    transitables &= ~frontera;
    if (carril == RADIO) pasos[CENTRO] = 0;
    for (int nivel = 1;; ++nivel) {
        const unsigned arriba = __shfl_up_sync(MASCARA_WARP, frontera, 1);
        const unsigned abajo = __shfl_down_sync(MASCARA_WARP, frontera, 1);
        const unsigned vecinas = (frontera << 1) | (frontera >> 1)
            | (carril == 0 ? 0 : arriba) | (carril >= LADO - 1 ? 0 : abajo);
        frontera = vecinas & transitables;
        if (!__any_sync(MASCARA_WARP, frontera != 0)) break;
        transitables &= ~frontera;
        unsigned nuevas = frontera;
        while (nuevas) {
            const int x = __ffs(nuevas) - 1;
            pasos[carril * LADO + x] = nivel;
            nuevas &= nuevas - 1;
        }
    }
}

__device__ inline bool mejorCelda(float valor, u32 local, float minimo, u32 elegido) {
    return valor < minimo || (valor == minimo && local < elegido);
}

__device__ void consultarCelda(const byte* lote, const ConsultaCelda& c, const double* terreno,
    u32 nCampos, const int* celdas, const int* rutas, float fraccionX, float fraccionY, int carril,
    int* celda, float* valor, short* pasos) {
    const Termino* terminos = en<Termino>(lote, c.terminos);
    const Filtro* filtros = en<Filtro>(lote, c.filtros);
    float minimo = __int_as_float(0x7f800000);
    u32 elegido = NO_ENCONTRADO;
    for (int i = carril; i < CELDAS; i += 32) {
        const int candidata = celdas[i], ruta = rutas[i];
        if (candidata < 0 || (c.alcanzable && ruta < 0) || !filtrosCelda(filtros, c.filtrosN, terreno, nCampos, candidata)) continue;
        const float dx = i % LADO - RADIO - fraccionX, dy = i / LADO - RADIO - fraccionY;
        const float distancia = sqrtf(dx * dx + dy * dy);
        float suma = c.pesoDist * distancia + c.pesoPasos * (ruta < 0 ? 0 : ruta);
        for (u32 k = 0; k < c.terminosN; ++k) {
            const Termino t = terminos[k];
            suma += t.peso * static_cast<float>(valorTerreno(terreno, nCampos, candidata, t.campo));
        }
        if (suma < minimo || (elegido != NO_ENCONTRADO && mejorCelda(suma, i, minimo, elegido))) {
            minimo = suma;
            elegido = i;
        }
    }
    for (int salto = 16; salto; salto >>= 1) {
        const float otroMin = __shfl_down_sync(MASCARA_WARP, minimo, salto);
        const u32 otro = __shfl_down_sync(MASCARA_WARP, elegido, salto);
        if (mejorCelda(otroMin, otro, minimo, elegido)) { minimo = otroMin; elegido = otro; }
    }
    if (carril == 0) {
        *celda = elegido == NO_ENCONTRADO ? -1 : celdas[elegido];
        *pasos = elegido == NO_ENCONTRADO || rutas[elegido] < 0 ? -1 : rutas[elegido];
        *valor = minimo;
    }
}

__device__ inline u32 hashCelda(double x, double y) {
    const u32 h = static_cast<u32>(static_cast<long long>(x)) * 0x9e3779b1u
        ^ static_cast<u32>(static_cast<long long>(y)) * 0x85ebca77u;
    return h ^ (h >> 16);
}

__device__ inline CeldaCsr celdaCsr(const CeldaCsr* rejilla, u32 mascara, double x, double y) {
    for (u32 i = hashCelda(x, y) & mascara;; i = (i + 1) & mascara) {
        const CeldaCsr c = rejilla[i];
        if (c.inicio == NO_ENCONTRADO || (c.x == x && c.y == y)) return c;
    }
}

struct CandidatoOrg { double valor; u32 fila, slot; };

__device__ inline bool mejorOrganismo(const CandidatoOrg& a, const CandidatoOrg& b) {
    return a.valor < b.valor || (a.valor == b.valor && a.slot < b.slot);
}

__device__ void probarOrganismo(const Actor& a, const ConsultaOrg& consulta, const Filtro* filtros,
    const byte* ocupantes, u32 anchoFila, u32 fila, double radio2, CandidatoOrg& mejor) {
    const byte* filaOrganismo = ocupantes + static_cast<u64>(fila) * anchoFila;
    const Organismo& o = *en<Organismo>(filaOrganismo, 0);
    if (o.clase == 0 || a.slot == o.slot || (consulta.clase != 0 && consulta.clase != o.clase)) return;
    const double dx = static_cast<double>(a.x) - o.x, dy = static_cast<double>(a.y) - o.y;
    // El borde es inclusivo. La frontera usa la misma multiplicación y suma de la referencia.
    const double distancia2 = __dadd_rn(__dmul_rn(dx, dx), __dmul_rn(dy, dy));
    if (!(distancia2 <= radio2)) return;
    const double* columnas = en<double>(filaOrganismo, sizeof(Organismo));
    for (u32 i = 0; i < consulta.filtrosN; ++i) {
        const Filtro f = filtros[i];
        const double v = columnas[f.indice];
        if (!(v >= static_cast<double>(f.minimo) && v <= static_cast<double>(f.maximo))) return;
    }
    const double valor = consulta.criterio == 0 ? distancia2 : -columnas[consulta.columna];
    const CandidatoOrg candidato{valor, fila, o.slot};
    if (mejorOrganismo(candidato, mejor)) mejor = candidato;
}

__device__ void consultarOrganismo(const byte* lote, const byte* ocupantes, const Cabecera& cab, const Actor& actor,
    const ConsultaOrg& c, int carril, double* resultado) {
    const u32 n = cab.organismosN;
    const u32 anchoFila = cab.anchoFila;
    const CeldaCsr* rejilla = en<CeldaCsr>(ocupantes, cab.rejilla);
    const u32* indices = en<u32>(ocupantes, cab.indices);
    const Filtro* filtros = en<Filtro>(lote, c.filtros);
    const double x = actor.x, y = actor.y, radio = c.radio, radio2 = radio * radio;
    const double minX = floor(x - radio), minY = floor(y - radio);
    const double ancho = floor(x + radio) - minX + 1, alto = floor(y + radio) - minY + 1;
    CandidatoOrg mejor{__longlong_as_double(0x7ff0000000000000LL), NO_ENCONTRADO, NO_ENCONTRADO};
    if (ancho * alto > static_cast<double>(n) * 8) {
        for (u32 i = carril; i < n; i += 32) probarOrganismo(actor, c, filtros, ocupantes, anchoFila, i, radio2, mejor);
    } else {
        const u64 cantidad = static_cast<u64>(ancho * alto), w = static_cast<u64>(ancho);
        for (u64 i = carril; i < cantidad; i += 32) {
            const CeldaCsr celda = celdaCsr(rejilla, cab.rejillaMask, minX + i % w, minY + i / w);
            if (celda.inicio == NO_ENCONTRADO) continue;
            for (u32 j = 0; j < celda.cantidad; ++j) {
                probarOrganismo(actor, c, filtros, ocupantes, anchoFila, indices[celda.inicio + j], radio2, mejor);
            }
        }
    }
    for (int salto = 16; salto; salto >>= 1) {
        const CandidatoOrg otro{__shfl_down_sync(MASCARA_WARP, mejor.valor, salto),
            __shfl_down_sync(MASCARA_WARP, mejor.fila, salto), __shfl_down_sync(MASCARA_WARP, mejor.slot, salto)};
        if (mejorOrganismo(otro, mejor)) mejor = otro;
    }
    if (carril == 0) {
        const byte* fila = ocupantes + static_cast<u64>(mejor.fila) * anchoFila;
        *resultado = mejor.fila == NO_ENCONTRADO ? -1.0 : static_cast<double>(en<Organismo>(fila, 0)->gen) * 4294967296.0 + mejor.slot;
    }
}

__device__ inline float softSign(float x) { return x / (1.0f + fabsf(x)); }

extern "C" __global__ __launch_bounds__(HILOS) void percibir(const byte* lote, byte* resultado,
    const byte* terreno, const byte* cerebro, const byte* ocupantes) {
    const Cabecera& cab = *en<Cabecera>(lote, 0);
    const u32 fila = blockIdx.x;
    const Actor& actor = en<Actor>(lote, cab.actores)[fila];
    const Plan& plan = en<Plan>(lote, cab.planes)[actor.plan];
    const int hilo = threadIdx.x, warp = hilo >> 5, carril = hilo & 31;
    const double* campos = reinterpret_cast<const double*>(terreno);
    const float fraccionX = actor.x - floorf(actor.x), fraccionY = actor.y - floorf(actor.y);
    __shared__ int celdas[CELDAS], pasos[CELDAS];
    __shared__ float ocultas[OCULTAS];

    if (plan.celdasN > 0) {
        if (hilo < CELDAS) {
            const int dx = hilo % LADO - RADIO, dy = hilo / LADO - RADIO;
            int celda = -1;
            if (dx * dx + dy * dy <= RADIO * RADIO) {
                const int x = ((static_cast<long long>(floorf(actor.x)) - RADIO) & 15) + hilo % LADO;
                const int y = ((static_cast<long long>(floorf(actor.y)) - RADIO) & 15) + hilo / LADO;
                const int pagina = actor.paginas[(y >> 4) * 2 + (x >> 4)];
                if (pagina >= 0) celda = pagina * 256 + (y & 15) * 16 + (x & 15);
            }
            celdas[hilo] = celda;
            pasos[hilo] = celda >= 0 && filtrosCelda(en<Filtro>(lote, plan.transitable), plan.transitablesN, campos, cab.nCampos, celda) ? -2 : -1;
        }
        __syncthreads();
        if (warp == 0) bfs(pasos, carril);
        __syncthreads();
    }

    const u64 elementos = static_cast<u64>(cab.n) * cab.q;
    const u64 offOrganismo = (elementos * 10 + 7) & ~7ULL;
    if (fila == 0 && static_cast<u64>(hilo) < offOrganismo - elementos * 10) resultado[elementos * 10 + hilo] = 0;
    int* salidaCelda = reinterpret_cast<int*>(resultado) + static_cast<u64>(fila) * cab.q;
    float* salidaValor = reinterpret_cast<float*>(resultado + elementos * 4) + static_cast<u64>(fila) * cab.q;
    short* salidaPasos = reinterpret_cast<short*>(resultado + elementos * 8) + static_cast<u64>(fila) * cab.q;
    double* salidaOrganismo = reinterpret_cast<double*>(resultado + offOrganismo) + static_cast<u64>(fila) * cab.v;
    float* salidaUtilidad = reinterpret_cast<float*>(resultado + offOrganismo + static_cast<u64>(cab.n) * cab.v * 8)
        + static_cast<u64>(fila) * cab.a;

    // Un warp por consulta. Los sobrantes mantienen las dimensiones del lote completo.
    for (u32 i = warp; i < cab.q + cab.v; i += WARPS) {
        if (i < cab.q) {
            if (i < plan.celdasN) {
                consultarCelda(lote, en<ConsultaCelda>(lote, plan.celdas)[i], campos, cab.nCampos, celdas, pasos,
                    fraccionX, fraccionY, carril, salidaCelda + i, salidaValor + i, salidaPasos + i);
            } else if (carril == 0) {
                salidaCelda[i] = -1;
                salidaValor[i] = __int_as_float(0x7f800000);
                salidaPasos[i] = -1;
            }
        } else {
            const u32 j = i - cab.q;
            if (j < plan.organismosN && cab.organismosN > 0) {
                consultarOrganismo(lote, ocupantes, cab, actor, en<ConsultaOrg>(lote, plan.organismos)[j], carril, salidaOrganismo + j);
            } else if (carril == 0) salidaOrganismo[j] = -1.0;
        }
    }

    if (warp == 0) {
        if (!plan.acciones) {
            if (carril < cab.a) salidaUtilidad[carril] = 0;
            return;
        }
        const float* politica = reinterpret_cast<const float*>(cerebro) + static_cast<u64>(actor.slot) * (PESOS + ENTRADAS + ACCIONES + RASGOS);
        const float* observacion = politica + PESOS;
        const float* sesgo = observacion + ENTRADAS, *rasgos = sesgo + ACCIONES;
        if (carril < OCULTAS) {
            float suma = politica[B1 + carril];
            for (int j = 0; j < ENTRADAS; ++j) suma += observacion[j] * politica[carril * ENTRADAS + j];
            ocultas[carril] = softSign(suma);
        }
        __syncwarp();
        if (carril < ACCIONES) {
            float suma = politica[B2 + carril];
            for (int j = 0; j < OCULTAS; ++j) suma += ocultas[j] * politica[W2 + carril * OCULTAS + j];
            // La plasticidad va dentro de la última activación, como en evaluateRow (politica.ts) y en el contrato.
            suma = softSign(suma + sesgo[carril]);
            if (plan.w) {
                const float* w = en<float>(lote, plan.w) + carril * RASGOS;
                for (int j = 0; j < RASGOS; ++j) suma += w[j] * rasgos[j];
            }
            salidaUtilidad[carril] = suma;
        }
    }
}
