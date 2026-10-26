import React, { memo, useCallback, useRef, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useI18n } from '../../i18n.js';
import { POPULAR_DAPPS, type PopularDapp } from './popular-dapps.js';
import { POPULAR_DAPP_LOGOS } from './popular-dapp-logos.js';

const COLUMNS = 5;
const PAGE_SIZE = COLUMNS * 2;
const pages = Array.from(
  { length: Math.ceil(POPULAR_DAPPS.length / PAGE_SIZE) },
  (_, index) => POPULAR_DAPPS.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE),
);

const copy = {
  zh: {
    title: '热门 DApp',
    open: '打开',
    page: (index: number) => `第 ${index + 1} 页，共 ${pages.length} 页`,
  },
  en: {
    title: 'Popular DApps',
    open: 'Open',
    page: (index: number) => `Page ${index + 1} of ${pages.length}`,
  },
} as const;

const DappShortcut = memo(function DappShortcut({
  dapp,
  onOpen,
  openLabel,
}: {
  dapp: PopularDapp;
  onOpen: (url: string) => void;
  openLabel: string;
}) {
  // Keep a brand word on one line; split only at existing word/case boundaries.
  // Each line can shrink slightly inside the fixed five-column grid while
  // retaining the device's accessibility font scaling.
  const words = dapp.name.includes(' ')
    ? dapp.name.split(/\s+/)
    : dapp.name.replace(/([a-z])([A-Z])/g, '$1\n$2').split('\n');
  const lines = words.length > 1 ? [words[0], words.slice(1).join(' ')] : words;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${openLabel} ${dapp.name}`}
      accessibilityHint={dapp.url}
      onPress={() => onOpen(dapp.url)}
      style={({ pressed }) => [styles.shortcut, pressed ? styles.pressed : null]}
    >
      <View style={styles.logo}>
        {/* Curated shortcuts use bundled artwork so entering the DApp tab never
            waits on favicon cache work or starts a network request. A visited
            site refreshes its cached icon in the browser/history surfaces. */}
        <Image
          accessibilityIgnoresInvertColors
          accessibilityLabel=""
          source={POPULAR_DAPP_LOGOS[dapp.id]}
          fadeDuration={0}
          resizeMode="contain"
          style={styles.logoImage}
        />
      </View>
      <View style={styles.nameSlot}>
        {lines.map((line, index) => <Text key={`${index}-${line}`} style={styles.name} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{line}</Text>)}
      </View>
    </Pressable>
  );
});

export const PopularDappsSection = memo(function PopularDappsSection({ onOpen }: { onOpen: (url: string) => void }) {
  const { language } = useI18n();
  const text = copy[language];
  const [width, setWidth] = useState(0);
  const [activePage, setActivePage] = useState(0);
  const listRef = useRef<FlatList<readonly PopularDapp[]>>(null);

  const measureWidth = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);

  const updatePage = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement } = event.nativeEvent;
    if (layoutMeasurement.width <= 0) return;
    const nextPage = Math.round(contentOffset.x / layoutMeasurement.width);
    setActivePage(Math.max(0, Math.min(pages.length - 1, nextPage)));
  }, []);

  const renderPage = useCallback(({ item }: { item: readonly PopularDapp[] }) => (
    <View style={width > 0 ? { width } : undefined}>
      {[item.slice(0, COLUMNS), item.slice(COLUMNS)].map((row, rowIndex) => (
        <View key={rowIndex} style={styles.row}>
          {row.map((dapp) => (
            <DappShortcut key={dapp.id} dapp={dapp} onOpen={onOpen} openLabel={text.open} />
          ))}
          {Array.from({ length: COLUMNS - row.length }, (_, index) => (
            <View key={`empty-${index}`} style={styles.emptySlot} />
          ))}
        </View>
      ))}
    </View>
  ), [onOpen, text.open, width]);

  return (
    <View style={styles.section}>
      <Text style={styles.title}>{text.title}</Text>
      <View onLayout={measureWidth}>
        {width > 0 ? (
          <FlatList
            ref={listRef}
            key={width}
            horizontal
            pagingEnabled
            data={pages}
            keyExtractor={(page) => page[0].id}
            renderItem={renderPage}
            initialScrollIndex={activePage}
            getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
            onMomentumScrollEnd={updatePage}
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            directionalLockEnabled
            initialNumToRender={1}
            maxToRenderPerBatch={1}
            windowSize={3}
            removeClippedSubviews={false}
          />
        ) : renderPage({ item: pages[0] })}
      </View>
      <View style={styles.pagination}>
        {pages.map((page, index) => (
          <Pressable
            key={page[0].id}
            accessibilityRole="button"
            accessibilityLabel={text.page(index)}
            accessibilityState={{ selected: index === activePage }}
            onPress={() => {
              listRef.current?.scrollToIndex({ index, animated: true });
              setActivePage(index);
            }}
            style={({ pressed }) => [styles.pageButton, pressed && styles.pressed]}
          >
            <View style={[styles.dot, index === activePage ? styles.activeDot : null]} />
          </Pressable>
        ))}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  section: { marginBottom: 18 },
  title: { color: '#f7f9ff', fontSize: 17, fontWeight: '700', letterSpacing: -0.3, marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'stretch' },
  shortcut: { flex: 1, minWidth: 0, minHeight: 84, alignItems: 'center', paddingHorizontal: 2, paddingVertical: 5, borderRadius: 14 },
  pressed: { backgroundColor: '#19233d', opacity: 0.72 },
  logo: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#202d4d', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', marginBottom: 5 },
  logoImage: { width: 32, height: 32, borderRadius: 7 },
  nameSlot: { alignSelf: 'stretch', minHeight: 30 },
  name: { alignSelf: 'stretch', color: '#dce2f2', textAlign: 'center', fontSize: 11, lineHeight: 15, fontWeight: '500' },
  emptySlot: { flex: 1 },
  pagination: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 0 },
  pageButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 14 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#2b3857' },
  activeDot: { width: 17, backgroundColor: '#b6a7ff' },
});
