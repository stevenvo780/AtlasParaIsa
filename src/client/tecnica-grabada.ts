import type { Nivel } from '../shared/cinta.js';
import type { RecetaVisible } from '../shared/tecnica-visible.js';
import type { WorldView } from '../shared/types.js';
import { statCard } from './charts.js';
import { fichaReaccion } from './inspector-view.js';
import { esc, number } from './ui-catalog.js';

function legadoConDatos(world: WorldView): boolean {
  const tech = world.technology;
  return !!world.chemistry || !!world.organization?.evidence.executed
    || world.organization?.window.complete === true
    || !!tech?.recipes.length || !!tech?.items.length
    || Object.values(tech?.dynamics ?? {}).some(value => Number.isFinite(value) && value !== 0);
}

/** Vista de la técnica material que graba la cinta. Devuelve null para usar el panel del sistema anterior. */
export function tecnicaGrabada(world: WorldView, nivel: Nivel | null): string | null {
  const recetas = new Map<number, RecetaVisible>();
  let fichas = 0, habitantesConRecetas = 0, procesos = 0;
  for (const persona of world.people) {
    const tecnica = persona.tecnicaVista;
    if (!tecnica) continue;
    fichas++;
    if (tecnica.recetas.length || tecnica.omitidas) habitantesConRecetas++;
    if (tecnica.proceso) procesos++;
    for (const receta of tecnica.recetas) {
      const previa = recetas.get(receta.id);
      if (!previa || (!previa.pasos && receta.pasos) || (!!previa.pasos === !!receta.pasos && receta.usada > previa.usada)) {
        recetas.set(receta.id, receta);
      }
    }
  }
  const resumida = nivel !== null && nivel > 0;
  const materiaVisible = !!world.materia || !!world.reaccionObservada || !!world.sustancias?.length
    || world.structures?.some(obra => obra.piezas?.length);
  if (!fichas && !materiaVisible && (!resumida || legadoConDatos(world))) return null;

  const evidencia = fichas
    ? `<p class="stats-note">La cámara muestra ${number(fichas)} fichas de técnica. Las cifras corresponden a esas fichas.</p>
      <div class="stats-grid">${statCard('Habitantes con recetas', number(habitantesConRecetas), 'En la zona visible')}
      ${statCard('Recetas distintas', number(recetas.size), 'En los repertorios recibidos')}
      ${statCard('Procesos en curso', number(procesos), 'Investigaciones o fabricaciones registradas en el fotograma')}</div>`
    : `<p class="stats-empty" data-tecnica-ausente>${resumida
      ? 'La grabación resumida omite las fichas individuales de técnica. Borde vivo lleva a la parte reciente de la cinta.'
      : 'Este fotograma no incluye fichas individuales de técnica.'}</p>`;
  const recientes = Array.from(recetas.values()).sort((a, b) => b.usada - a.usada || a.id - b.id).slice(0, 12);
  const lista = recientes.length ? `<h4>Recetas de uso reciente en esta zona</h4>${recientes.map(receta => {
    const pasos = receta.pasos?.length
      ? `<ol>${receta.pasos.map(paso => `<li>${esc(paso.texto)}</li>`).join('')}</ol>`
      : '<p class="stats-note">Este registro carece de pasos del procedimiento.</p>';
    return `<details class="person-detail" data-receta-grabada="${esc(receta.id)}"><summary>Receta n.º ${number(receta.id)} · último uso en el paso ${number(receta.usada)}</summary>${pasos}</details>`;
  }).join('')}` : '';
  return `<section class="stats-section" data-tecnica-grabada><h3>Técnica sobre lotes</h3>${evidencia}${lista}</section>`
    + (world.reaccionObservada ? `<section class="stats-section"><h3>Reacción química observada</h3>${fichaReaccion(world.reaccionObservada, 'mundo')}</section>` : '');
}
