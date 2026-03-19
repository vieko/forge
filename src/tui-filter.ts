export interface ParsedTuiFilterQuery {
  textTerms: string[];
  tokens: Map<string, string[]>;
}

export function parseTuiFilterQuery(query: string): ParsedTuiFilterQuery {
  const textTerms: string[] = [];
  const tokens = new Map<string, string[]>();

  for (const rawPart of query.trim().split(/\s+/).filter(Boolean)) {
    const part = rawPart.toLowerCase();
    const tokenIndex = part.indexOf(':');
    if (tokenIndex > 0 && tokenIndex < part.length - 1) {
      const key = part.slice(0, tokenIndex);
      const value = part.slice(tokenIndex + 1);
      const existing = tokens.get(key) ?? [];
      existing.push(value);
      tokens.set(key, existing);
    } else {
      textTerms.push(part);
    }
  }

  return { textTerms, tokens };
}

export function matchesTuiParsedFilter(
  parsed: ParsedTuiFilterQuery,
  textFields: Array<string | undefined>,
  tokenFields: Record<string, string | undefined> = {},
): boolean {
  const haystack = textFields.filter(Boolean).join(' ').toLowerCase();

  for (const term of parsed.textTerms) {
    if (!haystack.includes(term)) return false;
  }

  for (const [key, values] of parsed.tokens.entries()) {
    const field = (tokenFields[key] ?? '').toLowerCase();
    if (!field) return false;
    for (const value of values) {
      if (!field.includes(value)) return false;
    }
  }

  return true;
}

export function nextTuiFilterValue(
  current: string,
  key: { name?: string; sequence?: string; ctrl?: boolean; meta?: boolean },
): string | null {
  if (key.name === 'escape') return '';
  if (key.name === 'return') return current;
  if (key.name === 'backspace') return current.slice(0, -1);
  if (key.ctrl || key.meta) return null;

  const ch = key.sequence ?? '';
  if (ch && ch >= ' ' && ch !== '\u007f') {
    return current + ch;
  }

  return null;
}

export function setOrToggleTuiFilterToken(query: string, key: string, value: string): string {
  const parsed = parseTuiFilterQuery(query);
  const current = parsed.tokens.get(key) ?? [];
  if (current.length === 1 && current[0] === value) {
    parsed.tokens.delete(key);
  } else {
    parsed.tokens.set(key, [value]);
  }

  const parts = [...parsed.textTerms];
  for (const [tokenKey, values] of parsed.tokens.entries()) {
    for (const tokenValue of values) {
      parts.push(`${tokenKey}:${tokenValue}`);
    }
  }
  return parts.join(' ').trim();
}
