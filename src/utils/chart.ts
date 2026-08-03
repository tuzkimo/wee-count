export interface Pt { x: number; y: number; }

export function computeLinePoints(
  values: number[], w: number, h: number, pad: number, max?: number
): Pt[] {
  const n = values.length;
  const maxVal = (max ?? Math.max(0, ...values)) || 1;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;
  return values.map((v, i) => {
    const x = n <= 1 ? w / 2 : pad + (i / (n - 1)) * innerW;
    const y = h - pad - (Math.max(0, v) / maxVal) * innerH;
    return { x, y };
  });
}

export function niceTicks(max: number, count: number): number[] {
  if (max <= 0) return [0, 1];
  const rawStep = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step * 0.001; v += step) ticks.push(v);
  return ticks;
}

export function donutAngles(values: number[]): { start: number; end: number }[] {
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  const out: { start: number; end: number }[] = [];
  let acc = -Math.PI / 2;
  for (const v of values) {
    const sweep = total > 0 ? (Math.max(0, v) / total) * Math.PI * 2 : (Math.PI * 2) / values.length;
    out.push({ start: acc, end: acc + sweep });
    acc += sweep;
  }
  return out;
}

export function arcPath(
  cx: number, cy: number, rOuter: number, rInner: number,
  start: number, end: number
): string {
  const polar = (r: number, a: number): [number, number] =>
    [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const large = end - start > Math.PI ? 1 : 0;
  const [x1, y1] = polar(rOuter, start);
  const [x2, y2] = polar(rOuter, end);
  const [x3, y3] = polar(rInner, end);
  const [x4, y4] = polar(rInner, start);
  return `M ${x1} ${y1} A ${rOuter} ${rOuter} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${rInner} ${rInner} 0 ${large} 0 ${x4} ${y4} Z`;
}

export function nearestIndex(px: number, xs: number[]): number {
  let best = 0;
  let bestDist = Infinity;
  xs.forEach((x, i) => {
    const d = Math.abs(x - px);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}
