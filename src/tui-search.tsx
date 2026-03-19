import { Fragment } from 'react';

export interface LineSearchData {
  ranges: Array<[number, number]>;
  matchCount: number;
  activeRangeIndex: number;
}

export function buildLineSearchData(
  lines: string[],
  query: string,
  activeMatchIndex: number,
): { totalMatches: number; perLine: LineSearchData[] } {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return {
      totalMatches: 0,
      perLine: lines.map(() => ({ ranges: [], matchCount: 0, activeRangeIndex: -1 })),
    };
  }

  let totalMatches = 0;
  const lineRanges = lines.map((line) => {
    const lower = line.toLowerCase();
    const ranges: Array<[number, number]> = [];
    let fromIndex = 0;
    while (fromIndex < lower.length) {
      const idx = lower.indexOf(trimmed, fromIndex);
      if (idx === -1) break;
      ranges.push([idx, idx + trimmed.length]);
      fromIndex = idx + trimmed.length;
    }
    totalMatches += ranges.length;
    return ranges;
  });

  let cursor = 0;
  const normalizedActive =
    totalMatches > 0 && activeMatchIndex >= 0 && activeMatchIndex < totalMatches
      ? activeMatchIndex
      : -1;
  const perLine = lineRanges.map((ranges) => {
    const start = cursor;
    cursor += ranges.length;
    return {
      ranges,
      matchCount: ranges.length,
      activeRangeIndex: normalizedActive >= start && normalizedActive < cursor && ranges.length > 0
        ? normalizedActive - start
        : -1,
    };
  });

  return { totalMatches, perLine };
}

export function renderHighlightedText(
  line: string,
  ranges: Array<[number, number]>,
  baseColor: string,
  highlightColor: string,
  activeRangeIndex = -1,
  activeTextColor = '#1b1f27',
) {
  if (ranges.length === 0) {
    return <span fg={baseColor}>{line}</span>;
  }

  const parts: Array<{ text: string; highlight: boolean; active: boolean }> = [];
  let cursor = 0;
  for (const [rangeIndex, [start, end]] of ranges.entries()) {
    if (start > cursor) {
      parts.push({ text: line.slice(cursor, start), highlight: false, active: false });
    }
    parts.push({ text: line.slice(start, end), highlight: true, active: rangeIndex === activeRangeIndex });
    cursor = end;
  }
  if (cursor < line.length) {
    parts.push({ text: line.slice(cursor), highlight: false, active: false });
  }

  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={`${line}-${index}-${part.highlight ? 'h' : 'n'}`}>
          <span
            fg={part.highlight ? (part.active ? activeTextColor : highlightColor) : baseColor}
            bg={part.active ? highlightColor : undefined}
          >
            {part.text}
          </span>
        </Fragment>
      ))}
    </>
  );
}
