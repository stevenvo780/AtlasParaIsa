export type NotebookPage = 'population' | 'inspector' | 'layer' | 'tool' | 'stats';

const triggers: Record<NotebookPage, string> = {
  population: 'population-toggle', inspector: 'inspector-toggle', layer: 'layer-toggle',
  tool: 'intervene-toggle', stats: 'stats-toggle',
};

/** One visible page, one return point. Opening the notebook never changes the world. */
export class Notebook {
  private active: NotebookPage | null = null;
  constructor(private readonly root: HTMLElement) {}

  show(page: NotebookPage, open = this.active !== page): boolean {
    this.active = open ? page : this.active === page ? null : this.active;
    for (const [name, trigger] of Object.entries(triggers)) {
      const visible = this.active === name;
      this.root.querySelector<HTMLElement>(`#${name}-drawer`)!.hidden = !visible;
      this.root.querySelector(`#${trigger}`)!.setAttribute('aria-expanded', String(visible));
    }
    this.root.classList.toggle('notebook-open', this.active !== null);
    this.root.querySelector('#observe-tool')!.setAttribute('aria-pressed', String(this.active === null));
    if (!open && this.active === null) this.root.querySelector<HTMLElement>(`#${triggers[page]}`)?.focus({ preventScroll: true });
    return open;
  }

  close(): void { if (this.active) this.show(this.active, false); }
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
