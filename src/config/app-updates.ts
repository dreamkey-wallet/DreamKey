/** Public HTTPS endpoint returning the eight update fields. Empty disables checks. */
export const UPDATE_JSON_URL = '';

/** Exact hostnames permitted to serve APK/ZIP downloads, for example your OSS host. */
export const UPDATE_DOWNLOAD_HOSTS: readonly string[] = [];

/** Only links on these hosts may be opened for an iOS full update. */
export const UPDATE_IOS_STORE_HOSTS: readonly string[] = ['apps.apple.com', 'testflight.apple.com'];
