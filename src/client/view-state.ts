const identityAttributes = ['data-parent', 'data-person-link', 'data-recipe', 'data-community', 'data-place-x', 'data-place-y', 'data-community-card'];

/** Preserve the reader, not the old HTML: all data is still replaced from the snapshot. */
export function retainViewState(container: HTMLElement): () => void {
  const scroll = container.scrollTop;
  const open = new Set([...container.querySelectorAll<HTMLDetailsElement>('details[open]')].map(detail=>detail.dataset.detail));
  const active = container.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const detailId = active?.closest<HTMLDetailsElement>('details')?.dataset.detail;
  const eventId = active?.closest<HTMLElement>('[data-event-id]')?.dataset.eventId;
  const identity = active ? identityAttributes.filter(attribute=>active.hasAttribute(attribute)).map(attribute=>[attribute,active.getAttribute(attribute)!] as const) : [];
  return () => {
    for (const detail of container.querySelectorAll<HTMLDetailsElement>('details')) if (open.has(detail.dataset.detail)) detail.open = true;
    if (active) {
      const detail = [...container.querySelectorAll<HTMLDetailsElement>('details')].find(detail=>detail.dataset.detail===detailId);
      const event = [...container.querySelectorAll<HTMLElement>('[data-event-id]')].find(event=>event.dataset.eventId===eventId);
      const scope = detail ?? event ?? container;
      const target = identity.length ? [...scope.querySelectorAll<HTMLElement>('button, [tabindex]')].find(item=>identity.every(([attribute,value])=>item.getAttribute(attribute)===value)) : detail?.querySelector<HTMLElement>('summary');
      (target ?? container).focus({ preventScroll: true });
    }
    container.scrollTop = scroll;
  };
}
