import { channel } from 'node:diagnostics_channel';

const perfilPaso = channel('atlas:materia:paso');

export function iniciarPerfilPasoMateria(): ((paginas: number, paginasCpu: number, fallos: number) => void) | undefined {
  if (!perfilPaso.hasSubscribers) return undefined;
  const inicio = performance.now();
  return (paginas, paginasCpu, fallos) => perfilPaso.publish({ ms: performance.now() - inicio, paginas, paginasCpu, fallos });
}
