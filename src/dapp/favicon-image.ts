import { evaluateDappUrl } from './urlPolicy.js';

/** Resolve the conventional favicon for the currently loaded DApp origin. */
export function getDappFaviconUrl(pageUrl: string): string | null {
  try {
    const parsed = new URL(pageUrl);
    if (!evaluateDappUrl(pageUrl, { allowHttp: true }).allowed) return null;
    // A navigation URL can itself be the favicon (for example
    // `/favicon.ico?v=1`). Preserve its query string so cache-busted icons
    // remain addressable instead of being reduced to the origin fallback.
    if (/\/(?:favicon|apple-touch-icon)(?:-[^/?#]+)?\.(?:ico|png|jpe?g|gif|svg)$/i.test(parsed.pathname)) {
      parsed.hash = '';
      return parsed.toString();
    }
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

/** Resolve a rel=icon URL against the document, retaining cache-busting query
 * strings. Icons are display data only; disallow local and executable schemes. */
export function resolveDappFaviconUrl(pageUrl: string, iconUrl?: string): string | null {
  if (!iconUrl) return getDappFaviconUrl(pageUrl);
  try {
    const page = new URL(pageUrl);
    const icon = new URL(iconUrl, pageUrl);
    if (!evaluateDappUrl(pageUrl, { allowHttp: true }).allowed || !evaluateDappUrl(icon.toString(), { allowHttp: true }).allowed) return null;
    if (page.protocol === 'https:' && icon.protocol !== 'https:') return null;
    icon.hash = '';
    return icon.toString();
  } catch { return null; }
}

/** Small HTML-head parser for saved sites that aren't currently in a WebView. */
export function discoverFaviconFromHtml(pageUrl: string, html: string): string | null {
  const head = html.split(/<\/head\s*>/i)[0];
  const tags = head.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const attributes: Record<string, string> = {};
    const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(tag))) attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
    const rel = (attributes.rel ?? '').toLowerCase().split(/\s+/);
    if (!rel.includes('icon') && !rel.includes('apple-touch-icon')) continue;
    const href = attributes.href?.replace(/&amp;/gi, '&').replace(/&#38;/g, '&');
    const url = href ? resolveDappFaviconUrl(pageUrl, href) : null;
    if (url) return url;
  }
  return null;
}

export function base64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const value = (a << 16) | (b << 8) | c;
    output += alphabet[(value >>> 18) & 63] + alphabet[(value >>> 12) & 63]
      + (index + 1 < bytes.length ? alphabet[(value >>> 6) & 63] : '=')
      + (index + 2 < bytes.length ? alphabet[value & 63] : '=');
  }
  return output;
}

/** Extract a PNG entry from an ICO file; Android/iOS Image does not decode ICO consistently. */
function icoToPngDataUri(buffer: ArrayBuffer): string | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 22 || bytes[0] !== 0 || bytes[1] !== 0 || bytes[2] !== 1 || bytes[3] !== 0) return null;
  const view = new DataView(buffer);
  const count = view.getUint16(4, true);
  let best: Uint8Array | null = null;
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    if (entry + 16 > bytes.length) break;
    const length = view.getUint32(entry + 8, true);
    const offset = view.getUint32(entry + 12, true);
    if (length < 8 || offset + length > bytes.length) continue;
    const candidate = bytes.subarray(offset, offset + length);
    if (candidate[0] === 0x89 && candidate[1] === 0x50 && candidate[2] === 0x4e && candidate[3] === 0x47) {
      if (!best || length > best.length) best = candidate;
    }
  }
  return best ? `data:image/png;base64,${base64(best)}` : null;
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) chunk[index + 4] = type.charCodeAt(index);
  chunk.set(data, 8);
  let crc = 0xffffffff;
  for (let index = 4; index < chunk.length - 4; index += 1) crc = crcTable[(crc ^ chunk[index]) & 255] ^ (crc >>> 8);
  view.setUint32(chunk.length - 4, (crc ^ 0xffffffff) >>> 0);
  return chunk;
}

/** Tiny, bounded RGBA PNG encoder. A stored DEFLATE block avoids a compression
 * dependency and lets native Image render one bitmap instead of thousands of
 * SVG path views. At 96×96 the entire scanline payload fits in one block. */
function rgbaToPngDataUri(width: number, height: number, rgba: Uint8Array): string {
  const scanlines = new Uint8Array(height * (width * 4 + 1));
  for (let row = 0; row < height; row += 1) scanlines.set(rgba.subarray(row * width * 4, (row + 1) * width * 4), row * (width * 4 + 1) + 1);
  const compressed = new Uint8Array(scanlines.length + 11);
  // zlib header, final stored block, and its one's-complement length.
  compressed.set([0x78, 0x01, 0x01, scanlines.length & 255, scanlines.length >>> 8, (~scanlines.length) & 255, ((~scanlines.length) >>> 8) & 255]);
  compressed.set(scanlines, 7);
  let a = 1; let b = 0;
  for (const byte of scanlines) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  new DataView(compressed.buffer).setUint32(compressed.length - 4, ((b << 16) | a) >>> 0);
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width); headerView.setUint32(4, height);
  header[8] = 8; header[9] = 6; // 8-bit RGBA, no interlace.
  const chunks = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { png.set(chunk, offset); offset += chunk.length; }
  return `data:image/png;base64,${base64(png)}`;
}

/** Migrate only pixel-run SVGs written by the old ICO decoder. Ordinary SVG
 * artwork remains SVG; strict parsing also prevents interpreting external or
 * executable content during local cache migration. */
export function legacyPixelSvgToPng(svg: string): string | null {
  if (svg.length > 128_000) return null;
  const header = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 ([1-9]\d*) ([1-9]\d*)" shape-rendering="crispEdges">/.exec(svg);
  if (!header || !svg.endsWith('</svg>')) return null;
  const width = Number(header[1]); const height = Number(header[2]);
  if (width > 96 || height > 96) return null;
  const body = svg.slice(header[0].length, -6);
  const path = /<path d="M(0|[1-9]\d*) (0|[1-9]\d*)h([1-9]\d*)v1H(0|[1-9]\d*)z" fill="#([0-9a-f]{6})"(?: fill-opacity="(0\.\d{3})")?\/>/g;
  const rgba = new Uint8Array(width * height * 4);
  let cursor = 0; let previousY = -1; let previousEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = path.exec(body))) {
    if (match.index !== cursor) return null;
    const x = Number(match[1]); const y = Number(match[2]); const run = Number(match[3]);
    if (Number(match[4]) !== x || y >= height || x + run > width || y < previousY || (y === previousY && x < previousEnd)) return null;
    const alpha = match[6] === undefined ? 255 : Math.round(Number(match[6]) * 255);
    if (match[6] !== undefined && (alpha <= 0 || alpha >= 255 || (alpha / 255).toFixed(3) !== match[6])) return null;
    const color = Number.parseInt(match[5], 16);
    for (let column = x; column < x + run; column += 1) rgba.set([color >>> 16, (color >>> 8) & 255, color & 255, alpha], (y * width + column) * 4);
    cursor = path.lastIndex; previousY = y; previousEnd = x + run;
  }
  return cursor === body.length ? rgbaToPngDataUri(width, height, rgba) : null;
}

/**
 * Decode the uncompressed DIB variant used by older favicon.ico files into an
 * PNG data URI. React Native Image does not reliably decode BMP ICO entries.
 */
function icoToBmpPngDataUri(buffer: ArrayBuffer): string | null {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 22 || bytes[0] !== 0 || bytes[1] !== 0 || bytes[2] !== 1 || bytes[3] !== 0) return null;
  const view = new DataView(buffer);
  const count = view.getUint16(4, true);
  let best: { offset: number; end: number; width: number; height: number; area: number } | null = null;
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    if (entry + 16 > bytes.length) break;
    const length = view.getUint32(entry + 8, true);
    const offset = view.getUint32(entry + 12, true);
    if (length < 40 || offset + length > bytes.length || offset + 40 > bytes.length) continue;
    const headerSize = view.getUint32(offset, true);
    const width = view.getInt32(offset + 4, true);
    const storedHeight = view.getInt32(offset + 8, true);
    const bits = view.getUint16(offset + 14, true);
    const compression = view.getUint32(offset + 16, true);
    const height = Math.floor(Math.abs(storedHeight) / 2);
    if (headerSize < 40 || headerSize > length || width <= 0 || height <= 0 || width > 96 || height > 96 || Math.abs(storedHeight) % 2 !== 0 || compression !== 0 || ![1, 4, 8, 24, 32].includes(bits)) continue;
    const candidate = { offset, end: offset + length, width, height, area: width * height };
    if (!best || candidate.area > best.area) best = candidate;
  }
  if (!best) return null;
  const { offset, end, width, height } = best;
  const storedHeight = view.getInt32(offset + 8, true);
  const headerSize = view.getUint32(offset, true);
  const bits = view.getUint16(offset + 14, true);
  const colorsUsed = view.getUint32(offset + 32, true) || (1 << bits);
  const paletteEntries = bits <= 8 ? Math.min(colorsUsed, 1 << bits) : 0;
  const paletteOffset = offset + headerSize;
  const pixelOffset = paletteOffset + paletteEntries * 4;
  const stride = Math.ceil((width * bits) / 32) * 4;
  const pixelBytes = stride * height;
  const maskOffset = pixelOffset + pixelBytes;
  if (pixelOffset + pixelBytes > end) return null;
  // Use the alpha channel when the writer actually populated it. Only an
  // entirely empty channel should fall back to the legacy AND mask.
  let usesAlpha = false;
  if (bits === 32) {
    for (let row = 0; row < height && !usesAlpha; row += 1) {
      for (let x = 0; x < width; x += 1) {
        if (bytes[pixelOffset + row * stride + x * 4 + 3] > 0) { usesAlpha = true; break; }
      }
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  const readIndex = (x: number, row: number): number => {
    const position = pixelOffset + row * stride;
    if (bits === 8) return bytes[position + x];
    if (bits === 4) { const value = bytes[position + Math.floor(x / 2)]; return x % 2 ? value & 0x0f : value >>> 4; }
    if (bits === 1) return (bytes[position + Math.floor(x / 8)] >>> (7 - (x % 8))) & 1;
    return 0;
  };
  const pixel = (x: number, y: number): [number, number, number, number] => {
    const row = storedHeight < 0 ? y : height - 1 - y;
    let red = 0; let green = 0; let blue = 0; let alpha = 255;
    if (bits <= 8) {
      const index = readIndex(x, row);
      if (index >= paletteEntries) return [0, 0, 0, 0];
      const palette = paletteOffset + index * 4;
      blue = bytes[palette]; green = bytes[palette + 1]; red = bytes[palette + 2];
    } else {
      const position = pixelOffset + row * stride + x * (bits / 8);
      blue = bytes[position]; green = bytes[position + 1]; red = bytes[position + 2];
      alpha = bits === 32 && usesAlpha ? bytes[position + 3] : 255;
    }
    // Some ICO encoders leave every 32-bit alpha byte at zero. In that case,
    // the 1-bit AND mask is the transparency source instead.
    const maskStride = Math.ceil(width / 32) * 4;
    if (maskOffset + maskStride * height <= end) {
      const maskRow = storedHeight < 0 ? y : height - 1 - y;
      const mask = bytes[maskOffset + maskRow * maskStride + Math.floor(x / 8)];
      if (mask & (0x80 >>> (x % 8))) alpha = 0;
    }
    return [red, green, blue, alpha];
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rgba.set(pixel(x, y), (y * width + x) * 4);
  }
  return rgbaToPngDataUri(width, height, rgba);
}

export function decodeIcoToImageDataUri(buffer: ArrayBuffer): string | null {
  return icoToPngDataUri(buffer) ?? icoToBmpPngDataUri(buffer);
}

export function faviconForPageUrl(pageUrl: string): string | null {
  return getDappFaviconUrl(pageUrl);
}

