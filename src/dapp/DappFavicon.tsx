import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, View, type ImageSourcePropType } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { Globe } from '../ui/icons.js';
import { walletColors } from '../ui/theme.js';
import { ensureDappFavicon, getCachedDappFavicon, scheduleCachedDappFavicon, subscribeDappFavicon, type FaviconImage } from './favicon-cache.js';

export { decodeIcoToImageDataUri, discoverFaviconFromHtml, faviconForPageUrl, getDappFaviconUrl, resolveDappFaviconUrl } from './favicon-image.js';

export function DappFavicon({ pageUrl, faviconUrl, size = 18, fallbackSource, cacheOnly = false, loadPersistedCache = true }: {
  pageUrl: string;
  faviconUrl?: string;
  size?: number;
  fallbackSource?: ImageSourcePropType;
  cacheOnly?: boolean;
  /** Restore the native disk cache for ordinary history/favorite icons. */
  loadPersistedCache?: boolean;
}) {
  const [loaded, setLoaded] = useState<{ pageUrl: string; image: FaviconImage | null }>(() => ({ pageUrl, image: getCachedDappFavicon(pageUrl) }));
  const source = loaded.pageUrl === pageUrl ? loaded.image : getCachedDappFavicon(pageUrl);

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeDappFavicon(pageUrl, () => {
      if (!active) return;
      const image = getCachedDappFavicon(pageUrl);
      setLoaded((current) => current.pageUrl === pageUrl && current.image === image
        ? current
        : { pageUrl, image });
    });
    const receive = (image: FaviconImage | null) => {
      if (!active) return;
      const nextImage = getCachedDappFavicon(pageUrl) ?? image;
      setLoaded((current) => current.pageUrl === pageUrl && current.image === nextImage
        ? current
        : { pageUrl, image: nextImage });
    };
    let cancelRestore: (() => void) | undefined;
    if (cacheOnly) {
      if (loadPersistedCache) cancelRestore = scheduleCachedDappFavicon(pageUrl, receive);
      else receive(getCachedDappFavicon(pageUrl));
    } else void ensureDappFavicon(pageUrl, faviconUrl).then(receive).catch(() => { /* Keep the last usable cached icon. */ });
    return () => { active = false; cancelRestore?.(); unsubscribe(); };
  }, [cacheOnly, faviconUrl, loadPersistedCache, pageUrl]);

  const onError = () => setLoaded({ pageUrl, image: null });
  if (!source && fallbackSource) return <Image accessibilityIgnoresInvertColors accessibilityLabel="" source={fallbackSource} fadeDuration={0} resizeMode="contain" style={{ width: size, height: size, borderRadius: Math.max(3, Math.round(size * 0.2)) }} />;
  if (!source) return <View style={[styles.fallback, { width: size, height: size }]}><Globe size={size} color={walletColors.textSecondary} /></View>;
  if (source.svg) return <View style={{ width: size, height: size, borderRadius: Math.max(3, Math.round(size * 0.2)), overflow: 'hidden' }}><SvgXml accessibilityLabel="" xml={source.svg} width={size} height={size} onError={onError} /></View>;
  return <Image accessibilityIgnoresInvertColors accessibilityLabel="" source={{ uri: source.uri }} fadeDuration={0} onError={onError} resizeMode="contain" style={{ width: size, height: size, borderRadius: Math.max(3, Math.round(size * 0.2)) }} />;
}

const styles = StyleSheet.create({ fallback: { alignItems: 'center', justifyContent: 'center' } });
