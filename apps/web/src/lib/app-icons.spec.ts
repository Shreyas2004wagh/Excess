import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

const directory = new URL('../app/', import.meta.url);

describe('Excess app icons', () => {
  it('uses the existing brand mark and accent in the scalable favicon', async () => {
    const source = await readFile(new URL('icon.svg', directory), 'utf8');
    expect(source).toContain('viewBox="0 0 32 32"');
    expect(source).toContain('fill="#b6ed72"');
    expect(source).toContain('fill="#10130d"');
    expect(source).not.toMatch(/(?:href|src)=/);
  });

  it('includes valid 16, 32, and 48 pixel PNGs in the ICO fallback', async () => {
    const icon = await readFile(new URL('favicon.ico', directory));
    expect(icon.readUInt16LE(0)).toBe(0);
    expect(icon.readUInt16LE(2)).toBe(1);
    expect(icon.readUInt16LE(4)).toBe(3);
    for (const [index, size] of [16, 32, 48].entries()) {
      const entry = 6 + index * 16;
      expect(icon[entry]).toBe(size);
      expect(icon[entry + 1]).toBe(size);
      const length = icon.readUInt32LE(entry + 8);
      const offset = icon.readUInt32LE(entry + 12);
      expect(offset + length).toBeLessThanOrEqual(icon.length);
      const metadata = await sharp(
        icon.subarray(offset, offset + length),
      ).metadata();
      expect(metadata).toMatchObject({
        format: 'png',
        width: size,
        height: size,
      });
    }
  });

  it('provides an opaque 180 pixel Apple touch icon', async () => {
    const metadata = await sharp(
      new URL('apple-icon.png', directory).pathname,
    ).metadata();
    expect(metadata).toMatchObject({
      format: 'png',
      width: 180,
      height: 180,
      hasAlpha: false,
    });
  });
});
