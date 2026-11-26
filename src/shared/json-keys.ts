/** Detecta claves repetidas en JSON válido, también si una clave está escapada. */
export function clavesJsonUnicas(body: string): boolean {
  const stack: (Set<string> | null)[] = [];
  const pool: Set<string>[] = [];
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    if (code === 123 /* { */) {
      stack.push(pool.pop() ?? new Set<string>());
    } else if (code === 91 /* [ */) {
      stack.push(null);
    } else if (code === 125 /* } */ || code === 93 /* ] */) {
      const top = stack.pop();
      if (top) { top.clear(); pool.push(top); }
    } else if (code === 34 /* " */) {
      const start = i++;
      let escaped = false;
      for (; i < body.length; i++) {
        const ch = body.charCodeAt(i);
        if (ch === 92 /* \ */) { escaped = true; i++; }
        else if (ch === 34 /* " */) break;
      }
      let next = i + 1;
      while (next < body.length) {
        const ws = body.charCodeAt(next);
        if (ws === 32 || ws === 9 || ws === 10 || ws === 13) next++; else break;
      }
      if (next < body.length && body.charCodeAt(next) === 58 /* : */) {
        const key = escaped ? JSON.parse(body.slice(start, i + 1)) as string : body.slice(start + 1, i);
        const seen = stack[stack.length - 1];
        if (!seen || seen.has(key)) return false;
        seen.add(key);
      }
    }
  }
  return true;
}
