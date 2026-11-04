import { deflateSync } from 'node:zlib';
import type { Plugin } from 'vite';

// The launch screens an iPhone shows while the installed app opens. iOS needs a picture
// of exactly the screen's size, or it shows white. Each is plain: the theme's background,
// light or dark as the phone is set, and the app's own first screen (index.html) then
// draws the logo on the same colour. Made at build time; Android takes its launch screen
// from manifest.webmanifest instead.

/** The app's backgrounds (--sf-bg in theme/tokens.css), as index.html uses them too */
export const LAUNCH_BACKGROUNDS = { dark: '#161826', light: '#eceef6' } as const;

/** iPhones by screen, in CSS pixels and pixel ratio */
const IPHONES: [width: number, height: number, ratio: number][] = [
  [440, 956, 3], // 16 Pro Max
  [402, 874, 3], // 16 Pro
  [430, 932, 3], // 14 Pro Max, 15 Plus and Pro Max, 16 Plus
  [393, 852, 3], // 14 Pro, 15, 15 Pro, 16
  [428, 926, 3], // 12 and 13 Pro Max, 14 Plus
  [390, 844, 3], // 12, 13, 14, and their Pros
  [375, 812, 3], // X, XS, 11 Pro, 12 and 13 mini
  [414, 896, 3], // XS Max, 11 Pro Max
  [414, 896, 2], // XR, 11
  [375, 667, 2], // 6, 7, 8, SE
];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Uint8Array) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

/** A PNG of one colour: one bit per pixel against a one-colour palette, so it stays tiny */
export function solidPng(width: number, height: number, hex: string) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([1, 3, 0, 0, 0], 8); // bit depth 1, palette colour
  const palette = Buffer.from(hex.slice(1), 'hex');
  // Each row: no filter, then every pixel the first palette entry
  const rows = Buffer.alloc((1 + Math.ceil(width / 8)) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('PLTE', palette),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', new Uint8Array()),
  ]);
}

const images = IPHONES.flatMap(([width, height, ratio]) =>
  (['dark', 'light'] as const).map((scheme) => ({
    file: `launch/${scheme}-${width * ratio}x${height * ratio}.png`,
    size: [width * ratio, height * ratio] as const,
    background: LAUNCH_BACKGROUNDS[scheme],
    media:
      `(device-width: ${width}px) and (device-height: ${height}px) and ` +
      `(-webkit-device-pixel-ratio: ${ratio}) and (orientation: portrait) and ` +
      `(prefers-color-scheme: ${scheme})`,
  })),
);

/** Adds the launch screens to the build, and the links to them to index.html */
export function launchImages(): Plugin {
  return {
    name: 'mahnee-launch-images',
    apply: 'build',
    transformIndexHtml: () =>
      images.map(({ file, media }) => ({
        tag: 'link',
        attrs: { rel: 'apple-touch-startup-image', href: `/${file}`, media },
        injectTo: 'head',
      })),
    generateBundle() {
      for (const { file, size, background } of images) {
        this.emitFile({ type: 'asset', fileName: file, source: solidPng(...size, background) });
      }
    },
  };
}
