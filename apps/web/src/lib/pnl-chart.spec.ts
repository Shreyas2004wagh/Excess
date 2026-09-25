import { describe, expect, it } from 'vitest';
import { pnlChartGeometry } from './pnl-chart';

describe('Realized P/L chart geometry', () => {
  it.each(
    [[], [0], [0, 0, 0], [2, 8, 4], [-2, -5, -1], [-3, 7, 0]].map((values) => ({
      values,
    })),
  )('keeps $values finite and starts at zero', ({ values }) => {
    const result = pnlChartGeometry(values);
    expect(result.points).toHaveLength(values.length + 1);
    expect(result.points[0]?.y).toBe(result.zeroY);
    expect(result.line).not.toMatch(/NaN|Infinity/);
    expect(
      result.points.every(
        (point) =>
          point.x >= 16 && point.x <= 684 && point.y >= 20 && point.y <= 180,
      ),
    ).toBe(true);
  });
  it('plots losses below the baseline and gains above it', () => {
    const { points, zeroY } = pnlChartGeometry([-5, 5]);
    expect(points[1]!.y).toBeGreaterThan(zeroY);
    expect(points[2]!.y).toBeLessThan(zeroY);
  });
  it('does not silently turn invalid values into fake zero performance', () => {
    expect(() => pnlChartGeometry([NaN])).toThrow('Invalid P/L chart value');
  });
});
