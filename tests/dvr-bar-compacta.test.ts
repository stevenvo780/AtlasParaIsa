import test from 'node:test';
import assert from 'node:assert/strict';
import type { SeriePunto } from '../src/shared/cinta.js';
import {
  dvrHoverLabel, dvrPercent, mountDvrBar, renderDvrBar, tickDesdePuntero,
  type DvrBarController, type DvrBarHandlers, type DvrBarState,
} from '../src/client/dvr-bar.js';

/**
 * Fallos que la fila compacta tenía que dejar de hacer:
 * el cabezal vuelve al tick viejo mientras se arrastra, `input` y `change` piden el salto dos veces,
 * la vista previa usa el punto de la serie en vez del tick elegido, reescribir min/max suelta la pausa,
 * y Archivo no pasa a «Último fotograma» si el HTML ya estaba pintado.
 */

const serie = (): SeriePunto[] => [0, 4800, 9600, 14400].map((t, i) => ({
  t, poblacion: 10 + i * 5, nacimientos: i, muertes: 0, fauna: 3 + i, estructuras: i, sustancias: i * 2, hz: 100,
}));

function estado(parcial: Partial<DvrBarState> = {}): DvrBarState {
  return {
    playing: true, speed: 2, currentTick: 4800, minTick: 0, maxTick: 14400, latestDay: 7, simHz: 119.6,
    serie: serie(), bifurcaciones: [], lagunas: [], nivel: 3, aheadOfPlayhead: 9600, atLiveEdge: false, ...parcial,
  };
}

class Nodo {
  tag = '';
  attrs: Record<string, string> = {};
  children: Nodo[] = [];
  parent: Nodo | null = null;
  text = '';
  style = { left: '' };
  writes: string[] = [];
  focused = 0;
  rect = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  onInput: ((nodo: Nodo) => void) | null = null;
  private _min = '';
  private _max = '';
  private _value = '';
  get textContent(): string { return this.text; }
  set textContent(valor: string) { this.text = valor; }
  get min(): string { return this._min; }
  set min(valor: string) {
    if (this._min === valor) return;
    this._min = valor;
    this.writes.push('min');
    // Si `min` supera a `max`, el motor recorta el pulgar al máximo viejo (el fallo de la ventana móvil).
    if (this._max !== '' && Number(valor) > Number(this._max)) { this._value = this._max; this.onInput?.(this); return; }
    if (this._value !== '' && Number(this._value) < Number(valor)) { this._value = valor; this.onInput?.(this); }
  }
  get max(): string { return this._max; }
  set max(valor: string) {
    if (this._max === valor) return;
    this._max = valor;
    this.writes.push('max');
  }
  get value(): string { return this._value; }
  set value(valor: string) {
    if (this._value === valor) return;
    this._value = valor;
    this.writes.push('value');
    this.onInput?.(this);
  }
  get classList() {
    const nodo = this;
    return { toggle(token: string, force?: boolean): void {
      const clases = new Set((nodo.attrs.class ?? '').split(/\s+/).filter(Boolean));
      if (force ?? !clases.has(token)) clases.add(token); else clases.delete(token);
      nodo.attrs.class = [...clases].join(' ');
    } };
  }
  getAttribute(nombre: string): string | null { return nombre in this.attrs ? this.attrs[nombre]! : null; }
  setAttribute(nombre: string, valor: string): void { this.attrs[nombre] = valor; }
  hasAttribute(nombre: string): boolean { return nombre in this.attrs; }
  removeAttribute(nombre: string): void { delete this.attrs[nombre]; }
  focus(): void { this.focused += 1; }
  closest(sel: string): Nodo | null {
    let nodo: Nodo | null = this;
    while (nodo) { if (coincide(nodo, sel)) return nodo; nodo = nodo.parent; }
    return null;
  }
  getBoundingClientRect(): Nodo['rect'] { return this.rect; }
  querySelector(sel: string): Nodo | null { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel: string): Nodo[] {
    const sale: Nodo[] = [];
    const visita = (nodo: Nodo, raiz: boolean): void => {
      if (!raiz && coincide(nodo, sel)) sale.push(nodo);
      for (const hijo of nodo.children) visita(hijo, false);
    };
    visita(this, true);
    return sale;
  }
  /** Copia los atributos del HTML a las propiedades, como hace el navegador al parsear. */
  sembrar(): void {
    this._min = this.attrs.min ?? '';
    this._max = this.attrs.max ?? '';
    this._value = this.attrs.value ?? '';
    for (const hijo of this.children) hijo.sembrar();
  }
}

function coincide(nodo: Nodo, sel: string): boolean {
  if (sel.startsWith('#')) return nodo.attrs.id === sel.slice(1);
  if (sel.startsWith('.')) return (nodo.attrs.class ?? '').split(/\s+/).includes(sel.slice(1));
  const exacto = /^\[([^\]=]+)="([^"]*)"\]$/.exec(sel);
  if (exacto) return nodo.attrs[exacto[1]!] === exacto[2];
  const attr = /^\[([^\]]+)\]$/.exec(sel);
  if (attr) return attr[1]! in nodo.attrs;
  return nodo.tag === sel;
}

function analizar(html: string): Nodo {
  const raiz = new Nodo();
  const pila = [raiz];
  const re = /<\/([a-zA-Z0-9]+)>|<([a-zA-Z0-9]+)([^>]*?)(\/?)>|([^<]+)/g;
  let encontrado: RegExpExecArray | null;
  while ((encontrado = re.exec(html))) {
    if (encontrado[1]) {
      while (pila.length > 1 && pila.at(-1)!.tag !== encontrado[1]) pila.pop();
      if (pila.length > 1) pila.pop();
    } else if (encontrado[2]) {
      const nodo = new Nodo();
      nodo.tag = encontrado[2].toLowerCase();
      nodo.parent = pila.at(-1)!;
      for (const attr of (encontrado[3] ?? '').matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) nodo.attrs[attr[1]!] = attr[2] ?? '';
      pila.at(-1)!.children.push(nodo);
      if (encontrado[4] !== '/' && !['input', 'br', 'img', 'path', 'line', 'rect'].includes(nodo.tag)) pila.push(nodo);
    } else if (encontrado[5]?.trim()) pila.at(-1)!.text += encontrado[5].trim();
  }
  raiz.sembrar();
  return raiz;
}

class Caja {
  private raiz = new Nodo();
  listeners = new Map<string, (event: unknown) => void>();
  ownerDocument = { listeners: new Map<string, (event: unknown) => void>(),
    addEventListener: (tipo: string, listener: (event: unknown) => void) => { this.ownerDocument.listeners.set(tipo, listener); },
    removeEventListener: (tipo: string) => { this.ownerDocument.listeners.delete(tipo); } };
  set innerHTML(html: string) {
    this.raiz = analizar(html);
    const cablear = (nodo: Nodo): void => {
      nodo.onInput = (origen) => { this.listeners.get('input')?.({ target: origen }); };
      for (const hijo of nodo.children) cablear(hijo);
    };
    for (const hijo of this.raiz.children) cablear(hijo);
  }
  querySelector(sel: string): Nodo | null { return this.raiz.querySelector(sel); }
  querySelectorAll(sel: string): Nodo[] { return this.raiz.querySelectorAll(sel); }
  addEventListener(tipo: string, listener: (event: unknown) => void): void { this.listeners.set(tipo, listener); }
  removeEventListener(tipo: string): void { this.listeners.delete(tipo); }
  contains(nodo: Nodo): boolean {
    let actual: Nodo | null = nodo;
    while (actual) { if (actual === this.raiz) return true; actual = actual.parent; }
    return false;
  }
  disparar(tipo: string, event: unknown): void { this.listeners.get(tipo)?.(event); }
}

function montar(seeks: number[] = []): { caja: Caja; barra: DvrBarController } {
  const caja = new Caja();
  const handlers: DvrBarHandlers = {
    togglePlay() {}, step() {}, setSpeed() {}, seek(tick) { seeks.push(tick); }, jumpLive() {},
  };
  return { caja, barra: mountDvrBar(caja as unknown as HTMLElement, handlers) };
}

const rangoDe = (caja: Caja): Nodo => caja.querySelector('[data-dvr-range]')!;
const texto = (caja: Caja, sel: string): string => caja.querySelector(sel)?.textContent ?? '';

test('la fila muestra play, hora, pista y ritmo; paso, tramos y telemetría quedan en el popover', () => {
  const html = renderDvrBar(estado());
  assert.match(html, /class="dvr-transport"/);
  assert.match(html, /data-dvr-play[\s\S]*data-dvr-time[\s\S]*data-dvr-range[\s\S]*data-dvr-tiempo-real[\s\S]*data-dvr-speed="1"[\s\S]*data-dvr-live[\s\S]*data-dvr-mas/);
  const pop = html.slice(html.indexOf('id="dvr-popover"'));
  assert.match(pop, /hidden/);
  assert.match(pop, /data-dvr-step="-1"/);
  assert.match(pop, /data-dvr-step="1"/);
  assert.match(pop, /data-tramo-inicio/);
  assert.match(pop, /data-dvr-escala/);
  assert.match(pop, /data-dvr-engine/);
  assert.match(pop, /data-dvr-desfase/);
  assert.ok(html.indexOf('data-dvr-step') > html.indexOf('data-dvr-mas'));
  assert.match(html, /<span class="dvr-hover" data-dvr-hover><\/span>/);
});

test('tickDesdePuntero es lineal en la pista y la hora de la vista previa es la del tick, no la del punto', () => {
  assert.equal(tickDesdePuntero(25, 0, 100, 0, 1000), 250);
  assert.equal(tickDesdePuntero(-10, 0, 100, 0, 1000), 0);
  assert.equal(tickDesdePuntero(500, 0, 100, 0, 1000), 1000);
  assert.equal(tickDesdePuntero(5, 0, 0, 3, 9), 3);
  const punto = serie()[1]!;
  assert.equal(dvrHoverLabel(punto), 'Día 3 · 00:00 · Pob 15 · Fauna 4 · Obras 1 · Sustancias 2');
  assert.equal(dvrHoverLabel(punto, 3600), 'Día 2 · 12:00 · Pob 15 · Fauna 4 · Obras 1 · Sustancias 2');
  assert.equal(dvrPercent(3600, 0, 14400), 25);
});

test('arrastrar no salta con update, input no pide seek y change/pointerup lo piden una sola vez', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seeks: number[] = [];
  const { caja, barra } = montar(seeks);
  const vivo = estado();
  barra.update(vivo);
  const rango = rangoDe(caja);
  const antes = rango;
  caja.disparar('pointerdown', { target: rango });
  rango.value = '3600';
  caja.disparar('input', { target: rango });
  assert.deepEqual(seeks, []);
  assert.equal(texto(caja, '[data-dvr-time]'), 'Día 2 · 12:00');
  assert.equal(texto(caja, '[data-dvr-hover]'), 'Día 2 · 12:00 · Pob 15 · Fauna 4 · Obras 1 · Sustancias 2');
  assert.equal(rango.getAttribute('aria-valuetext'), 'Día 2 · 12:00');
  assert.doesNotMatch(texto(caja, '[data-dvr-hover]'), /Día 3/);

  barra.update({ ...vivo, currentTick: 9000 });
  assert.equal(rangoDe(caja), antes, 'el arrastre no rehace el deslizador');
  assert.equal(rango.value, '3600');
  assert.equal(caja.querySelector('[data-dvr-playhead]')!.style.left, '25.00%');
  assert.equal(texto(caja, '[data-dvr-time]'), 'Día 2 · 12:00');

  caja.disparar('change', { target: rango });
  assert.deepEqual(seeks, [3600]);
  // El salto avisa en el acto, todavía en el tick anterior: el pulgar no vuelve atrás.
  barra.update({ ...vivo, currentTick: 4800 });
  assert.equal(rango.value, '3600');
  assert.equal(caja.querySelector('[data-dvr-playhead]')!.style.left, '25.00%');
  caja.disparar('pointerup', {});
  caja.disparar('change', { target: rango });
  assert.deepEqual(seeks, [3600]);

  barra.update({ ...vivo, currentTick: 3600 });
  barra.update({ ...vivo, currentTick: 7200 });
  assert.equal(rango.value, '7200');
  assert.equal(caja.querySelector('[data-dvr-playhead]')!.style.left, '50.00%');
  barra.destroy();
});

test('un salto que cae en otro tick suelta el gesto en el fotograma real, no en el pedido', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seeks: number[] = [];
  const { caja, barra } = montar(seeks);
  const vivo = estado();
  barra.update(vivo);
  const rango = rangoDe(caja);
  caja.disparar('pointerdown', { target: rango });
  rango.value = '3600';
  caja.disparar('input', { target: rango });
  caja.disparar('pointerup', {});
  assert.deepEqual(seeks, [3600]);
  barra.update({ ...vivo, currentTick: 4800 });
  assert.equal(rango.value, '3600');
  barra.update({ ...vivo, currentTick: 3590 });
  assert.equal(rango.value, '3590');
  assert.equal(texto(caja, '[data-dvr-time]'), 'Día 2 · 11:54');
  barra.destroy();
});

test('si el salto no mueve el cabezal, a los 800 ms la pista vuelve al tick real', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seeks: number[] = [];
  const { caja, barra } = montar(seeks);
  const vivo = estado({ playing: false });
  barra.update(vivo);
  const rango = rangoDe(caja);
  caja.disparar('pointerdown', { target: rango });
  rango.value = '3600';
  caja.disparar('input', { target: rango });
  caja.disparar('pointerup', {});
  assert.deepEqual(seeks, [3600]);
  assert.equal(rango.value, '3600');
  t.mock.timers.tick(800);
  assert.equal(rango.value, '4800');
  assert.equal(caja.querySelector('[data-dvr-playhead]')!.style.left, '33.33%');
  barra.update({ ...vivo, currentTick: 5000 });
  assert.equal(rango.value, '5000');
  barra.destroy();
});

test('soltar sin mover no pide seek; la vista previa del puntero usa el rect del rango', () => {
  const seeks: number[] = [];
  const { caja, barra } = montar(seeks);
  barra.update(estado());
  const rango = rangoDe(caja);
  rango.rect = { left: 10, top: 0, width: 100, height: 32, right: 110, bottom: 32 };
  caja.disparar('pointermove', { clientX: 35 });
  assert.equal(texto(caja, '[data-dvr-hover]'), 'Día 2 · 12:00 · Pob 15 · Fauna 4 · Obras 1 · Sustancias 2');
  caja.disparar('pointerdown', { target: rango });
  caja.disparar('pointerleave', {});
  assert.match(texto(caja, '[data-dvr-hover]'), /Día 2 · 12:00/);
  caja.disparar('pointerup', {});
  assert.deepEqual(seeks, []);
  caja.disparar('pointerleave', {});
  assert.equal(texto(caja, '[data-dvr-hover]'), '');
  barra.destroy();
});

test('min/max de la ventana móvil no recortan el pulgar ni sueltan la pausa', () => {
  const seeks: number[] = [];
  const { caja, barra } = montar(seeks);
  barra.update(estado({ playing: false, currentTick: 3000, minTick: 0, maxTick: 4000 }));
  const rango = rangoDe(caja);
  assert.equal(rango.value, '3000');
  const escritos = rango.writes.length;
  barra.update(estado({ playing: false, currentTick: 3000, minTick: 5000, maxTick: 9000 }));
  assert.equal(rango.value, '5000');
  assert.ok(rango.writes.indexOf('max') < rango.writes.indexOf('min'), rango.writes.join(','));
  assert.deepEqual(seeks, []);
  const trasVentana = rango.writes.length;
  assert.ok(trasVentana > escritos);
  barra.update(estado({ playing: false, currentTick: 3000, minTick: 5000, maxTick: 9000 }));
  assert.equal(rango.writes.length, trasVentana, 'repetir min/max iguales no reescribe la pista');
  assert.deepEqual(seeks, []);
  barra.update(estado({ playing: false, currentTick: 3000, minTick: 1000, maxTick: 9000 }));
  assert.equal(rango.value, '3000');
  assert.deepEqual(seeks, []);
  barra.destroy();
});

test('Archivo pasa a Último fotograma al actualizar, y al volver muestra el motor', () => {
  const { caja, barra } = montar();
  barra.update(estado());
  const vivo = () => caja.querySelector('[data-dvr-live]')!;
  assert.equal(vivo().textContent, 'Borde vivo');
  assert.equal(caja.querySelector('[data-dvr-engine]')!.hasAttribute('hidden'), false);

  barra.update(estado({ archivo: true, aheadOfPlayhead: 0, atLiveEdge: true, modoReloj: 'ritmo' }));
  assert.equal(vivo().textContent, 'Último fotograma');
  assert.equal(vivo().getAttribute('aria-pressed'), 'true');
  assert.equal(vivo().getAttribute('title'), 'Último fotograma (0)');
  assert.ok(vivo().attrs.class.includes('is-live'));
  assert.equal(texto(caja, '[data-dvr-desfase]'), 'Fin de la grabación');
  assert.equal(caja.querySelector('[data-dvr-engine]')!.hasAttribute('hidden'), true);

  barra.update(estado({ archivo: true, aheadOfPlayhead: 8, atLiveEdge: false, modoReloj: 'ritmo' }));
  assert.equal(vivo().textContent, 'Último fotograma');
  assert.equal(vivo().getAttribute('aria-pressed'), 'false');
  assert.equal(vivo().attrs.class.includes('is-live'), false);
  assert.match(texto(caja, '[data-dvr-desfase]'), /de mundo hasta el final/);

  barra.update(estado({ archivo: false, aheadOfPlayhead: 0, atLiveEdge: true, modoReloj: 'tiempo-real' }));
  assert.equal(vivo().textContent, 'Borde vivo');
  assert.equal(vivo().getAttribute('aria-pressed'), 'false');
  assert.equal(caja.querySelector('[data-dvr-engine]')!.hasAttribute('hidden'), false);
  assert.match(texto(caja, '[data-dvr-engine]'), /⚡ \d+ Hz/);
  barra.destroy();
});

test('el popover abre, cierra con Escape y no se cierra al pulsar un paso', () => {
  const pasos: number[] = [];
  const caja = new Caja();
  const handlers: DvrBarHandlers = {
    togglePlay() {}, step(delta) { pasos.push(delta); }, setSpeed() {}, seek() {}, jumpLive() {},
  };
  const barra = mountDvrBar(caja as unknown as HTMLElement, handlers);
  barra.update(estado());
  const mas = caja.querySelector('[data-dvr-mas]')!;
  const pop = caja.querySelector('#dvr-popover')!;
  assert.equal(pop.hasAttribute('hidden'), true);
  const ev = { key: 'Escape', preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, defaultPrevented: false, stopped: false };
  caja.disparar('keydown', ev);
  assert.equal(ev.defaultPrevented, false);

  caja.disparar('click', { target: mas });
  assert.equal(pop.hasAttribute('hidden'), false);
  assert.equal(mas.getAttribute('aria-expanded'), 'true');
  assert.equal(caja.querySelector('[data-dvr-step="-1"]')!.focused, 1);

  const paso = caja.querySelector('[data-dvr-step="-1"]')!;
  caja.disparar('click', { target: paso });
  assert.deepEqual(pasos, [-1]);
  assert.equal(pop.hasAttribute('hidden'), false);

  const escape = { key: 'Escape', preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, defaultPrevented: false, stopped: false };
  caja.disparar('keydown', escape);
  assert.equal(escape.defaultPrevented, true);
  assert.equal(escape.stopped, true);
  assert.equal(pop.hasAttribute('hidden'), true);
  assert.equal(mas.getAttribute('aria-expanded'), 'false');
  assert.equal(mas.focused, 1);
  barra.destroy();
  assert.equal(caja.listeners.size, 0);
  assert.equal(caja.ownerDocument.listeners.size, 0);
});

test('el transporte cerrado muestra el modo elegido y conserva las opciones detrás del selector', () => {
  for (const [modo, etiqueta] of [['paseo', 'Paseo'], ['tiempo-real', 'Tiempo real']] as const) {
    const html = renderDvrBar(estado({ modoReloj: modo }));
    assert.match(html, new RegExp('data-dvr-ritmo[^>]*aria-expanded="false"[^>]*>' + etiqueta + '<'));
    const menu = html.match(/<div id="dvr-ritmo-menu"[^>]*hidden[^>]*>([\s\S]*?)<\/div>/)?.[1];
    assert.ok(menu);
    assert.equal((menu.match(/role="menuitemradio"/g) ?? []).length, 8);
    assert.equal((menu.match(/aria-checked="true"/g) ?? []).length, 1);
  }
});
