export interface DiagnosticoSalud {
  duras24h: number;
  blandas24h: number;
  ultimaViolacion: string | null;
  errorBitacora: string | null;
  registrosSinBitacora: number;
}

export interface OperacionSalud {
  tipo: 'arrancando' | 'guardando' | 'recargando';
  inicio: number;
  progresoEn: number;
}

/** Salud operacional que sirve /health, con fechas en ms desde el epoch. */
export interface Salud {
  estado: 'ok' | 'degradado' | 'parado';
  tick: number;
  ticksPorSegundo: number;
  segundosDesdeUltimoPaso: number;
  ultimoGuardado: number | null;
  gpu: { dispositivo: number; estado: 'ok' | 'cpu' | 'sin' }[];
  recargas: number;
  diagnostico: DiagnosticoSalud;
  operacion: OperacionSalud | null;
}
