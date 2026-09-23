// Enlaces relativos rotos en los .md versionados: un destino cuenta si está versionado, no si existe en disco.
//
// Uso: `npx tsx scripts/check-links.ts` (sale con 1 si hay enlaces rotos fuera de la lista blanca).
// Conviene ejecutarlo al publicar y antes de fusionar cambios de documentación.
//
// Norma: la evidencia que sostiene una afirmación vigente va a `docs/evidencia-AAAA-MM-DD/`; lo que solo
// existe en local (artifacts/, .superpowers/, worktrees de campaña) se cita como «local, no versionado»,
// sin enlace. La lista blanca solo cubre registros históricos escritos antes de esa norma: sus rutas
// siguen apuntando a directorios ignorados, cuya copia está fuera del repo en
// /datos/workspaces/personal/AtlasParaIsa-archivo/evidencia-local-20260922.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Enlace { fichero: string; linea: number; destino: string; resuelto: string }

/** Registros históricos que pueden seguir enlazando rutas locales no versionadas. */
export const LISTA_BLANCA: readonly { fichero: string; prefijo: string; motivo: string }[] = [
  { fichero: 'docs/EVIDENCIA.md', prefijo: 'artifacts/', motivo: 'registro histórico de ejecuciones; copia en AtlasParaIsa-archivo/evidencia-local-20260922' },
];

const ENLACE = /!?\[(?:[^\]\\]|\\.)*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const EXTERNO = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i;

/** Enlaces relativos de un documento Markdown, fuera de bloques de código. */
export function enlacesRelativos(fichero: string, texto: string): Enlace[] {
  const salida: Enlace[] = [];
  let enBloque = false;
  texto.split('\n').forEach((linea, indice) => {
    if (/^\s*(```|~~~)/.test(linea)) { enBloque = !enBloque; return; }
    if (enBloque) return;
    const sinCodigo = linea.replace(/`[^`]*`/g, '');
    for (const coincidencia of sinCodigo.matchAll(ENLACE)) {
      const destino = coincidencia[1]!;
      if (EXTERNO.test(destino)) continue;
      const ruta = decodeURIComponent(destino.split('#')[0]!.split('?')[0]!);
      if (!ruta) continue;
      salida.push({ fichero, linea: indice + 1, destino, resuelto: normalize(join(dirname(fichero), ruta)) });
    }
  });
  return salida;
}

/**
 * Ficheros versionados y los directorios que los contienen. Un enlace a algo que solo existe en disco
 * (un directorio ignorado como artifacts/) cuenta como roto: en otro clon no estaría.
 */
export function rutasVersionadas(ficheros: readonly string[]): Set<string> {
  const rutas = new Set<string>();
  for (const fichero of ficheros) {
    rutas.add(fichero);
    for (let corte = fichero.lastIndexOf('/'); corte > 0; corte = fichero.lastIndexOf('/', corte - 1)) rutas.add(fichero.slice(0, corte));
  }
  return rutas;
}

export function enListaBlanca(enlace: Enlace): boolean {
  return LISTA_BLANCA.some(entrada => entrada.fichero === enlace.fichero && enlace.resuelto.startsWith(entrada.prefijo));
}

function main() {
  const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const versionados = execFileSync('git', ['-C', raiz, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const destinos = rutasVersionadas(versionados);
  const ficheros = versionados.filter(fichero => fichero.endsWith('.md'));
  let total = 0; let blancos = 0;
  const rotos: Enlace[] = [];
  for (const fichero of ficheros) {
    for (const enlace of enlacesRelativos(fichero, readFileSync(join(raiz, fichero), 'utf8'))) {
      total++;
      if (destinos.has(enlace.resuelto.replace(/\/+$/, ''))) continue;
      if (enListaBlanca(enlace)) { blancos++; continue; }
      rotos.push(enlace);
    }
  }
  for (const enlace of rotos) console.log(`${enlace.fichero}:${enlace.linea}: ${enlace.destino} → ${relative('.', enlace.resuelto)} no existe`);
  console.log(`${ficheros.length} documentos, ${total} enlaces relativos, ${rotos.length} rotos, ${blancos} históricos en lista blanca.`);
  if (rotos.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
