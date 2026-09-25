/** Display-only geometry. The API/ledger remains the source of exact monetary values. */
export function pnlChartGeometry(dailyValues: number[]) {
  if (dailyValues.some((value) => !Number.isFinite(value)))
    throw new Error('Invalid P/L chart value');
  const values = [0, ...dailyValues];
  const low = Math.min(...values);
  const high = Math.max(...values);
  const padding = (high - low || 1) * 0.15;
  const min = low - padding;
  const max = high + padding;
  const y = (value: number) => 20 + ((max - value) / (max - min)) * 160;
  const points = values.map((value, index) => ({
    x: 16 + (index / Math.max(1, values.length - 1)) * 668,
    y: y(value),
  }));
  const line = points
    .map(
      (point, index) =>
        `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.y.toFixed(2)}`,
    )
    .join(' ');
  const zeroY = y(0);
  return {
    line,
    area: `${line} L${points.at(-1)!.x},${zeroY} L16,${zeroY} Z`,
    zeroY,
    low,
    high,
    points,
  };
}
