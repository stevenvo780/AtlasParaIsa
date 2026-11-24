import type { FloatingPanel } from './panel-manager.js';
export type NotebookPage = 'population' | 'inspector' | 'settings' | 'whisper' | 'stats';

const triggers: Record<NotebookPage, string> = {
  population: 'population-toggle', inspector: 'inspector-toggle', settings: 'settings-toggle',
  whisper: 'whisper-toggle', stats: 'stats-toggle',
};

/** Desktop windows coexist; mobile keeps one sheet and a return point. */
export class Notebook {
  private readonly opened = new Set<NotebookPage>();
  private readonly onResize = (): void => {
    if ((this.root.ownerDocument?.defaultView?.innerWidth ?? 761) > 760 || this.opened.size < 2) return;
    const last = [...this.opened].at(-1)!;
    this.show(last, true);
  };
  constructor(private readonly root: HTMLElement, private readonly panels: Partial<Record<NotebookPage, FloatingPanel>> = {}) {
    root.ownerDocument?.defaultView?.addEventListener('resize', this.onResize);
  }

  show(page: NotebookPage, open = !this.opened.has(page)): boolean {
    if (open && (this.root.ownerDocument?.defaultView?.innerWidth ?? 761) <= 760) this.opened.clear();
    if (open) { this.opened.delete(page); this.opened.add(page); this.panels[page]?.bringToFront(); }
    else this.opened.delete(page);
    for (const [name, trigger] of Object.entries(triggers)) {
      const visible = this.opened.has(name as NotebookPage);
      const panel = this.root.querySelector<HTMLElement>(`#${name}-drawer`);
      if (panel) panel.hidden = !visible;
      this.root.querySelector(`#${trigger}`)?.setAttribute('aria-expanded', String(visible));
    }
    this.root.classList.toggle('notebook-open', this.opened.size > 0);
    this.root.querySelector('#observe-tool')?.setAttribute('aria-pressed', String(this.opened.size === 0));
    if (!open) this.root.querySelector<HTMLElement>(`#${triggers[page]}`)?.focus({ preventScroll: true });
    return open;
  }

  close(): void { for (const page of [...this.opened]) this.show(page, false); }
  destroy(): void { this.root.ownerDocument?.defaultView?.removeEventListener('resize', this.onResize); }
}

/** The focused tab follows the selected tab; no trap and no positive tabindex. */
export function wireTabs(container: HTMLElement, attribute: string, select: (value: string) => void): void {
  const tabs = [...container.querySelectorAll<HTMLButtonElement>(`[${attribute}]`)];
  for (const tab of tabs) {
    tab.addEventListener('click', () => select(tab.getAttribute(attribute)!));
    tab.addEventListener('keydown', event => {
      const available = tabs.filter(item => !item.hidden && !item.disabled), index = available.indexOf(tab);
      let next: HTMLButtonElement | undefined;
      if (event.key === 'ArrowRight') next = available[(index + 1) % available.length];
      else if (event.key === 'ArrowLeft') next = available[(index - 1 + available.length) % available.length];
      else if (event.key === 'Home') next = available[0];
      else if (event.key === 'End') next = available.at(-1);
      if (!next) return;
      event.preventDefault(); select(next.getAttribute(attribute)!); next.focus();
    });
  }
}
