/* Offline checks for the favicon URL guard and ICO decoders. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const modules = new Map();
function load(relativePath) {
  const filename = path.join(root, relativePath);
  if (modules.has(filename)) return modules.get(filename).exports;
  const fixtureModule = { exports: {} };
  modules.set(filename, fixtureModule);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(code, {
    module: fixtureModule, exports: fixtureModule.exports, URL, encodeURIComponent,
    require(name) {
      assert.ok(name.startsWith('.'), `Unexpected favicon dependency: ${name}`);
      return load(path.relative(root, path.resolve(path.dirname(filename), name.replace(/\.js$/, '.ts'))));
    },
  }, { filename });
  return fixtureModule.exports;
}
const { decodeIcoToImageDataUri, discoverFaviconFromHtml, getDappFaviconUrl, resolveDappFaviconUrl, legacyPixelSvgToPng } = load('src/dapp/favicon-image.ts');

function pngIco() {
  const image = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const bytes = new Uint8Array(22 + image.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, 1, true); view.setUint8(6, 1); view.setUint8(7, 1); view.setUint8(8, 32); view.setUint8(9, 0); view.setUint16(10, 1, true);
  view.setUint32(14, image.length, true); view.setUint32(18, 22, true); bytes.set(image, 22);
  return bytes.buffer;
}

function bmpIco({ width = 2, height = 2, bits = 24, topDown = false, pixels, palette = [], indices, mask = [] } = {}) {
  const pixelStride = Math.ceil(width * bits / 32) * 4;
  const maskStride = Math.ceil(width / 32) * 4;
  const image = new Uint8Array(40 + palette.length * 4 + pixelStride * height + maskStride * height);
  const view = new DataView(image.buffer);
  view.setUint32(0, 40, true); view.setInt32(4, width, true); view.setInt32(8, height * (topDown ? -2 : 2), true);
  view.setUint16(12, 1, true); view.setUint16(14, bits, true); view.setUint32(32, palette.length, true);
  palette.forEach(([red, green, blue], index) => image.set([blue, green, red, 0], 40 + index * 4));
  const pixelOffset = 40 + palette.length * 4;
  for (let y = 0; y < height; y += 1) {
    const storedRow = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const position = pixelOffset + storedRow * pixelStride;
      if (bits >= 24) {
        const [red, green, blue, alpha = 255] = pixels[index];
        image.set(bits === 32 ? [blue, green, red, alpha] : [blue, green, red], position + x * bits / 8);
      } else if (bits === 8) image[position + x] = indices[index];
      else if (bits === 4) image[position + Math.floor(x / 2)] |= indices[index] << (x % 2 ? 0 : 4);
      else image[position + Math.floor(x / 8)] |= indices[index] << (7 - x % 8);
      if (mask[index]) image[pixelOffset + pixelStride * height + storedRow * maskStride + Math.floor(x / 8)] |= 0x80 >>> (x % 8);
    }
  }
  const bytes = new Uint8Array(22 + image.length); const header = new DataView(bytes.buffer);
  header.setUint16(2, 1, true); header.setUint16(4, 1, true); header.setUint8(6, width); header.setUint8(7, height); header.setUint16(10, 1, true);
  header.setUint32(14, image.length, true); header.setUint32(18, 22, true); bytes.set(image, 22);
  return bytes.buffer;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Independent PNG reader: validate CRCs, have node's zlib verify DEFLATE and
// Adler32, then inspect the actual unfiltered RGBA scanlines.
function readPng(uri) {
  assert.match(uri, /^data:image\/png;base64,/);
  const bytes = Buffer.from(uri.split(',')[1], 'base64');
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const compressed = [];
  let width, height, ended = false;
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(bytes.readUInt32BE(offset + 8 + length), crc32(bytes.subarray(offset + 4, offset + 8 + length)), `${type} CRC32`);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.deepEqual([...data.subarray(8)], [8, 6, 0, 0, 0]);
    } else if (type === 'IDAT') compressed.push(data);
    else if (type === 'IEND') { assert.equal(length, 0); ended = true; }
    else assert.fail(`Unexpected PNG chunk ${type}`);
    offset += length + 12;
    assert.ok(offset <= bytes.length);
    if (ended) assert.equal(offset, bytes.length);
  }
  assert.ok(ended);
  const raw = zlib.inflateSync(Buffer.concat(compressed));
  assert.equal(raw.length, height * (width * 4 + 1));
  const pixels = [];
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    assert.equal(raw[row], 0);
    for (let x = 0; x < width; x += 1) pixels.push([...raw.subarray(row + 1 + x * 4, row + 5 + x * 4)]);
  }
  return { width, height, pixels };
}

assert.equal(getDappFaviconUrl('https://example.com/app'), 'https://example.com/favicon.ico');
assert.equal(getDappFaviconUrl('https://example.com/favicon.ico?v=1'), 'https://example.com/favicon.ico?v=1');
assert.equal(getDappFaviconUrl('https://example.com/favicon.ico?v=1#icon'), 'https://example.com/favicon.ico?v=1');
assert.equal(getDappFaviconUrl('javascript:alert(1)'), null);
assert.equal(getDappFaviconUrl('https://user:secret@example.com/app'), null);
assert.equal(getDappFaviconUrl('https://127.0.0.1/app'), null);
assert.equal(getDappFaviconUrl('https://192.168.1.1/app'), null);
assert.equal(getDappFaviconUrl('https://[::1]/app'), null);
assert.equal(resolveDappFaviconUrl('https://example.com/', './favicon.ico?v=1'), 'https://example.com/favicon.ico?v=1');
assert.equal(resolveDappFaviconUrl('https://example.com/', 'javascript:alert(1)'), null);
assert.equal(resolveDappFaviconUrl('https://example.com/', 'http://example.com/icon.png'), null);
assert.equal(resolveDappFaviconUrl('https://example.com/', 'https://user:secret@cdn.example.com/icon.png'), null);
assert.equal(resolveDappFaviconUrl('https://example.com/', 'https://10.0.0.1/icon.png'), null);
assert.equal(resolveDappFaviconUrl('https://example.com/', 'https://localhost/icon.png'), null);
assert.equal(discoverFaviconFromHtml('https://example.com/', '<head><link rel="shortcut icon" href="./favicon.ico?v=1" type="image/x-icon" /></head>'), 'https://example.com/favicon.ico?v=1');
assert.equal(discoverFaviconFromHtml('https://example.com/app/', "<link href='../icon.png?v=1&amp;size=32' rel='icon'>"), 'https://example.com/icon.png?v=1&size=32');
assert.equal(discoverFaviconFromHtml('https://example.com/', '<head><link rel="stylesheet" href="/app.css" /></head>'), null);
const png = decodeIcoToImageDataUri(pngIco()); assert.ok(png && png.startsWith('data:image/png;base64,'));
const pixels = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]];
for (const topDown of [false, true]) {
  assert.deepEqual(readPng(decodeIcoToImageDataUri(bmpIco({ pixels, topDown }))), { width: 2, height: 2, pixels }, '24-bit BGR orientation');
  const rgba = pixels.map((pixel, index) => [...pixel.slice(0, 3), [128, 0, 64, 255][index]]);
  assert.deepEqual(readPng(decodeIcoToImageDataUri(bmpIco({ bits: 32, pixels: rgba, topDown, mask: [false, false, true, false] }))).pixels,
    [rgba[0], rgba[1], [...rgba[2].slice(0, 3), 0], rgba[3]], '32-bit partial alpha and AND mask');
}
assert.deepEqual(readPng(decodeIcoToImageDataUri(bmpIco({ bits: 32, pixels: pixels.map((pixel) => [...pixel.slice(0, 3), 0]), mask: [false, true] }))).pixels,
  [pixels[0], [0, 255, 0, 0], pixels[2], pixels[3]], 'Entirely empty alpha falls back to AND mask');
for (const bits of [1, 4, 8]) {
  const palette = bits === 1 ? pixels.slice(0, 2) : pixels;
  const indices = bits === 1 ? [0, 1, 1, 0] : [0, 1, 2, 3];
  const actual = readPng(decodeIcoToImageDataUri(bmpIco({ bits, palette, indices, mask: [false, false, false, true] })));
  assert.deepEqual(actual.pixels, indices.map((index, position) => [...palette[index].slice(0, 3), position === 3 ? 0 : 255]), `${bits}-bit palette and mask`);
}
const dense = Array.from({ length: 96 * 96 }, (_, index) => [index & 255, (index >>> 3) & 255, (index >>> 7) & 255, index % 256]);
const denseUri = decodeIcoToImageDataUri(bmpIco({ width: 96, height: 96, bits: 32, pixels: dense }));
assert.deepEqual(readPng(denseUri).pixels, dense, 'Largest supported ICO remains a single accurate bitmap');
assert.ok(denseUri.length < 50_000);
assert.equal(decodeIcoToImageDataUri(bmpIco({ width: 97, height: 1, pixels: Array.from({ length: 97 }, () => pixels[0]) })), null);
const truncated = new Uint8Array(bmpIco({ pixels }));
new DataView(truncated.buffer).setUint32(14, 40, true);
assert.equal(decodeIcoToImageDataUri(truncated.buffer), null, 'DIB cannot read past its declared ICO entry');

const legacyHead = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2" shape-rendering="crispEdges">';
const legacy = `${legacyHead}<path d="M0 0h2v1H0z" fill="#ff0000"/><path d="M1 1h1v1H1z" fill="#0000ff" fill-opacity="0.502"/></svg>`;
assert.deepEqual(readPng(legacyPixelSvgToPng(legacy)), { width: 2, height: 2, pixels: [[255, 0, 0, 255], [255, 0, 0, 255], [0, 0, 0, 0], [0, 0, 255, 128]] }, 'Legacy cached pixel runs preserve color, transparency and partial alpha');
assert.deepEqual(readPng(legacyPixelSvgToPng(`${legacyHead}</svg>`)).pixels, Array.from({ length: 4 }, () => [0, 0, 0, 0]));
for (const svg of [
  '<svg viewBox="0 0 2 2"><path d="M0 0h2v1H0z" fill="#ff0000"/></svg>',
  legacy.replace('h2', 'h3'), legacy.replace('H0z', 'H1z'), legacy.replace('0.502', '0.500'),
  legacy.replace('</svg>', '<script>alert(1)</script></svg>'),
  legacy.replace('<path', '<path onload="bad()"'), legacy.replace('fill="#ff0000"', 'fill="url(https://example.com/icon)"'),
  legacy.replace('</svg>', '<path d="M0 0h1v1H0z" fill="#ffffff"/></svg>'),
  legacy.replace('0 0 2 2', '0 0 97 2'),
]) assert.equal(legacyPixelSvgToPng(svg), null, 'Ordinary, malformed, overlapping or unsafe SVG remains outside the migration');
assert.equal(decodeIcoToImageDataUri(new ArrayBuffer(12)), null);
console.log('Favicon verification passed: URL guards, icon discovery, PNG ICO, DIB palettes/orientation/alpha/masks, PNG CRC32/Adler32/pixels and strict legacy SVG migration.');

