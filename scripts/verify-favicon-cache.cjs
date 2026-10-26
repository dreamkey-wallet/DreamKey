/* Offline checks against the production favicon cache. Only public image fixtures are used. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const page = 'https://example.com/app';
const icon = 'https://example.com/favicon.ico';
const png = (marker) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker]);
const dataUri = (bytes) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
const firstImage = png(1), nextImage = png(2), lateImage = png(3);

function response(bytes = firstImage, options = {}) {
  return {
    ok: options.ok ?? true,
    url: options.url ?? icon,
    headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(options.length ?? bytes.byteLength) : null },
    async arrayBuffer() {
      options.onRead?.();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function scheduler() {
  let now = 0, nextId = 0;
  const tasks = new Map();
  const interactions = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) { const id = ++nextId; tasks.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    InteractionManager: { runAfterInteractions(callback) {
      const id = ++nextId; interactions.set(id, callback);
      return { cancel() { interactions.delete(id); } };
    } },
    interact() { const callbacks = [...interactions.values()]; interactions.clear(); callbacks.forEach((callback) => callback()); },
    advance(ms) {
      now += ms;
      for (const [id, task] of [...tasks]) if (task.at <= now) { tasks.delete(id); task.callback(); }
    },
    get pendingInteractions() { return interactions.size; },
  };
}

// A fresh module graph represents restarting the app; the supplied disk survives.
function fixture(options = {}) {
  const disk = options.disk ?? new Map();
  const calls = [], reads = [], writes = [], decodedUris = [];
  let fetchImpl = options.fetch ?? (() => response());
  const native = options.nativeAvailable === false ? {} : {
    DreamKeyFaviconCache: {
      async read(key) {
        reads.push(key);
        if (options.failRead) throw new Error('Public cache unavailable');
        if (options.read) return options.read(key);
        return disk.get(key) ?? null;
      },
      async write(key, value) {
        writes.push({ key, value });
        if (options.failWrite) throw new Error('Public cache full');
        if (options.write) await options.write(key, value);
        disk.set(key, value);
        return true;
      },
    },
  };
  const modules = new Map();
  function load(relativePath) {
    const filename = path.join(root, relativePath);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    vm.runInNewContext(code, {
      module, exports: module.exports, URL, AbortController, TextDecoder,
      Uint8Array, ArrayBuffer, DataView,
      setTimeout: options.scheduler?.setTimeout ?? setTimeout,
      clearTimeout: options.scheduler?.clearTimeout ?? clearTimeout,
      Date: options.scheduler ? { now: options.scheduler.now } : Date,
      encodeURIComponent, decodeURIComponent,
      async fetch(url, init) { calls.push({ url, init }); return fetchImpl(url, init); },
      require(name) {
        if (name === 'react-native') return {
          NativeModules: native,
          InteractionManager: options.scheduler?.InteractionManager,
          Image: {
            getSize(uri, success, failure) {
              assert.match(uri, /^data:image\/(?:png|jpeg|gif|webp);base64,/, 'The image decoder only receives local data bytes');
              decodedUris.push(uri);
              if (options.decoderFailure) { failure(new Error('Unreadable image bytes')); return; }
              success(...(options.dimensions ?? [16, 16]));
            },
          },
        };
        assert.ok(name.startsWith('.'), `Unexpected favicon dependency: ${name}`);
        return load(path.relative(root, path.resolve(path.dirname(filename), name.replace(/\.js$/, '.ts'))));
      },
    }, { filename });
    return module.exports;
  }
  return {
    cache: load('src/dapp/favicon-cache.ts'), disk, calls, reads, writes, decodedUris,
    setFetch(callback) { fetchImpl = callback; },
  };
}

async function started(predicate) {
  for (let index = 0; index < 30; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail('Expected asynchronous favicon work did not start');
}

async function main() {
  const bundled = fixture({ fetch: () => { throw new Error('Bundled shortcuts must never fetch on entry'); } });
  assert.equal(await bundled.cache.loadCachedDappFavicon(page), null);
  assert.equal(await bundled.cache.loadCachedDappFavicon(page), null);
  assert.equal(bundled.calls.length, 0, 'First launch and repeated shortcut entry remain offline');
  assert.equal(bundled.reads.length, 1, 'A short negative cache avoids repeated reads for missing icons');

  const clock = scheduler();
  const missing = fixture({ scheduler: clock });
  assert.equal(await missing.cache.loadCachedDappFavicon(page), null);
  assert.equal(await missing.cache.loadCachedDappFavicon(page), null);
  assert.equal(missing.reads.length, 1);
  clock.advance(60_001);
  await missing.cache.loadCachedDappFavicon(page);
  assert.equal(missing.reads.length, 2, 'A missing disk entry is retried after the bounded cooldown');
  const missingVisit = await missing.cache.refreshDappFavicon(page);
  assert.equal(missingVisit.uri, dataUri(firstImage), 'The negative cache never blocks an explicit page visit');
  const boundedMissing = fixture({ scheduler: scheduler() });
  for (let number = 0; number < 61; number += 1) await boundedMissing.cache.loadCachedDappFavicon(`https://missing${number}.example`);
  await boundedMissing.cache.loadCachedDappFavicon('https://missing0.example');
  assert.equal(boundedMissing.reads.length, 62, 'Negative disk entries use a bounded 60-origin cache');

  const restoreClock = scheduler();
  const restoredOrigins = ['https://a.example', 'https://b.example', 'https://c.example'];
  const restoredRecord = (origin, image = { uri: dataUri(firstImage) }) => JSON.stringify({ version: 1, origin, iconUrl: `${origin}/favicon.ico`, image });
  const restore = fixture({ scheduler: restoreClock, disk: new Map(restoredOrigins.map((origin) => [origin, restoredRecord(origin)])) });
  const received = [];
  restore.cache.scheduleCachedDappFavicon(restoredOrigins[0], (image) => received.push(image));
  const cancel = restore.cache.scheduleCachedDappFavicon(restoredOrigins[1], () => assert.fail('Cancelled row must not receive an icon'));
  restore.cache.scheduleCachedDappFavicon(restoredOrigins[2], (image) => received.push(image));
  assert.equal(restoreClock.pendingInteractions, 1, 'All rows share one post-interaction task');
  assert.equal(restore.reads.length, 0, 'Restoration does not block first paint');
  cancel();
  restoreClock.interact();
  restoreClock.advance(16);
  await started(() => received.length === 1);
  assert.deepEqual(restore.reads, [restoredOrigins[0]], 'Only one disk read begins in one frame');
  await started(() => restoreClock.pendingInteractions === 1);
  restoreClock.interact();
  restoreClock.advance(15);
  assert.equal(restore.reads.length, 1, 'The next restore waits for a separate frame');
  restoreClock.advance(1);
  await started(() => received.length === 2);
  assert.deepEqual(restore.reads, [restoredOrigins[0], restoredOrigins[2]], 'Unmount removes queued work');
  let immediate;
  restore.cache.scheduleCachedDappFavicon(restoredOrigins[0], (image) => { immediate = image; });
  assert.equal(immediate.uri, dataUri(firstImage), 'Warm images return immediately without another task');
  assert.equal(restore.calls.length, 0, 'The staggered restore queue remains entirely offline');

  const queueClock = scheduler();
  const waitingReads = Array.from({ length: 3 }, () => deferred());
  const boundedQueue = fixture({ scheduler: queueClock, read: (origin) => waitingReads[restoredOrigins.indexOf(origin)].promise });
  restoredOrigins.forEach((origin) => boundedQueue.cache.scheduleCachedDappFavicon(origin, () => {}));
  queueClock.interact(); queueClock.advance(16);
  queueClock.interact(); queueClock.advance(16);
  queueClock.interact(); queueClock.advance(16);
  assert.equal(boundedQueue.reads.length, 2, 'Slow native reads cannot grow unbounded');
  waitingReads[0].resolve(restoredRecord(restoredOrigins[0]));
  await started(() => queueClock.pendingInteractions === 1);
  queueClock.interact(); queueClock.advance(16);
  assert.equal(boundedQueue.reads.length, 3, 'A stalled icon leaves capacity for another origin and resumes bounded work');
  waitingReads[1].resolve(restoredRecord(restoredOrigins[1]));
  waitingReads[2].resolve(restoredRecord(restoredOrigins[2]));

  const cancelClock = scheduler();
  const cancelled = fixture({ scheduler: cancelClock });
  const cancelOnly = cancelled.cache.scheduleCachedDappFavicon(page, () => assert.fail('Cancelled restore callback'));
  cancelOnly();
  cancelClock.interact(); cancelClock.advance(100);
  assert.equal(cancelled.reads.length, 0, 'Cancelling the last row also cancels its scheduled interaction/timer');

  const pendingDisk = deferred();
  const diskClock = scheduler();
  const detached = fixture({ scheduler: diskClock, read: () => pendingDisk.promise });
  const cancelPending = detached.cache.scheduleCachedDappFavicon(page, () => assert.fail('A detached row cannot receive its late disk result'));
  diskClock.interact(); diskClock.advance(16);
  await started(() => detached.reads.length === 1);
  cancelPending(); pendingDisk.resolve(restoredRecord('https://example.com'));
  await started(() => detached.cache.getCachedDappFavicon(page));

  const saved = fixture();
  assert.equal(saved.cache.getCachedDappFavicon(page), null);
  const [first, repeated] = await Promise.all([
    saved.cache.ensureDappFavicon(page),
    saved.cache.ensureDappFavicon('https://example.com/another-page'),
  ]);
  assert.equal(first.uri, dataUri(firstImage));
  assert.equal(repeated.uri, first.uri);
  assert.equal(saved.calls.length, 1, 'Concurrent list entries from one origin share one image download');
  assert.equal(saved.calls[0].url, icon, 'A list cache miss downloads the conventional icon, never the HTML page');
  assert.equal(saved.calls[0].init.headers.Accept, 'image/*');
  assert.equal(saved.calls[0].init.credentials, 'omit');
  assert.equal(saved.calls[0].init.headers['Cache-Control'], undefined);
  await saved.cache.ensureDappFavicon('https://example.com/app?again=1', '/different.png');
  assert.equal(saved.calls.length, 1, 'Lists keep the saved image even when a declared URL changes');
  assert.equal(saved.disk.size, 1);
  assert.equal(saved.decodedUris.length, 1, 'Downloaded raster bytes are decoded locally before being cached');

  const restarted = fixture({ disk: saved.disk, fetch: () => { throw new Error('Restart must stay offline'); } });
  const persisted = await restarted.cache.ensureDappFavicon('https://example.com/after-restart');
  assert.equal(persisted.uri, first.uri);
  assert.equal(restarted.calls.length, 0, 'An app restart restores image bytes without networking');
  assert.equal(restarted.reads.length, 1);
  assert.equal((await restarted.cache.loadCachedDappFavicon(page)).uri, first.uri, 'Bundled shortcuts reuse a visit cache');
  assert.equal(restarted.calls.length, 0);

  const cachedOnlyRestart = fixture({ disk: saved.disk, fetch: () => { throw new Error('Cached-only restore must stay offline'); } });
  assert.equal((await cachedOnlyRestart.cache.loadCachedDappFavicon(page)).uri, first.uri);
  assert.equal(cachedOnlyRestart.calls.length, 0, 'Cached-only shortcuts restore disk images across app restarts');

  let notified = 0;
  const unsubscribe = restarted.cache.subscribeDappFavicon(page, () => { notified += 1; });
  restarted.setFetch(() => response(nextImage));
  const refreshed = await restarted.cache.refreshDappFavicon(page, icon);
  assert.equal(restarted.calls.length, 1, 'Visiting the same icon URL really downloads it again');
  assert.equal(restarted.calls[0].init.headers['Cache-Control'], 'no-cache');
  assert.equal(refreshed.uri, dataUri(nextImage));
  assert.notEqual(refreshed.uri, first.uri);
  assert.equal(restarted.cache.getCachedDappFavicon(page).uri, refreshed.uri);
  assert.equal(JSON.parse(restarted.disk.get('https://example.com')).image.uri, refreshed.uri);
  assert.equal(notified, 1, 'Visible lists are notified after a visit updates their icon');
  unsubscribe();

  const pending = deferred();
  restarted.setFetch(() => pending.promise);
  const visitA = restarted.cache.refreshDappFavicon(page, icon);
  const visitB = restarted.cache.refreshDappFavicon(page, icon);
  assert.equal(visitA, visitB, 'Duplicate metadata for one visit shares the in-flight refresh');
  await started(() => restarted.calls.length === 2);
  pending.resolve(response(lateImage));
  const [a, b] = await Promise.all([visitA, visitB]);
  assert.equal(a.uri, dataUri(lateImage));
  assert.equal(a.uri, b.uri);
  assert.equal(restarted.calls.length, 2);
  assert.equal(notified, 1, 'Unsubscribed lists no longer receive notifications');

  const retained = restarted.cache.getCachedDappFavicon(page).uri;
  restarted.setFetch(() => { throw new Error('Temporary icon download failure'); });
  assert.equal((await restarted.cache.refreshDappFavicon(page, icon)).uri, retained);
  assert.equal(restarted.cache.getCachedDappFavicon(page).uri, retained);
  assert.equal(JSON.parse(restarted.disk.get('https://example.com')).image.uri, retained);

  const oldList = deferred();
  const racing = fixture({ fetch: (_url, init) => init.headers['Cache-Control'] ? response(nextImage) : oldList.promise });
  const listResult = racing.cache.ensureDappFavicon(page);
  await started(() => racing.calls.length === 1);
  const visitResult = await racing.cache.refreshDappFavicon(page, icon);
  assert.equal(visitResult.uri, dataUri(nextImage));
  oldList.resolve(response(firstImage));
  assert.equal((await listResult).uri, visitResult.uri, 'A late list download returns the newer visit image');
  assert.equal(racing.cache.getCachedDappFavicon(page).uri, visitResult.uri);
  assert.equal(JSON.parse(racing.disk.get('https://example.com')).image.uri, visitResult.uri, 'A late list download cannot overwrite persistent visit data');

  const writing = deferred();
  let firstWrite = true;
  const slowDisk = fixture({
    fetch: (_url, init) => response(init.headers['Cache-Control'] ? nextImage : firstImage),
    write() { if (firstWrite) { firstWrite = false; return writing.promise; } },
  });
  const writingList = slowDisk.cache.ensureDappFavicon(page);
  await started(() => slowDisk.writes.length === 1);
  assert.equal(slowDisk.cache.getCachedDappFavicon(page).uri, dataUri(firstImage));
  const duringWritePromise = slowDisk.cache.refreshDappFavicon(page, icon);
  await started(() => slowDisk.cache.getCachedDappFavicon(page).uri === dataUri(nextImage));
  writing.resolve();
  const duringWrite = await duringWritePromise;
  assert.equal((await writingList).uri, duringWrite.uri, 'A list whose disk write finishes after a visit must return the newer memory image');
  assert.equal(duringWrite.uri, dataUri(nextImage));
  assert.equal(JSON.parse(slowDisk.disk.get('https://example.com')).image.uri, duringWrite.uri, 'Serialized writes preserve the newest image on disk');

  const brokenIcon = 'https://example.com/missing-rel-icon.png';
  const freshVisit = fixture({ fetch: (url) => response(nextImage, { ok: url === icon, url }) });
  const fallbackVisit = await freshVisit.cache.refreshDappFavicon(page, brokenIcon);
  assert.equal(fallbackVisit.uri, dataUri(nextImage), 'A first visit with an unavailable declared icon may use the conventional icon');
  assert.deepEqual(freshVisit.calls.map((call) => call.url), [brokenIcon, icon]);
  assert.equal(JSON.parse(freshVisit.disk.get('https://example.com')).iconUrl, icon, 'Persist the URL that actually supplied the fallback bytes');
  assert.ok(freshVisit.calls.every((call) => call.init.headers['Cache-Control'] === 'no-cache'));

  const savedVisit = fixture();
  const beforeBadIcon = await savedVisit.cache.ensureDappFavicon(page);
  savedVisit.setFetch((url) => response(nextImage, { ok: false, url }));
  const afterBadIcon = await savedVisit.cache.refreshDappFavicon(page, brokenIcon);
  assert.equal(afterBadIcon.uri, beforeBadIcon.uri, 'An existing usable icon survives a failed declared icon refresh');
  assert.deepEqual(savedVisit.calls.map((call) => call.url), [icon, brokenIcon], 'An existing icon avoids an unnecessary fallback download');

  const unreadable = fixture({ decoderFailure: true });
  assert.equal(await unreadable.cache.ensureDappFavicon(page), null, 'An undecodable image with a valid signature must not enter an empty cache');
  assert.equal(unreadable.cache.getCachedDappFavicon(page), null);
  assert.equal(unreadable.writes.length, 0);
  assert.equal(unreadable.disk.size, 0);
  assert.equal(unreadable.decodedUris.length, 1);

  const corruptedRefresh = fixture({ disk: new Map(saved.disk), decoderFailure: true, fetch: () => response(nextImage) });
  const beforeCorruption = await corruptedRefresh.cache.ensureDappFavicon(page);
  const storedBeforeCorruption = corruptedRefresh.disk.get('https://example.com');
  assert.equal((await corruptedRefresh.cache.refreshDappFavicon(page, icon)).uri, beforeCorruption.uri, 'An undecodable visit response retains the last usable image');
  assert.equal(corruptedRefresh.cache.getCachedDappFavicon(page).uri, beforeCorruption.uri);
  assert.equal(corruptedRefresh.disk.get('https://example.com'), storedBeforeCorruption);
  assert.equal(corruptedRefresh.writes.length, 0, 'A corrupt refresh must not replace the persistent icon');
  assert.equal(corruptedRefresh.decodedUris.length, 1);

  for (const dimensions of [[0, 16], [16, 0], [-1, 16], [4097, 16], [16, 4097], [NaN, 16], [16, Infinity]]) {
    const invalidSize = fixture({ dimensions });
    assert.equal(await invalidSize.cache.ensureDappFavicon(page), null, `Reject invalid icon dimensions: ${dimensions.join(' × ')}`);
    assert.equal(invalidSize.writes.length, 0);
  }
  const maximumSize = fixture({ dimensions: [4096, 4096] });
  assert.equal((await maximumSize.cache.ensureDappFavicon(page)).uri, dataUri(firstImage), 'A bounded raster dimension is accepted');
  assert.equal(maximumSize.decodedUris.length, 1);

  for (const options of [{ failRead: true, failWrite: true }, { nativeAvailable: false }]) {
    const unavailable = fixture(options);
    assert.equal((await unavailable.cache.ensureDappFavicon(page)).uri, dataUri(firstImage), 'Disk failures or an older native build must preserve memory-only browsing');
    assert.equal(unavailable.cache.getCachedDappFavicon(page).uri, dataUri(firstImage));
    assert.equal((await unavailable.cache.ensureDappFavicon(page)).uri, dataUri(firstImage));
    assert.equal(unavailable.calls.length, 1);
  }

  const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path d="M0 0h1v1H0z" fill=\'url("#g")\'/></svg>';
  const svgCache = fixture({ fetch: () => response(new TextEncoder().encode(safeSvg)) });
  const svgImage = await svgCache.cache.ensureDappFavicon(page);
  assert.equal(svgImage.uri, '');
  assert.equal(svgImage.svg, safeSvg, 'Self-contained SVG icons remain supported');
  const svgRestart = fixture({ disk: svgCache.disk });
  assert.equal((await svgRestart.cache.ensureDappFavicon(page)).svg, safeSvg);
  assert.equal(svgRestart.calls.length, 0);

  const pixelSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1" shape-rendering="crispEdges"><path d="M0 0h1v1H0z" fill="#ff0000"/><path d="M1 0h1v1H1z" fill="#00ff00" fill-opacity="0.502"/></svg>';
  const legacyOrigin = 'https://legacy.example';
  const legacyDisk = new Map([[legacyOrigin, restoredRecord(legacyOrigin, { uri: '', svg: pixelSvg })]]);
  const migrated = fixture({ disk: legacyDisk });
  const migratedImage = await migrated.cache.loadCachedDappFavicon(legacyOrigin);
  assert.match(migratedImage.uri, /^data:image\/png;base64,/, 'Old generated per-pixel SVG is restored as one native PNG');
  assert.equal(migratedImage.svg, undefined);
  await started(() => migrated.writes.length === 1);
  await started(() => JSON.parse(legacyDisk.get(legacyOrigin)).image.svg === undefined);
  assert.equal(migrated.calls.length, 0, 'Old cache migration is entirely local');
  const migrationRestart = fixture({ disk: legacyDisk });
  assert.equal((await migrationRestart.cache.loadCachedDappFavicon(legacyOrigin)).uri, migratedImage.uri);
  assert.equal(migrationRestart.writes.length, 0, 'PNG migration is persisted once and reused on later launches');

  const migrationWrite = deferred();
  let waitForMigration = true;
  const migrationRace = fixture({
    disk: new Map([[legacyOrigin, restoredRecord(legacyOrigin, { uri: '', svg: pixelSvg })]]),
    fetch: () => response(nextImage, { url: `${legacyOrigin}/favicon.ico` }),
    write() { if (waitForMigration) { waitForMigration = false; return migrationWrite.promise; } },
  });
  await migrationRace.cache.loadCachedDappFavicon(legacyOrigin);
  await started(() => migrationRace.writes.length === 1);
  const freshLegacyVisit = migrationRace.cache.refreshDappFavicon(legacyOrigin);
  await started(() => migrationRace.cache.getCachedDappFavicon(legacyOrigin).uri === dataUri(nextImage));
  migrationWrite.resolve();
  await freshLegacyVisit;
  assert.equal(JSON.parse(migrationRace.disk.get(legacyOrigin)).image.uri, dataUri(nextImage), 'An old migration write cannot overwrite a newer visit');

  let oversizedBodyRead = false;
  const unsafeBodies = [
    () => response(firstImage, { length: 512_001, onRead() { oversizedBodyRead = true; } }),
    () => response(new Uint8Array(512_001), { length: 0 }),
    () => response(new Uint8Array()),
    () => response(new TextEncoder().encode('<html><head><title>Not an icon</title></head></html>')),
    () => response(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')),
    () => response(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.example/image.png"/></svg>')),
    () => response(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><feImage href="https://tracker.example/image.png"/></svg>')),
    () => response(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><use xlinkHref="https://tracker.example/a.svg#icon"/></svg>')),
    () => response(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><use href=https://tracker.example/a.svg#icon /></svg>')),
    () => response(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')),
    () => response(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(https://tracker.example/a.svg)"/></svg>')),
    () => response(firstImage, { ok: false }),
    () => response(firstImage, { url: 'https://192.168.1.1/icon.png' }),
    () => response(firstImage, { url: 'https://user:secret@cdn.example.com/icon.png' }),
  ];
  for (const fetch of unsafeBodies) {
    const unsafe = fixture({ fetch });
    assert.equal(await unsafe.cache.ensureDappFavicon(page), null);
    assert.equal(unsafe.cache.getCachedDappFavicon(page), null);
    assert.equal(unsafe.disk.size, 0, 'Oversized, non-image and unsafe resources must not be cached');
  }
  assert.equal(oversizedBodyRead, false, 'Reject an excessive declared length before loading the response body');

  const blocked = fixture({ fetch: () => { throw new Error('Blocked URLs must never reach fetch'); } });
  const unsafePages = [
    'javascript:alert(1)', 'data:image/png;base64,AA==', 'file:///icon.png',
    'https://user:secret@example.com/app', 'https://localhost/app',
    'https://127.0.0.1/app', 'https://10.0.0.1/app', 'https://192.168.0.1/app',
    'https://169.254.169.254/app', 'https://[::1]/app',
  ];
  for (const url of unsafePages) {
    assert.equal(await blocked.cache.ensureDappFavicon(url), null);
    assert.equal(await blocked.cache.refreshDappFavicon(url), null);
  }
  for (const url of ['javascript:alert(1)', 'file:///icon.png', 'http://example.com/icon.png', 'https://10.0.0.1/icon.png', 'https://user:secret@cdn.example.com/icon.png']) {
    assert.equal(await blocked.cache.ensureDappFavicon(page, url), null);
    assert.equal(await blocked.cache.refreshDappFavicon(page, url), null);
  }
  assert.equal(blocked.calls.length, 0);
  assert.equal(blocked.writes.length, 0);

  console.log('Favicon cache verification passed: bounded/cancellable frame restores, bounded missing-icon cooldown, offline SVG migration, serialized visit writes, origin reuse, refresh races/failures and unsafe-resource guards.');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
