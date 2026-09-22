/** Comas de asignaciones o de un barrido; las de JSON pertenecen al valor. */
export function splitParamList(input: string): string[] {
  const pieces: string[] = [], brackets: string[] = [];
  let start = 0, quoted = false, escaped = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '[' || char === '{') brackets.push(char);
    else if (char === ']' || char === '}') {
      if (brackets.pop() !== (char === ']' ? '[' : '{')) throw new Error('Formato de parámetros inválido: delimitadores JSON desequilibrados.');
    } else if (char === ',' && brackets.length === 0) {
      pieces.push(input.slice(start, index).trim()); start = index + 1;
    }
  }
  if (quoted || brackets.length) throw new Error('Formato de parámetros inválido: cadena o delimitador JSON sin cerrar.');
  pieces.push(input.slice(start).trim());
  return pieces;
}
