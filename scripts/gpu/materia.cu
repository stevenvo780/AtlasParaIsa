// ABI de materia-gpu.ts. Los dos espacios de trabajo se dimensionan con la tanda.
using u32 = unsigned int;
using u64 = unsigned long long;
using byte = unsigned char;

constexpr double AGOTADO = 1.0 / 1024;
constexpr double SUBPASO = 0.5, INSTANTANEO = 64.0, VARIABLE = 1.0 / 64;
constexpr int SUBPASOS_MAX = 200;
constexpr double VARIANZA_NORMAL = 100.0;

struct Cabecera { double dt, R, capacidad, nu, entropia, epsilon, atmosfera; u32 especies, reacciones, terminos, pases; };
struct Lote { double calor, kappa[4]; u32 composicion, n, canales, m, nivel, semilla; };
struct Especie { double atomos, ebullicion, condensado; u32 id, molecula; };
struct Reaccion { double dH, ea; u32 a, b, nivel; int catalisis; u32 pares, terminos, entradas, salidas; };
struct Termino { u32 especie, nu; };
struct Composicion { double cuantos; u32 especie; };
struct Canal { int i, j; u32 reaccion; };
struct Tripleta { double a, b, veces; };

struct EstadoEspecie {
    double existencia, nuevos, producidos, cant, x, medio;
    double H, L, L0, gastoLineal, gastoAa, demanda, reparto;
    int usos, aa, primero, ultimo;
    bool rapido;
};
struct EstadoCanal {
    double tasa, li, lj, li0, lj0, ext, xi, veces, pedidas;
    int p, q, siguiente;
};
static_assert(sizeof(Cabecera) == 72 && sizeof(Lote) == 64 && sizeof(Especie) == 32, "ABI de lotes");
static_assert(sizeof(Reaccion) == 48 && sizeof(Termino) == 8 && sizeof(Composicion) == 16 && sizeof(Canal) == 12, "ABI de tabla");
static_assert(sizeof(EstadoEspecie) == 128 && sizeof(EstadoCanal) == 88 && sizeof(Tripleta) == 24, "ABI de calculo");

template<typename T> __device__ inline const T* en(const byte* datos, u32 inicio) {
    return reinterpret_cast<const T*>(datos + inicio);
}

__device__ double uniforme(u64& estado) {
    u64 z = (estado += 0x9e3779b97f4a7c15ULL);
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
    return (z >> 11) * (1.0 / 9007199254740992.0);
}

__device__ double binomial(double n, double p, u64& azar) {
    if (n <= 0 || !(p > 0)) return 0;
    if (p >= 1) return n;
    const double q = p > 0.5 ? 1 - p : p;
    const double media = n * q, varianza = media * (1 - q);
    double k;
    if (varianza >= VARIANZA_NORMAL) {
        const double radio = sqrt(-2 * log(1 - uniforme(azar)));
        const double normal = radio * cos(6.283185307179586 * uniforme(azar));
        k = fmin(n, fmax(0.0, round(media + sqrt(varianza) * normal)));
    } else {
        const double razon = q / (1 - q);
        double pk = exp(n * log1p(-q)), u = uniforme(azar);
        k = 0;
        while (u > pk && k < n && pk > 0) {
            u -= pk;
            pk *= (n - k) / (k + 1) * razon;
            k++;
        }
    }
    return p > 0.5 ? n - k : k;
}

__device__ double cociente(double a, double b) {
    return a + b < 9007199254740992.0 ? floor(a / b) : static_cast<u64>(a) / static_cast<u64>(b);
}

struct Paso {
    const Cabecera& cab;
    const Lote& lote;
    const Especie* especies;
    const Reaccion* reacciones;
    const Termino* terminos;
    const Composicion* composicion;
    const Canal* canales;
    EstadoEspecie* s;
    EstadoCanal* c;
    Tripleta* salida;
    u64 azar;
    double T, V, calor;
    int escritos;

    __device__ const Reaccion& fila(int k) const { return reacciones[canales[k].reaccion]; }
    __device__ int nu(int k, int a) const { return a == canales[k].i ? c[k].p : c[k].q; }

    __device__ bool favorable(const Reaccion& r) const {
        const Termino* t = terminos + r.terminos;
        const u32 fin = r.entradas + r.salidas;
        const double ts = T * cab.entropia;
        int entrar = 0, salir = 0, gases = 0;
        for (u32 k = 0; k < r.entradas; k++) entrar += t[k].nu;
        for (u32 k = r.entradas; k < fin; k++) salir += t[k].nu;
        if (r.dH + ts * entrar < -cab.epsilon) return true;
        if (r.dH - ts * salir >= -cab.epsilon) return false;
        for (u32 k = 0; k < fin; k++) {
            const Especie& e = especies[t[k].especie];
            if (e.molecula && T > e.ebullicion) gases += (k < r.entradas ? -1 : 1) * static_cast<int>(t[k].nu);
        }
        return r.dH - ts * gases < -cab.epsilon;
    }

    __device__ void extensiones(double h, bool puntoMedio) {
        for (u32 i = 0; i < lote.n; i++) {
            s[i].H = s[i].L = s[i].L0 = 0;
        }
        for (u32 k = 0; k < lote.m; k++) {
            EstadoCanal& c = this->c[k];
            if (!c.tasa) continue;
            const int i = canales[k].i, j = canales[k].j;
            const double kt = c.tasa * h, esc = kt / V, na = s[i].x;
            double hi = kt;
            if (j < 0) { c.li = c.li0 = kt; }
            else if (j == i) { c.li = c.p * esc; continue; }
            else {
                const double nb = s[j].x, a = na / c.p, b = nb / c.q, esc2 = c.p * c.q * esc;
                const double lo = fmin(a, b), d = fabs(a - b);
                const double mayor = d == 0 ? log1p(lo * esc2) : log1p(lo * -expm1(-d * esc2) / d);
                const double menor = mayor + d * esc2;
                hi = a <= b ? menor : mayor;
                s[j].H += a <= b ? mayor : menor;
                c.li0 = c.p * nb * esc; c.lj0 = c.q * na * esc;
                c.li = puntoMedio ? c.p * s[j].medio * esc : c.li0;
                c.lj = puntoMedio ? c.q * s[i].medio * esc : c.lj0;
                s[j].L += c.lj; s[j].L0 += c.lj0;
            }
            s[i].H += hi; s[i].L += c.li; s[i].L0 += c.li0;
        }
        for (u32 i = 0; i < lote.n; i++) {
            EstadoEspecie& a = s[i];
            const double A0 = a.x;
            a.gastoLineal = a.gastoAa = 0;
            if (A0 == 0) continue;
            if (a.aa < 0) { a.gastoLineal = A0 * -expm1(-a.H); continue; }
            const double beta = c[a.aa].li, mu = a.L > 0 ? a.L : a.L0;
            double fin;
            if (mu == 0) fin = A0 / (1 + beta * A0);
            else {
                const double e = -expm1(-mu);
                fin = mu * A0 * (1 - e) / (mu + beta * A0 * e);
                a.gastoLineal = beta * A0 > 0 ? mu / beta * log1p(beta * A0 * e / mu) : A0 * e;
            }
            a.gastoAa = fmax(0.0, A0 - fin - a.gastoLineal);
        }
        for (u32 k = 0; k < lote.m; k++) {
            EstadoCanal& c = this->c[k];
            if (!c.tasa) continue;
            const int i = canales[k].i, j = canales[k].j;
            if (j == i) { c.ext = s[i].gastoAa / c.p; continue; }
            const double ri = s[i].L > 0 ? c.li / s[i].L : s[i].L0 > 0 ? c.li0 / s[i].L0 : 0;
            double e = s[i].gastoLineal * ri / c.p;
            if (j > i) {
                const double rj = s[j].L > 0 ? c.lj / s[j].L : s[j].L0 > 0 ? c.lj0 / s[j].L0 : 0;
                e = fmin(e, s[j].gastoLineal * rj / c.q);
            }
            c.ext = e;
        }
    }

    __device__ void consumir(bool puntoMedio) {
        if (puntoMedio) for (u32 i = 0; i < lote.n; i++) s[i].medio = s[i].x;
        for (u32 k = 0; k < lote.m; k++) {
            if (!c[k].tasa) continue;
            const int i = canales[k].i, j = canales[k].j;
            double& a = puntoMedio ? s[i].medio : s[i].x;
            a = fmax(0.0, a - c[k].p * c[k].ext);
            if (j > i) {
                double& b = puntoMedio ? s[j].medio : s[j].x;
                b = fmax(0.0, b - c[k].q * c[k].ext);
            }
        }
    }

    // Aquí H, L y L0 son el riesgo total, fijo y lento de paso.ts.
    __device__ bool instantaneos(double dt) {
        for (u32 i = 0; i < lote.n; i++) s[i].H = s[i].L = 0;
        for (u32 k = 0; k < lote.m; k++) {
            if (!c[k].tasa) continue;
            const int i = canales[k].i, j = canales[k].j;
            const double kt = c[k].tasa;
            s[i].H += j < 0 ? kt : c[k].p * kt * s[j].x / V;
            if (j > i) s[j].H += c[k].q * kt * s[i].x / V;
        }
        for (u32 i = 0; i < lote.n; i++) s[i].rapido = s[i].H * dt >= INSTANTANEO;
        for (u32 k = 0; k < lote.m; k++) {
            if (!c[k].tasa) continue;
            const int i = canales[k].i, j = canales[k].j;
            const double kt = c[k].tasa;
            if (j < 0) s[i].L += kt;
            else if (j == i) s[i].L += c[k].p * kt * s[i].x / V;
            else {
                const double ai = s[i].x / c[k].p, aj = s[j].x / c[k].q;
                const bool ambos = s[i].rapido && s[j].rapido;
                if (!ambos || ai <= aj) s[i].L += c[k].p * kt * s[j].x / V;
                if (!ambos || aj <= ai) s[j].L += c[k].q * kt * s[i].x / V;
            }
        }
        for (u32 i = 0; i < lote.n; i++) if (s[i].L * dt < INSTANTANEO) s[i].rapido = false;
        for (;;) {
            bool alguno = false;
            for (u32 i = 0; i < lote.n; i++) { alguno |= s[i].rapido; s[i].medio = s[i].x; }
            if (!alguno) return false;
            for (int corrector = 0; corrector < 2; corrector++) {
                for (u32 i = 0; i < lote.n; i++) s[i].H = s[i].L = s[i].L0 = s[i].demanda = 0;
                for (u32 k = 0; k < lote.m; k++) {
                    EstadoCanal& c = this->c[k];
                    if (!c.tasa) continue;
                    const int i = canales[k].i, j = canales[k].j;
                    if (j < 0) {
                        c.li = c.tasa; s[i].H += c.tasa; s[i].L0 += c.tasa;
                        if (s[i].rapido) s[i].L += c.tasa;
                    } else if (j == i) {
                        c.li = c.p * c.tasa * s[i].x / V; s[i].H += c.li; s[i].L0 += c.li;
                    } else {
                        c.li = c.p * c.tasa * (s[j].rapido ? s[j].x : s[j].medio) / V;
                        c.lj = c.q * c.tasa * (s[i].rapido ? s[i].x : s[i].medio) / V;
                        s[i].H += c.li; s[j].H += c.lj;
                        if (!s[j].rapido) { s[i].L0 += c.li; if (s[i].rapido) s[i].L += c.li; }
                        if (!s[i].rapido) { s[j].L0 += c.lj; if (s[j].rapido) s[j].L += c.lj; }
                    }
                }
                for (u32 i = 0; i < lote.n; i++) s[i].reparto = s[i].rapido ? s[i].x * -expm1(-s[i].H * dt) : 0;
                for (u32 k = 0; k < lote.m; k++) {
                    EstadoCanal& c = this->c[k];
                    if (!c.tasa) continue;
                    const int i = canales[k].i, j = canales[k].j;
                    c.ext = 0;
                    if (j < 0 || !s[i].rapido || !s[j].rapido) continue;
                    const double L2 = s[i].H + s[j].H;
                    c.ext = c.tasa * s[i].x * s[j].x / V * -expm1(-L2 * dt) / L2;
                    s[i].reparto -= c.p * c.ext;
                    if (j > i) s[j].reparto -= c.q * c.ext;
                }
                for (u32 k = 0; k < lote.m; k++) {
                    EstadoCanal& c = this->c[k];
                    if (!c.tasa) continue;
                    const int i = canales[k].i, j = canales[k].j;
                    if (j < 0) {
                        if (s[i].rapido && s[i].L > 0) c.ext = fmax(0.0, s[i].reparto) * c.li / s[i].L / c.p;
                    } else if (j > i && s[i].rapido != s[j].rapido) {
                        const int a = s[i].rapido ? i : j, b = a == i ? j : i;
                        const double l = a == i ? c.li : c.lj;
                        c.ext = s[a].L > 0 ? fmax(0.0, s[a].reparto) * l / s[a].L / nu(k, a) : 0;
                        s[b].demanda += nu(k, b) * c.ext;
                    }
                }
                for (u32 i = 0; i < lote.n; i++) if (!s[i].rapido) s[i].medio = fmax(0.0, s[i].x - s[i].demanda / 2);
            }
            bool quitar = false;
            for (u32 i = 0; i < lote.n; i++) if (s[i].rapido && s[i].H - s[i].L > VARIABLE * s[i].H) {
                s[i].rapido = false; quitar = true;
            }
            for (u32 k = 0; k < lote.m; k++) {
                if (!c[k].tasa) continue;
                const int i = canales[k].i, j = canales[k].j;
                if (j <= i || s[i].rapido == s[j].rapido) continue;
                const int a = s[i].rapido ? i : j, b = a == i ? j : i;
                if (s[b].demanda > SUBPASO * s[b].x || s[b].L0 > VARIABLE * s[a].H) {
                    s[a].rapido = false; quitar = true;
                }
            }
            if (!quitar) break;
        }
        consumir(false);
        for (u32 i = 0; i < lote.n; i++) if (s[i].rapido) s[i].x = s[i].cant * exp(-s[i].H * dt);
        return true;
    }

    __device__ void integrar(double dt) {
        bool compite = false;
        for (u32 i = 0; i < lote.n; i++) { s[i].x = s[i].cant; compite |= s[i].usos > 1; }
        if (!compite) {
            extensiones(dt, false);
            for (u32 k = 0; k < lote.m; k++) if (c[k].tasa) c[k].xi = c[k].ext;
            return;
        }
        const bool instantaneo = instantaneos(dt);
        for (u32 k = 0; k < lote.m; k++) if (c[k].tasa) c[k].xi = instantaneo ? c[k].ext : 0;

        double resta = dt;
        for (int paso = 1; resta > 0; paso++) {
            for (u32 i = 0; i < lote.n; i++) s[i].demanda = 0;
            for (u32 k = 0; k < lote.m; k++) {
                if (!c[k].tasa) continue;
                const int i = canales[k].i, j = canales[k].j;
                const double r = c[k].tasa * s[i].x * (j < 0 ? 1 : s[j].x / V);
                s[i].demanda += c[k].p * r;
                if (j > i) s[j].demanda += c[k].q * r;
            }
            double h = resta;
            if (paso < SUBPASOS_MAX) for (u32 k = 0; k < lote.m; k++) {
                if (!c[k].tasa) continue;
                const int i = canales[k].i, j = canales[k].j;
                if (j <= i || s[i].x <= AGOTADO || s[j].x <= AGOTADO) continue;
                if (s[i].usos > 1 && s[j].demanda > 0) h = fmin(h, SUBPASO * s[j].x / s[j].demanda);
                if (s[j].usos > 1 && s[i].demanda > 0) h = fmin(h, SUBPASO * s[i].x / s[i].demanda);
            }
            extensiones(h / 2, false);
            consumir(true);
            extensiones(h, true);
            consumir(false);
            for (u32 k = 0; k < lote.m; k++) if (c[k].tasa) c[k].xi += c[k].ext;
            resta -= h;
        }
    }

    __device__ double holgura(int r, int nr, int a, int na, double xi) const {
        const double grupos = s[a].cant / na, p = fmin(1.0, fmax(0.0, xi / grupos));
        const double sigma = sqrt(grupos * p * (1 - p));
        return sigma > 0 ? fmax(0.0, s[r].cant - s[r].L) / (nr * sigma) : __longlong_as_double(0x7ff0000000000000LL);
    }

    __device__ void sortear() {
        for (u32 i = 0; i < lote.n; i++) { s[i].H = s[i].L = 0; s[i].primero = s[i].ultimo = -1; }
        for (u32 k = 0; k < lote.m; k++) {
            if (!c[k].tasa) continue;
            const int i = canales[k].i, j = canales[k].j;
            const double a = c[k].p * c[k].xi, b = c[k].q * c[k].xi;
            s[i].H += a / s[i].cant; s[i].L += a;
            if (j > i) { s[j].H += b / s[j].cant; s[j].L += b; }
        }
        for (u32 k = 0; k < lote.m; k++) {
            if (!c[k].tasa) continue;
            const int i = canales[k].i, j = canales[k].j;
            int g = i;
            if (j > i) {
                const double zi = holgura(j, c[k].q, i, c[k].p, c[k].xi);
                const double zj = holgura(i, c[k].p, j, c[k].q, c[k].xi);
                if (zj > zi || (zj == zi && (s[j].H > s[i].H || (s[j].H == s[i].H && s[j].cant < s[i].cant)))) g = j;
            }
            c[k].siguiente = -1;
            if (s[g].ultimo >= 0) c[s[g].ultimo].siguiente = k;
            else s[g].primero = k;
            s[g].ultimo = k;
        }
        for (u32 i = 0; i < lote.n; i++) {
            double quedan = s[i].cant, resto = 1;
            const int aa = s[i].aa;
            for (int k = s[i].primero; k >= 0; k = c[k].siguiente) {
                if (k == aa) continue;
                const int n = nu(k, i);
                const double parte = n * c[k].xi / s[i].cant;
                c[k].veces = binomial(floor(quedan / n), parte / resto, azar);
                quedan -= n * c[k].veces; resto -= parte;
            }
            if (aa >= 0) {
                const int n = c[aa].p;
                c[aa].veces = binomial(floor(quedan / n), n * c[aa].xi / s[i].cant / resto, azar);
            }
        }
    }

    __device__ void recortar() {
        for (u32 i = 0; i < lote.n; i++) { s[i].demanda = 0; s[i].x = s[i].cant; }
        for (u32 k = 0; k < lote.m; k++) {
            if (!c[k].tasa) continue;
            const int i = canales[k].i, j = canales[k].j;
            s[i].demanda += c[k].p * c[k].veces;
            if (j > i) s[j].demanda += c[k].q * c[k].veces;
        }
        bool falta = false;
        for (u32 i = 0; i < lote.n; i++) falta |= s[i].demanda > s[i].cant;
        if (!falta) return;
        for (u32 k = 0; k < lote.m; k++) {
            if (!c[k].tasa) continue;
            const int i = canales[k].i, j = canales[k].j;
            const double f = fmin(1.0, fmin(s[i].cant / s[i].demanda, j > i ? s[j].cant / s[j].demanda : 1));
            c[k].pedidas = c[k].veces;
            c[k].veces = floor(c[k].veces * f);
            s[i].x -= c[k].p * c[k].veces;
            if (j > i) s[j].x -= c[k].q * c[k].veces;
        }
        for (u32 a = 0; a < lote.n; a++) {
            double libre = 0, resto = 0;
            for (int k = s[a].primero; k >= 0; k = c[k].siguiente) {
                const int n = nu(k, a);
                libre += n * (c[k].pedidas - c[k].veces);
                if (c[k].pedidas == c[k].veces) resto += n * c[k].xi / s[a].cant;
            }
            if (!(libre > 0 && resto > 0)) continue;
            double quedan = fmin(libre, s[a].x);
            for (int k = s[a].primero; k >= 0 && quedan > 0; k = c[k].siguiente) {
                if (c[k].veces != c[k].pedidas) continue;
                const int i = canales[k].i, j = canales[k].j, n = nu(k, a);
                const int r = j > i ? (static_cast<int>(a) == i ? j : i) : -1;
                const double parte = n * c[k].xi / s[a].cant;
                double v = binomial(floor(quedan / n), parte / resto, azar);
                if (r >= 0) v = fmax(0.0, fmin(v, floor(s[r].x / nu(k, r))));
                c[k].veces += v; c[k].pedidas += v;
                s[a].x -= n * v; quedan -= n * v; resto -= parte;
                if (r >= 0) s[r].x -= nu(k, r) * v;
            }
        }
        for (u32 k = 0; k < lote.m; k++) {
            if (!c[k].tasa) continue;
            const int i = canales[k].i, j = canales[k].j;
            if (c[k].veces < c[k].pedidas && s[i].x >= c[k].p && (j <= i || s[j].x >= c[k].q)) {
                c[k].veces++; s[i].x -= c[k].p;
                if (j > i) s[j].x -= c[k].q;
            }
        }
    }

    __device__ u32 local(u32 indice) const {
        const u32 id = especies[indice].id;
        u32 a = 0, b = lote.n;
        while (a < b) {
            const u32 m = a + (b - a) / 2;
            if (especies[composicion[m].especie].id < id) a = m + 1;
            else b = m;
        }
        return a;
    }

    __device__ void aplicar(int k) {
        const Reaccion& r = fila(k);
        const int i = canales[k].i, j = canales[k].j;
        double v = fmin(c[k].veces, cociente(s[i].existencia, c[k].p));
        if (j > i) v = fmin(v, cociente(s[j].existencia, c[k].q));
        if (r.dH > 0) v = fmin(v, cociente(calor, r.dH));
        if (!(v > 0)) return;
        s[i].existencia -= c[k].p * v;
        if (j > i) s[j].existencia -= c[k].q * v;
        calor -= v * r.dH;
        for (u32 d = 0; d < r.salidas; d++) {
            const Termino t = terminos[r.terminos + r.entradas + d];
            const u32 a = local(t.especie);
            // Un producto del último pase no tiene canales futuros, pero sí forma parte de la composición.
            s[a].existencia += v * t.nu; s[a].producidos += v * t.nu;
        }
        salida[escritos++] = {static_cast<double>(r.a), static_cast<double>(r.b), v};
    }

    __device__ void pase(double dt, bool encadenado) {
        bool hay = false;
        V = 0;
        for (u32 i = 0; i < lote.n; i++) {
            const Especie& e = especies[composicion[i].especie];
            if (s[i].existencia > 0) V += s[i].existencia * (T >= e.ebullicion ? cab.R * T / cab.atmosfera : e.condensado);
            s[i].cant = s[i].nuevos > 0 ? fmin(s[i].existencia, s[i].nuevos) : s[i].existencia;
            s[i].usos = 0; s[i].aa = -1;
        }
        for (u32 k = 0; k < lote.m; k++) {
            EstadoCanal& c = this->c[k];
            c.tasa = 0;
            const int i = canales[k].i, j = canales[k].j;
            if (encadenado && s[i].nuevos <= 0 && (j <= i || s[j].nuevos <= 0)) continue;
            // Los reactivos hipotéticos solo se resuelven si llegaron a existir en este lote.
            if (canales[k].reaccion == ~0u) {
                if (s[i].cant >= (i == j ? 2 : 1) && (j <= i || s[j].cant >= 1)) {
                    salida[0] = {0, 0, 0};
                    escritos = -1;
                    return;
                }
                continue;
            }
            const Reaccion& r = fila(k);
            if (r.nivel != lote.nivel || (i == j && s[i].cant < 2)) continue;
            c.p = c.q = 0;
            for (u32 t = 0; t < r.entradas; t++) {
                const Termino e = terminos[r.terminos + t];
                if (e.especie == composicion[i].especie) c.p = e.nu;
                else if (j > i && e.especie == composicion[j].especie) c.q = e.nu;
            }
            if (c.p <= 0 || s[i].cant < c.p || (j > i && (c.q <= 0 || s[j].cant < c.q)) || !favorable(r)) continue;
            const double b = r.dH > 0 || r.catalisis < 0 ? fmax(r.ea, r.dH)
                : fmax(0.0, r.ea - lote.kappa[r.catalisis] * r.pares);
            const double tasa = b == 0 ? cab.nu : T > 0 ? cab.nu * exp(-b / (cab.R * T)) : 0;
            if (!(tasa * dt > 0)) continue;
            c.tasa = tasa; s[i].usos++;
            if (j > i) s[j].usos++;
            if (j == i) s[i].aa = k;
            hay = true;
        }
        if (!hay) return;
        integrar(dt);
        sortear();
        recortar();

        double pide = 0;
        for (u32 k = 0; k < lote.m; k++) {
            if (!c[k].tasa) continue;
            if (fila(k).dH > 0) pide += c[k].veces * fila(k).dH;
            else aplicar(k);
        }
        if (pide > calor) {
            const double f = calor / pide;
            double restante = calor;
            for (u32 k = 0; k < lote.m; k++) if (c[k].tasa && fila(k).dH > 0) {
                c[k].pedidas = c[k].veces; c[k].veces = floor(c[k].veces * f);
                restante -= c[k].veces * fila(k).dH;
            }
            for (u32 k = 0; k < lote.m; k++) if (c[k].tasa && fila(k).dH > 0) {
                if (c[k].veces < c[k].pedidas && restante >= fila(k).dH) { c[k].veces++; restante -= fila(k).dH; }
            }
        }
        for (u32 k = 0; k < lote.m; k++) if (c[k].tasa && fila(k).dH > 0) aplicar(k);
    }

    __device__ void ejecutar() {
        double atomos = 0;
        for (u32 i = 0; i < lote.n; i++) {
            s[i].existencia = composicion[i].cuantos;
            s[i].nuevos = s[i].producidos = 0;
            atomos += s[i].existencia * especies[composicion[i].especie].atomos;
        }
        if (!(atomos > 0)) return;
        T = calor / (cab.capacidad * atomos);
        double dt = cab.dt;
        for (u32 p = 0; p <= cab.pases; p++, dt /= 2) {
            if (p > 0) {
                bool produjo = false;
                for (u32 i = 0; i < lote.n; i++) {
                    produjo |= s[i].producidos > 0; s[i].nuevos = s[i].producidos; s[i].producidos = 0;
                }
                if (!produjo) break;
            }
            pase(dt, p > 0);
            if (escritos < 0) return;
        }
    }
};

extern "C" __global__ void materia(const byte* binario, u32 n, EstadoEspecie* s, EstadoCanal* c,
    Tripleta* temporal, u32* cuentas) {
    const u32 i = blockIdx.x * blockDim.x + threadIdx.x;
    if (i >= n) return;
    const Cabecera& cab = *en<Cabecera>(binario, 0);
    const Lote* lotes = en<Lote>(binario, sizeof(Cabecera));
    const Lote& l = lotes[i];
    cuentas[i] = 0;
    if (!l.m) return;
    const u32 inicioS = (l.composicion - lotes[0].composicion) / sizeof(Composicion);
    const u32 inicioC = (l.canales - lotes[0].canales) / sizeof(Canal);
    Paso paso{cab, l, en<Especie>(binario, cab.especies), en<Reaccion>(binario, cab.reacciones),
        en<Termino>(binario, cab.terminos), en<Composicion>(binario, l.composicion), en<Canal>(binario, l.canales),
        s + inicioS, c + inicioC, temporal + static_cast<u64>(inicioC) * (cab.pases + 1), l.semilla, 0, 0, l.calor, 0};
    paso.ejecutar();
    cuentas[i] = paso.escritos < 0 ? 1 : paso.escritos;
}

extern "C" __global__ void offsets_materia(const u32* cuentas, u32 n, u32* desde) {
    u32 suma = 0;
    for (u32 i = 0; i < n; i++) { desde[i] = suma; suma += 3 * cuentas[i]; }
    desde[n] = suma;
    if (n % 2 == 0) desde[n + 1] = 0;
}

extern "C" __global__ void compactar_materia(const byte* binario, u32 n, const Tripleta* temporal, const u32* desde,
    Tripleta* salida, u32 maxTripletas) {
    const u32 i = (blockIdx.x * blockDim.x + threadIdx.x) / warpSize;
    if (i >= n || desde[n] > 3 * maxTripletas || desde[n] % 3) return;
    const u32 inicio = desde[i] / 3, cuenta = desde[i + 1] / 3 - inicio;
    const Cabecera& cab = *en<Cabecera>(binario, 0);
    const Lote* lotes = en<Lote>(binario, sizeof(Cabecera));
    const u64 k = (lotes[i].canales - lotes[0].canales) / sizeof(Canal) * static_cast<u64>(cab.pases + 1);
    for (u32 j = threadIdx.x % warpSize; j < cuenta; j += warpSize) salida[inicio + j] = temporal[k + j];
}
