import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  InteractionManager,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ArrowLeft,
  ArrowUpRight,
  Bookmark,
  ChevronRight,
  Clock3,
  Globe2,
  QrCode,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  NetworkMark,
  X,
} from './icons.js';
import { useI18n } from '../i18n.js';
import { DappFavicon } from '../dapp/DappFavicon.js';
import { QrScannerModal } from './QRScannerModal.js';
import { PopularDappsSection } from './dapp/PopularDappsSection.js';

export interface DappLandingScreenProps {
  favorites: string[];
  history: string[];
  urlInput: string;
  onUrlChange: (value: string) => void;
  onOpen: (url: string) => void;
  onToggleFavorite: (url: string) => void;
  onClearHistory: () => void;
  onBack: () => void;
  networkName: string;
  networkChainId: number;
}

const palette = {
  background: '#0c1224',
  surface: '#19233d',
  elevated: '#202d4d',
  input: '#10192e',
  border: '#2b3857',
  text: '#f7f9ff',
  muted: '#a8b1c7',
  subtle: '#7c8aa7',
  purple: '#7b61ff',
  purpleLight: '#b6a7ff',
  purpleSoft: '#2a2450',
  green: '#49d89a',
} as const;

const copy = {
  zh: {
    back: '返回钱包',
    explore: '探索 Web3',
    subtitle: '输入网址，发现并连接链上应用。',
    address: '网站地址',
    placeholder: '输入网址，例如：example.com',
    open: '打开网站',
    clearAddress: '清空网址',
    favoriteInput: '收藏此 DApp',
    unfavoriteInput: '取消收藏此 DApp',
    favorites: '我的收藏',
    favoritesHint: '常用 DApp，一触即达',
    favoriteVisit: '点击打开',
    emptyFavorites: '收藏的 DApp 会显示在这里。',
    emptyFavoritesHint: '输入网址并收藏，下次即可快速打开。',
    history: '最近访问',
    clear: '清除',
    clearTitle: '清除访问记录？',
    clearDescription: '已收藏的网址会继续保留。',
    cancel: '取消',
    noHistory: '还没有访问记录。',
    noHistoryHint: '打开过的 DApp 会显示在这里。',
    removeFavorite: '取消收藏',
    addFavorite: '收藏',
    requestHint: '连接需要授权；签名和交易都由你确认。',
    scan: '扫描二维码', scanHint: '将二维码放入取景框中', cameraDenied: '无法使用相机，请在系统设置中允许相机权限。',
  },
  en: {
    back: 'Back to Wallet',
    explore: 'Explore Web3',
    subtitle: 'Enter a website to discover and connect to onchain apps.',
    address: 'Website Address',
    placeholder: 'Enter a website, e.g. example.com',
    open: 'Open Website',
    clearAddress: 'Clear Website Address',
    favoriteInput: 'Add to Favorites',
    unfavoriteInput: 'Remove from Favorites',
    favorites: 'My Favorites',
    favoritesHint: 'Your favorite DApps are one tap away.',
    favoriteVisit: 'Tap to Open',
    emptyFavorites: 'Your favorite DApps will appear here.',
    emptyFavoritesHint: 'Enter a website and save it for quick access next time.',
    history: 'Recently Visited',
    clear: 'Clear',
    clearTitle: 'Clear Browsing History?',
    clearDescription: 'Your favorite websites will be kept.',
    cancel: 'Cancel',
    noHistory: 'No Visits Yet',
    noHistoryHint: 'DApps you open will appear here.',
    removeFavorite: 'Remove Favorite',
    addFavorite: 'Add Favorite',
    requestHint: 'You approve every connection, signature, and transaction.',
    scan: 'Scan QR Code', scanHint: 'Place the website QR code inside the frame.', cameraDenied: 'Camera access is unavailable. Allow camera access in system settings.',
  },
} as const;

function websiteInfo(value: string) {
  try {
    const parsed = new URL(value.includes('://') ? value : `https://${value}`);
    return {
      host: parsed.host.replace(/^www\./, ''),
      path: parsed.pathname === '/' && !parsed.search ? parsed.host : `${parsed.pathname}${parsed.search}`,
      normalized: parsed.toString(),
    };
  } catch {
    return { host: value, path: value, normalized: value };
  }
}

const WebsiteMark = memo(function WebsiteMark({ url, small = false }: { url: string; small?: boolean }) {
  return (
    <View style={[styles.websiteMark, small ? styles.websiteMarkSmall : null]}>
      {/* Landing lists must stay offline-first. Favicon refresh happens after
          an actual WebView visit, so opening the DApp tab never fans out into
          one network request per favorite/history item. */}
      <DappFavicon pageUrl={url} size={small ? 22 : 27} cacheOnly />
    </View>
  );
});

const EMPTY_HISTORY: string[] = [];
const historyKey = (url: string) => url;
const FAVORITE_WIDTH = 148;
const FAVORITE_GAP = 12;
const favoriteLayout = (_: unknown, index: number) => ({
  length: FAVORITE_WIDTH,
  offset: (FAVORITE_WIDTH + FAVORITE_GAP) * index,
  index,
});

const FavoriteCard = memo(function FavoriteCard({ url, onOpen, onToggleFavorite, removeLabel, visitLabel }: {
  url: string;
  onOpen: (url: string) => void;
  onToggleFavorite: (url: string) => void;
  removeLabel: string;
  visitLabel: string;
}) {
  const info = useMemo(() => websiteInfo(url), [url]);
  return <View style={styles.favoriteCard}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${removeLabel}: ${info.host}`} onPress={() => onToggleFavorite(url)} style={({ pressed }) => [styles.removeFavoriteButton, pressed && styles.pressed]}>
      <Star size={17} color={palette.purpleLight} fill={palette.purpleLight} />
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel={info.host} onPress={() => onOpen(url)} style={({ pressed }) => [styles.favoriteOpen, pressed && styles.pressed]}>
      <WebsiteMark url={url} />
      <Text style={styles.favoriteName} numberOfLines={1}>{info.host}</Text>
      <View style={styles.favoriteLink}><Text style={styles.favoriteDomain} numberOfLines={1}>{visitLabel}</Text><ArrowUpRight size={13} color={palette.subtle} /></View>
    </Pressable>
  </View>;
});

const HistoryRow = memo(function HistoryRow({
  url,
  favorite,
  onOpen,
  onToggleFavorite,
  addLabel,
  removeLabel,
}: {
  url: string;
  favorite: boolean;
  onOpen: (url: string) => void;
  onToggleFavorite: (url: string) => void;
  addLabel: string;
  removeLabel: string;
}) {
  const info = useMemo(() => websiteInfo(url), [url]);
  return (
    <View style={styles.historyRow}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={info.host}
        onPress={() => onOpen(url)}
        style={({ pressed }) => [styles.historyOpen, pressed ? styles.pressed : null]}
      >
        <WebsiteMark url={url} small />
        <View style={styles.historyText}>
          <Text style={styles.historyName} numberOfLines={1}>{info.host}</Text>
          <Text style={styles.historyUrl} numberOfLines={1}>{info.path}</Text>
        </View>
        <ChevronRight size={17} color={palette.subtle} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${favorite ? removeLabel : addLabel}: ${info.host}`}
        accessibilityState={{ selected: favorite }}
        onPress={() => onToggleFavorite(url)}
        style={({ pressed }) => [styles.favoriteButton, pressed ? styles.pressed : null]}
      >
        <Star size={19} color={favorite ? palette.purpleLight : palette.subtle} fill={favorite ? palette.purpleLight : 'none'} />
      </Pressable>
    </View>
  );
});

export function DappLandingScreen({
  favorites,
  history,
  urlInput,
  onUrlChange,
  onOpen,
  onToggleFavorite,
  onClearHistory,
  onBack,
  networkName,
  networkChainId,
}: DappLandingScreenProps) {
  const { language } = useI18n();
  const { width } = useWindowDimensions();
  const compact = width < 360;
  const text = copy[language];
  const [inputFocused, setInputFocused] = useState(false);
  const [section, setSection] = useState<'favorites' | 'history'>('favorites');
  const [scannerVisible, setScannerVisible] = useState(false);
  const [popularReady, setPopularReady] = useState(false);
  const favoriteUrls = useMemo(() => new Set(favorites), [favorites]);
  const hasInput = urlInput.trim().length > 0;
  const inputFavorite = hasInput && favorites.includes(websiteInfo(urlInput.trim()).normalized);

  // Let the native stack transition and the address field paint first. The
  // curated grid is below the fold and can be mounted after the interaction,
  // keeping the DApp tab responsive on lower-end devices.
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => setPopularReady(true));
    return () => task.cancel();
  }, []);

  const openInput = useCallback(() => {
    if (!urlInput.trim()) return;
    Keyboard.dismiss();
    onOpen(urlInput.trim());
  }, [onOpen, urlInput]);

  const confirmClearHistory = useCallback(() => {
    Alert.alert(text.clearTitle, text.clearDescription, [
      { text: text.cancel, style: 'cancel' },
      { text: text.clear, style: 'destructive', onPress: onClearHistory },
    ]);
  }, [text, onClearHistory]);

  const renderHistory = useCallback(({ item }: { item: string }) => (
    <HistoryRow
      url={item}
      favorite={favoriteUrls.has(item)}
      onOpen={onOpen}
      onToggleFavorite={onToggleFavorite}
      addLabel={text.addFavorite}
      removeLabel={text.removeFavorite}
    />
  ), [favoriteUrls, onOpen, onToggleFavorite, text]);

  const renderFavorite = useCallback(({ item }: { item: string }) => (
    <FavoriteCard url={item} onOpen={onOpen} onToggleFavorite={onToggleFavorite} removeLabel={text.removeFavorite} visitLabel={text.favoriteVisit} />
  ), [onOpen, onToggleFavorite, text]);

  // Switching only the lower list must not reconcile the address form and
  // bundled recommendation grid in the same frame as mounting history rows.
  const discoveryHeader = useMemo(() => (
    <View>
      <View style={styles.hero}>
        <View style={styles.heroIcon}><Globe2 size={28} color={palette.purpleLight} strokeWidth={1.8} /></View>
        <View style={styles.heroText}>
          <Text style={styles.heroTitle}>{text.explore}</Text>
          <Text style={styles.heroSubtitle}>{text.subtitle}</Text>
        </View>
      </View>
      <View style={[styles.addressCard, compact && styles.addressCardCompact]}>
        <Text style={styles.addressLabel}>{text.address}</Text>
        <View style={[styles.inputWrap, inputFocused ? styles.inputFocused : null]}>
          <Search size={20} color={palette.subtle} />
          <TextInput
            accessibilityLabel={text.address}
            value={urlInput}
            onChangeText={onUrlChange}
            onSubmitEditing={openInput}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            placeholder={text.placeholder}
            placeholderTextColor={palette.subtle}
            selectionColor={palette.purpleLight}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            textContentType="URL"
            style={styles.input}
          />
          {hasInput ? <Pressable accessibilityRole="button" accessibilityLabel={text.clearAddress} onPress={() => onUrlChange('')} style={({ pressed }) => [styles.clearAddressButton, pressed ? styles.pressed : null]}><X size={17} color={palette.muted} /></Pressable> : null}
          <Pressable accessibilityRole="button" accessibilityLabel={text.scan} onPress={() => { Keyboard.dismiss(); setScannerVisible(true); }} style={({ pressed }) => [styles.scanButton, pressed ? styles.pressed : null]}><QrCode size={20} color={palette.purpleLight} /></Pressable>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !hasInput }}
          disabled={!hasInput}
          onPress={openInput}
          style={({ pressed }) => [styles.openButton, !hasInput && styles.disabled, pressed && styles.pressed]}
        >
          <Text style={styles.openButtonText}>{text.open}</Text>
          <ArrowUpRight size={20} color={palette.text} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: inputFavorite, disabled: !hasInput }}
          disabled={!hasInput}
          onPress={() => onToggleFavorite(urlInput)}
          style={({ pressed }) => [styles.saveInputButton, !hasInput && styles.disabled, pressed && styles.pressed]}
        >
          <Bookmark size={16} color={palette.purpleLight} fill={inputFavorite ? palette.purpleLight : 'none'} />
          <Text style={styles.saveInputText}>{inputFavorite ? text.unfavoriteInput : text.favoriteInput}</Text>
        </Pressable>
      </View>
      {popularReady ? <PopularDappsSection onOpen={onOpen} /> : null}
    </View>
  ), [compact, hasInput, inputFavorite, inputFocused, onOpen, onToggleFavorite, onUrlChange, openInput, popularReady, text, urlInput]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={[styles.topBar, compact && styles.topBarCompact]}>
        <Pressable accessibilityRole="button" accessibilityLabel={text.back} onPress={onBack} style={({ pressed }) => [styles.backButton, pressed ? styles.pressed : null]}>
          <ArrowLeft size={22} color={palette.text} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>DApp</Text>
        <View style={styles.networkBadge}>
          <NetworkMark chainId={networkChainId} size={16} />
          <Text style={styles.networkText} numberOfLines={1}>{networkName}</Text>
        </View>
      </View>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <FlatList
          data={section === 'history' ? history : EMPTY_HISTORY}
          keyExtractor={historyKey}
          renderItem={renderHistory}
          extraData={favorites}
          // A tab press should only mount the few rows that fit below its
          // header. Larger default batches restore and parse many cached
          // icons in the same frame, even for rows still off screen.
          initialNumToRender={3}
          maxToRenderPerBatch={3}
          updateCellsBatchingPeriod={50}
          windowSize={5}
          contentContainerStyle={[styles.scrollContent, compact && styles.scrollContentCompact]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          ListHeaderComponent={(
            <View>
              {discoveryHeader}

              <View style={styles.sectionTabs}>
                {(['favorites', 'history'] as const).map((value) => (
                  <Pressable key={value} accessibilityRole="tab" accessibilityState={{ selected: section === value }} onPress={() => { Keyboard.dismiss(); setSection(value); }} style={({ pressed }) => [styles.sectionTab, section === value ? styles.sectionTabSelected : null, pressed && styles.pressed]}>
                    {value === 'favorites' ? <Bookmark size={16} color={section === value ? palette.purpleLight : palette.subtle} /> : <Clock3 size={16} color={section === value ? palette.purpleLight : palette.subtle} />}
                    <Text style={[styles.sectionTabText, section === value ? styles.sectionTabTextSelected : null]}>{text[value]}</Text>
                    <Text style={styles.tabCount}>{value === 'favorites' ? favorites.length : history.length}</Text>
                  </Pressable>
                ))}
              </View>
              {section === 'favorites' ? <Text style={styles.sectionHint}>{text.favoritesHint}</Text> : null}
              {section === 'favorites' ? (favorites.length > 0 ? (
                <FlatList
                  horizontal
                  data={favorites}
                  keyExtractor={historyKey}
                  renderItem={renderFavorite}
                  getItemLayout={favoriteLayout}
                  initialNumToRender={3}
                  maxToRenderPerBatch={3}
                  windowSize={3}
                  keyboardShouldPersistTaps="handled"
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.favoriteStrip}
                />
              ) : (
                <View style={styles.emptyFavorites}>
                  <View style={styles.emptyIcon}><Bookmark size={22} color={palette.purpleLight} /></View>
                  <View style={styles.emptyText}>
                    <Text style={styles.emptyTitle}>{text.emptyFavorites}</Text>
                    <Text style={styles.emptyDescription}>{text.emptyFavoritesHint}</Text>
                  </View>
                </View>
              )) : null}

              {section === 'history' && history.length > 0 ? <View style={styles.historyHeader}>
                <View style={styles.historyHeaderTitle}><Clock3 size={18} color={palette.muted} /><Text style={[styles.sectionTitle, styles.historyTitle]}>{text.history}</Text></View>
                {history.length > 0 ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={text.clearTitle} onPress={confirmClearHistory} style={({ pressed }) => [styles.clearButton, pressed ? styles.pressed : null]}>
                    <Trash2 size={14} color={palette.muted} />
                    <Text style={styles.clearText}>{text.clear}</Text>
                  </Pressable>
                ) : null}
              </View> : null}
            </View>
          )}
          ListEmptyComponent={section === 'history' ? (
            <View style={styles.emptyHistory}>
              <Clock3 size={28} color={palette.subtle} strokeWidth={1.4} />
              <Text style={styles.emptyTitle}>{text.noHistory}</Text>
              <Text style={styles.emptyHistoryDescription}>{text.noHistoryHint}</Text>
            </View>
          ) : null}
          ListFooterComponent={(
            <View style={styles.requestNote}>
              <ShieldCheck size={14} color={palette.subtle} />
              <Text style={styles.requestNoteText}>{text.requestHint}</Text>
            </View>
          )}
        />
      </KeyboardAvoidingView>
      <QrScannerModal visible={scannerVisible} title={text.scan} hint={text.scanHint} closeLabel={text.cancel} permissionDeniedLabel={text.cameraDenied} onClose={() => setScannerVisible(false)} onScanned={(value) => { setScannerVisible(false); onOpen(value); }} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background },
  flex: { flex: 1 },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 6, paddingBottom: 6, gap: 10 },
  topBarCompact: { paddingHorizontal: 16, gap: 8 },
  backButton: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surface },
  title: { flex: 1, color: palette.text, fontSize: 21, fontWeight: '700', letterSpacing: -0.4 },
  networkBadge: { flexDirection: 'row', alignItems: 'center', gap: 7, maxWidth: '45%', paddingHorizontal: 11, paddingVertical: 8, borderRadius: 20, backgroundColor: palette.surface },
  networkDot: { height: 6, width: 6, borderRadius: 3, backgroundColor: palette.green },
  networkText: { color: palette.muted, fontSize: 12, fontWeight: '600', flexShrink: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 18, width: '100%', maxWidth: 720, alignSelf: 'center' },
  scrollContentCompact: { paddingHorizontal: 16 },
  hero: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  heroIcon: { width: 52, height: 52, borderRadius: 17, backgroundColor: palette.purpleSoft, alignItems: 'center', justifyContent: 'center' },
  heroText: { flex: 1 },
  heroTitle: { color: palette.text, fontSize: 26, fontWeight: '700', letterSpacing: -0.7, marginBottom: 5 },
  heroSubtitle: { color: palette.muted, fontSize: 13, lineHeight: 20 },
  addressCard: { backgroundColor: palette.surface, borderRadius: 18, padding: 14, borderWidth: 1, borderColor: palette.border, marginBottom: 16 },
  addressCardCompact: { padding: 12 },
  addressLabel: { color: palette.muted, fontSize: 12, fontWeight: '600', marginBottom: 8 },
  inputWrap: { minHeight: 56, borderWidth: 1, borderColor: palette.border, borderRadius: 14, backgroundColor: palette.input, flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 5, gap: 7 },
  inputFocused: { borderColor: palette.purpleLight },
  input: { flex: 1, minWidth: 0, minHeight: 54, paddingVertical: 11, color: palette.text, fontSize: 14, paddingHorizontal: 0 },
  clearAddressButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  scanButton: { width: 44, height: 44, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.purpleSoft },
  openButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, minHeight: 48, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: palette.purple, borderRadius: 14, marginTop: 10 },
  openButtonText: { color: palette.text, fontSize: 15, fontWeight: '700', flexShrink: 1, textAlign: 'center' },
  saveInputButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', minHeight: 44, gap: 7, marginTop: 7, marginBottom: -6 },
  saveInputText: { color: palette.purpleLight, fontSize: 12, lineHeight: 18, fontWeight: '600', flexShrink: 1, textAlign: 'center' },
  disabled: { opacity: 0.42 },
  pressed: { opacity: 0.72 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 5 },
  sectionTabs: { flexDirection: 'row', padding: 5, borderRadius: 16, gap: 4, backgroundColor: palette.surface, marginBottom: 16 },
  sectionTab: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 12, paddingHorizontal: 5, paddingVertical: 8 },
  sectionTabSelected: { backgroundColor: palette.purpleSoft },
  sectionTabText: { color: palette.subtle, fontSize: 13, lineHeight: 19, fontWeight: '600', flexShrink: 1, textAlign: 'center' },
  sectionTabTextSelected: { color: palette.purpleLight },
  tabCount: { color: palette.subtle, fontSize: 11 },
  sectionTitle: { color: palette.text, fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  count: { color: palette.purpleLight, fontSize: 11, fontWeight: '600', backgroundColor: palette.purpleSoft, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 },
  sectionHint: { color: palette.subtle, fontSize: 12, marginBottom: 14 },
  favoriteStrip: { gap: FAVORITE_GAP, paddingBottom: 3 },
  favoriteCard: { width: FAVORITE_WIDTH, borderRadius: 18, backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.border, overflow: 'hidden' },
  favoriteOpen: { padding: 15, paddingTop: 17 },
  removeFavoriteButton: { position: 'absolute', top: 0, right: 0, zIndex: 1, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  websiteMark: { width: 44, height: 44, borderRadius: 14, backgroundColor: palette.purpleSoft, justifyContent: 'center', alignItems: 'center', marginBottom: 13 },
  websiteMarkSmall: { width: 40, height: 40, borderRadius: 12, marginBottom: 0 },
  websiteLetter: { color: palette.purpleLight, fontSize: 21, fontWeight: '700' },
  favoriteName: { color: palette.text, fontSize: 14, fontWeight: '600', marginBottom: 6 },
  favoriteLink: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  favoriteDomain: { flex: 1, color: palette.subtle, fontSize: 10 },
  emptyFavorites: { flexDirection: 'row', alignItems: 'center', gap: 13, backgroundColor: palette.surface, borderRadius: 17, padding: 17, borderWidth: 1, borderColor: palette.border },
  emptyIcon: { width: 44, height: 44, borderRadius: 13, backgroundColor: palette.purpleSoft, justifyContent: 'center', alignItems: 'center' },
  emptyText: { flex: 1 },
  emptyTitle: { color: palette.muted, fontSize: 13, fontWeight: '600' },
  emptyDescription: { color: palette.subtle, fontSize: 11, lineHeight: 18, marginTop: 5 },
  historyHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 11 },
  historyHeaderTitle: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 },
  historyTitle: { flex: 1, minWidth: 0 },
  clearButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, minWidth: 44, minHeight: 44, maxWidth: '45%', paddingHorizontal: 8, paddingVertical: 6 },
  clearText: { color: palette.muted, fontSize: 12, flexShrink: 1, textAlign: 'center' },
  historyRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: palette.surface, borderRadius: 16, marginBottom: 9 },
  historyOpen: { flexDirection: 'row', flex: 1, alignItems: 'center', gap: 11, paddingVertical: 14, paddingLeft: 13 },
  historyText: { flex: 1, minWidth: 0 },
  historyName: { color: palette.text, fontSize: 14, fontWeight: '600' },
  historyUrl: { color: palette.subtle, fontSize: 11, marginTop: 4 },
  favoriteButton: { width: 44, minHeight: 58, justifyContent: 'center', alignItems: 'center' },
  emptyHistory: { alignItems: 'center', gap: 11, paddingVertical: 26, borderRadius: 17, borderWidth: 1, borderStyle: 'dashed', borderColor: palette.border },
  emptyHistoryDescription: { color: palette.subtle, fontSize: 12, lineHeight: 18, textAlign: 'center', paddingHorizontal: 20 },
  requestNote: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 25, paddingHorizontal: 12 },
  requestNoteText: { color: palette.subtle, fontSize: 11, lineHeight: 17, flexShrink: 1 },
});
