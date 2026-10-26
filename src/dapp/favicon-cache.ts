import { Image, InteractionManager } from 'react-native';
import { faviconStorage } from '../native/favicon-cache.js';
import { base64, decodeIcoToImageDataUri, getDappFaviconUrl, legacyPixelSvgToPng, resolveDappFaviconUrl } from './favicon-image.js';

export interface FaviconImage { uri: string; svg?: string }
interface CachedFavicon { version: 1; origin: string; iconUrl: string; image: FaviconImage }

const MAX_ICONS = 60;
const MAX_MEMORY_CHARS = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 512_000;
const MAX_RECORD_CHARS = 720_000;
const MAX_SVG_CHARS = 128_000;
const RETRY_DELAY = 60_000;
const RESTORE_INTERVAL = 16;
const MAX_RESTORE_READS = 2;
const records = new Map<string, CachedFavicon>();
const reads = new Map<string, Promise<CachedFavicon | null>>();
const writes = new Map<string, Promise<void>>();
const missingRecords = new Map<string, number>();
const loads = new Map<string, Promise<FaviconImage | null>>();
const refreshes = new Map<string, { iconUrl: string; promise: Promise<FaviconImage | null> }>();
const failures = new Map<string, number>();
const listeners = new Map<string, Set<() => void>>();
interface RestoreJob { pageUrl: string; listener: (image: FaviconImage | null) => void; cancelled: boolean }
const restoreQueue = new Set<RestoreJob>();
let restoring = 0;
let restoreScheduled = false;
let restoreInteraction: { cancel: () => void } | undefined;
let restoreTimer: ReturnType<typeof setTimeout> | undefined;

function originFor(pageUrl: string): string | null {
  return getDappFaviconUrl(pageUrl) ? new URL(pageUrl).origin : null;
}

// SVGs remain self-contained so rendering a saved icon cannot fetch resources.
function validSvg(svg: string): boolean {
  return svg.length <= MAX_SVG_CHARS && /<svg[\s>]/i.test(svg)
    && !/<(?:!DOCTYPE|!ENTITY|script\b|foreignObject\b|image\b|feImage\b)/i.test(svg)
    && [...svg.matchAll(/\b(?:href|xlinkHref|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)]
      .every((match) => (match[1] ?? match[2] ?? match[3]).trim().startsWith('#'))
    && [...svg.matchAll(/url\(([^)]*)\)/gi)]
      .every((match) => match[1].trim().replace(/^["']|["']$/g, '').trim().startsWith('#'))
    && !/@import|\bon\w+\s*=/i.test(svg);
}

function validImage(value: unknown): value is FaviconImage {
  if (!value || typeof value !== 'object') return false;
  const image = value as FaviconImage;
  if (typeof image.uri !== 'string') return false;
  if (image.svg !== undefined) return typeof image.svg === 'string' && image.uri === '' && validSvg(image.svg);
  return image.uri.length <= MAX_RECORD_CHARS && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image.uri);
}

function parseRecord(origin: string, raw: string | null): CachedFavicon | null {
  if (!raw || raw.length > MAX_RECORD_CHARS) return null;
  try {
    const value = JSON.parse(raw) as CachedFavicon;
    if (value.version !== 1 || value.origin !== origin || typeof value.iconUrl !== 'string'
      || !resolveDappFaviconUrl(origin, value.iconUrl) || !validImage(value.image)) return null;
    return value;
  } catch { return null; }
}

function remember(record: CachedFavicon): void {
  missingRecords.delete(record.origin);
  records.delete(record.origin);
  records.set(record.origin, record);
  let chars = [...records.values()].reduce((total, item) => total + item.image.uri.length + (item.image.svg?.length ?? 0), 0);
  while (records.size > MAX_ICONS || chars > MAX_MEMORY_CHARS) {
    const oldest = records.keys().next().value!;
    const removed = records.get(oldest)!;
    chars -= removed.image.uri.length + (removed.image.svg?.length ?? 0);
    records.delete(oldest);
  }
}

// Serialize migration and visit writes so a slow old-cache write cannot replace
// the bytes from a newer page visit on disk.
function persistRecord(record: CachedFavicon): Promise<void> {
  const previous = writes.get(record.origin) ?? Promise.resolve();
  const request = previous.catch(() => {}).then(async () => {
    const current = records.get(record.origin);
    if (current && current !== record) return;
    await faviconStorage.write(record.origin, JSON.stringify(record));
  }).finally(() => { if (writes.get(record.origin) === request) writes.delete(record.origin); });
  writes.set(record.origin, request);
  return request;
}

async function readRecord(origin: string): Promise<CachedFavicon | null> {
  const current = records.get(origin);
  if (current) { remember(current); return current; }
  const pending = reads.get(origin);
  if (pending) return pending;
  if ((missingRecords.get(origin) ?? 0) > Date.now()) return null;
  missingRecords.delete(origin);
  const request = (async () => {
    let saved = parseRecord(origin, await faviconStorage.read(origin));
    // A visit may have refreshed the icon while disk I/O was pending.
    const latest = records.get(origin);
    if (latest) return latest;
    if (saved) {
      const migrated = saved.image.svg ? legacyPixelSvgToPng(saved.image.svg) : null;
      if (migrated) saved = { ...saved, image: { uri: migrated } };
      remember(saved);
      if (migrated) void persistRecord(saved);
    } else {
      missingRecords.set(origin, Date.now() + RETRY_DELAY);
      if (missingRecords.size > MAX_ICONS) missingRecords.delete(missingRecords.keys().next().value!);
    }
    return saved;
  })().finally(() => reads.delete(origin));
  reads.set(origin, request);
  return request;
}

function rasterMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp';
  return null;
}

// Validate the saved bytes locally before replacing an icon that already works.
async function readableRaster(uri: string): Promise<FaviconImage | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5_000);
    const finish = (image: FaviconImage | null) => { clearTimeout(timer); resolve(image); };
    try {
      Image.getSize(uri, (width, height) => {
        finish(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
          && width <= 4096 && height <= 4096 ? { uri } : null);
      }, () => finish(null));
    } catch { finish(null); }
  });
}

async function downloadIcon(pageUrl: string, iconUrl: string, refresh: boolean): Promise<FaviconImage | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(iconUrl, {
      signal: controller.signal,
      credentials: 'omit',
      headers: { Accept: 'image/*', ...(refresh ? { 'Cache-Control': 'no-cache' } : {}) },
    });
    if (!response.ok || (response.url && !resolveDappFaviconUrl(pageUrl, response.url))) return null;
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_IMAGE_BYTES) return null;
    const buffer = await response.arrayBuffer();
    if (!buffer.byteLength || buffer.byteLength > MAX_IMAGE_BYTES) return null;
    const decoded = decodeIcoToImageDataUri(buffer);
    if (decoded) return readableRaster(decoded);
    const bytes = new Uint8Array(buffer);
    const mime = rasterMime(bytes);
    if (mime) return readableRaster(`data:image/${mime};base64,${base64(bytes)}`);
    // Some servers omit the SVG content type; accept a bounded self-contained SVG.
    if (buffer.byteLength > MAX_SVG_CHARS) return null;
    const svg = typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(bytes)
      : decodeURIComponent(Array.from(bytes, (value) => `%${value.toString(16).padStart(2, '0')}`).join(''));
    return validSvg(svg) ? { uri: '', svg } : null;
  } catch { return null; }
  finally { clearTimeout(timeout); }
}

function loadIcon(pageUrl: string, iconUrl: string, refresh: boolean): Promise<FaviconImage | null> {
  // Include the visit mode so an old list fetch cannot satisfy a fresh visit.
  const key = `${refresh ? 'visit' : 'list'}:${iconUrl}`;
  const pending = loads.get(key);
  if (pending) return pending;
  const request = downloadIcon(pageUrl, iconUrl, refresh).finally(() => loads.delete(key));
  loads.set(key, request);
  return request;
}

async function updateRecord(origin: string, iconUrl: string, image: FaviconImage): Promise<void> {
  const record: CachedFavicon = { version: 1, origin, iconUrl, image };
  if (!validImage(image)) return;
  const raw = JSON.stringify(record);
  if (raw.length > MAX_RECORD_CHARS) return;
  remember(record);
  for (const listener of listeners.get(origin) ?? []) {
    try { listener(); } catch { /* One unmounted consumer cannot prevent caching. */ }
  }
  await persistRecord(record);
}

export function getCachedDappFavicon(pageUrl: string): FaviconImage | null {
  const origin = originFor(pageUrl);
  return origin ? records.get(origin)?.image ?? null : null;
}

/** Restore saved bytes without starting a request for bundled shortcuts. */
export async function loadCachedDappFavicon(pageUrl: string): Promise<FaviconImage | null> {
  const origin = originFor(pageUrl);
  return origin ? (await readRecord(origin))?.image ?? null : null;
}

function scheduleNextRestore(): void {
  if (restoring >= MAX_RESTORE_READS || restoreScheduled || !restoreQueue.size) return;
  restoreScheduled = true;
  const afterInteraction = () => {
    restoreInteraction = undefined;
    restoreTimer = setTimeout(() => {
      restoreTimer = undefined;
      restoreScheduled = false;
      const job = restoreQueue.values().next().value as RestoreJob | undefined;
      if (!job) return;
      restoreQueue.delete(job);
      restoring += 1;
      void loadCachedDappFavicon(job.pageUrl).then((image) => {
        if (!job.cancelled) job.listener(image);
      }).catch(() => { /* A disposable image must not interrupt the list. */ }).finally(() => {
        restoring -= 1;
        scheduleNextRestore();
      });
      scheduleNextRestore();
    }, RESTORE_INTERVAL);
  };
  if (InteractionManager?.runAfterInteractions) restoreInteraction = InteractionManager.runAfterInteractions(afterInteraction);
  else afterInteraction();
}

/** Start at most one restore per frame with bounded native reads. Warm images
 * remain immediate; leaving a tab removes its queued work before it starts. */
export function scheduleCachedDappFavicon(pageUrl: string, listener: (image: FaviconImage | null) => void): () => void {
  const origin = originFor(pageUrl);
  const current = origin ? records.get(origin)?.image : null;
  if (!origin || current || (missingRecords.get(origin) ?? 0) > Date.now()) {
    listener(current ?? null);
    return () => {};
  }
  const job: RestoreJob = { pageUrl, listener, cancelled: false };
  restoreQueue.add(job);
  scheduleNextRestore();
  return () => {
    job.cancelled = true;
    restoreQueue.delete(job);
    if (!restoreQueue.size && restoreScheduled) {
      restoreInteraction?.cancel();
      restoreInteraction = undefined;
      if (restoreTimer !== undefined) clearTimeout(restoreTimer);
      restoreTimer = undefined;
      restoreScheduled = false;
    }
  };
}

export function subscribeDappFavicon(pageUrl: string, listener: () => void): () => void {
  const origin = originFor(pageUrl);
  if (!origin) return () => {};
  const subscribers = listeners.get(origin) ?? new Set();
  subscribers.add(listener);
  listeners.set(origin, subscribers);
  return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(origin); };
}

/** Lists read saved image bytes; only a cache miss downloads an initial icon. */
export async function ensureDappFavicon(pageUrl: string, declaredUrl?: string): Promise<FaviconImage | null> {
  const origin = originFor(pageUrl);
  if (!origin) return null;
  const saved = await readRecord(origin);
  if (saved) return saved.image;
  if (refreshes.has(origin)) return refreshes.get(origin)!.promise;
  const candidate = resolveDappFaviconUrl(pageUrl, declaredUrl);
  if (!candidate || (failures.get(origin) ?? 0) > Date.now()) return null;
  let loadedUrl = candidate;
  let image = await loadIcon(pageUrl, candidate, false);
  const fallback = getDappFaviconUrl(pageUrl);
  if (!image && fallback && fallback !== candidate) {
    loadedUrl = fallback;
    image = await loadIcon(pageUrl, fallback, false);
  }
  // Successful page metadata always wins over an older list request.
  const visited = records.get(origin);
  if (visited) return visited.image;
  if (refreshes.has(origin)) return refreshes.get(origin)!.promise;
  if (image) { await updateRecord(origin, loadedUrl, image); failures.delete(origin); }
  else {
    failures.set(origin, Date.now() + RETRY_DELAY);
    if (failures.size > MAX_ICONS) failures.delete(failures.keys().next().value!);
  }
  return records.get(origin)?.image ?? image;
}

/** Called only after actual WebView metadata passes the current-page checks. */
export function refreshDappFavicon(pageUrl: string, declaredUrl?: string): Promise<FaviconImage | null> {
  const origin = originFor(pageUrl);
  const iconUrl = resolveDappFaviconUrl(pageUrl, declaredUrl);
  if (!origin || !iconUrl) return Promise.resolve(null);
  const previous = refreshes.get(origin);
  if (previous?.iconUrl === iconUrl) return previous.promise;
  const request = (async () => {
    // Serialize same-origin updates so a slower previous visit cannot win.
    await previous?.promise;
    await readRecord(origin);
    let loadedUrl = iconUrl;
    let image = await loadIcon(pageUrl, iconUrl, true);
    const fallback = getDappFaviconUrl(pageUrl);
    if (!image && !records.has(origin) && fallback && fallback !== iconUrl) {
      loadedUrl = fallback;
      image = await loadIcon(pageUrl, fallback, true);
    }
    if (image) { await updateRecord(origin, loadedUrl, image); failures.delete(origin); return image; }
    return records.get(origin)?.image ?? null;
  })().finally(() => { if (refreshes.get(origin)?.promise === request) refreshes.delete(origin); });
  refreshes.set(origin, { iconUrl, promise: request });
  return request;
}
