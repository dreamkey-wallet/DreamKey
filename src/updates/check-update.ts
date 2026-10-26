import { parseUpdateManifest, requireHttpsUrl, UpdateError, type UpdateManifest } from './update-policy.js';

/** The endpoint receives no wallet, device or account information. */
export async function fetchUpdateManifest(endpoint: string): Promise<UpdateManifest> {
  const url = new URL(requireHttpsUrl(endpoint));
  url.searchParams.set('_t', String(Date.now()));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Reject independently of fetch: some native/network implementations
      // ignore abort while obtaining headers or reading the response body.
      reject(new UpdateError('E_UPDATE_NETWORK'));
      controller.abort();
    }, 15000);
  });
  try {
    return await Promise.race([(async () => {
      const response = await fetch(url.href, {
        method: 'GET', signal: controller.signal, credentials: 'omit',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      });
      if (controller.signal.aborted) throw new UpdateError('E_UPDATE_NETWORK');
      if (!response.ok) throw new UpdateError('E_UPDATE_NETWORK');
      if (response.url && new URL(requireHttpsUrl(response.url)).origin !== url.origin) {
        throw new UpdateError('E_UPDATE_URL');
      }
      const length = response.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > 65536)) throw new UpdateError('E_UPDATE_JSON');
      const body = await response.text();
      if (controller.signal.aborted) throw new UpdateError('E_UPDATE_NETWORK');
      if (body.length > 65536) throw new UpdateError('E_UPDATE_JSON');
      let data: unknown;
      try { data = JSON.parse(body); } catch { throw new UpdateError('E_UPDATE_JSON'); }
      return parseUpdateManifest(data);
    })(), deadline]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
