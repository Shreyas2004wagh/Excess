import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const directory = new URL('../src/app/', import.meta.url);
const source = await readFile(new URL('icon.svg', directory));
const dimensions = [16, 32, 48];
const images = await Promise.all(
  dimensions.map((size) => sharp(source).resize(size, size).png().toBuffer()),
);

// ICO supports embedded PNGs. Include native sizes instead of scaling one image.
const header = Buffer.alloc(6 + images.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
let offset = header.length;
for (const [index, image] of images.entries()) {
  const entry = 6 + index * 16;
  header[entry] = dimensions[index];
  header[entry + 1] = dimensions[index];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(image.length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += image.length;
}

const assets = new Map([
  ['favicon.ico', Buffer.concat([header, ...images])],
  [
    'apple-icon.png',
    await sharp(source)
      .resize(180, 180)
      // iOS supplies the rounded mask; keep the touch icon opaque to the edges.
      .flatten({ background: '#b6ed72' })
      .png()
      .toBuffer(),
  ],
]);

for (const [name, contents] of assets) {
  const target = new URL(name, directory);
  if (process.argv.includes('--check')) {
    const existing = await readFile(target);
    if (!existing.equals(contents)) {
      throw new Error(
        `${name} is stale. Run pnpm --filter @excess/web icons:generate.`,
      );
    }
  } else {
    await writeFile(target, contents);
  }
}
console.log(
  process.argv.includes('--check')
    ? 'App icons are up to date.'
    : 'App icons generated.',
);
