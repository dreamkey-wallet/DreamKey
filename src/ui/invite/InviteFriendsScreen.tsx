import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Clipboard from '@react-native-clipboard/clipboard';
import type Svg from 'react-native-svg';
import { APP_DOWNLOAD_LINK_IS_PLACEHOLDER, APP_DOWNLOAD_URL } from '../../config/app-links.js';
import { useI18n } from '../../i18n.js';
import { shareInviteImage } from '../../native/invite-share.js';
import { ArrowLeft, Check, Copy, Link, Share2 } from '../icons.js';
import { walletColors as c } from '../theme.js';
import { InvitePoster } from './InvitePoster.js';

const copy = {
  zh: {
    title: '邀请好友',
    heading: '和朋友一起探索 Web3',
    subtitle: '把 DreamKey 分享给好友，一起管理资产、发现链上应用。',
    downloadLink: '下载链接',
    copyLink: '复制链接',
    copied: '已复制链接',
    shareLink: '分享链接',
    shareImage: '分享海报',
    preparing: '正在生成海报…',
    loadingPoster: '正在加载海报…',
    shareError: '暂时无法打开分享，请重试，或先复制下载链接。',
    placeholder: '当前为演示链接，暂不可用于正式下载。',
    message: '试试 DreamKey：管理多链资产、收发代币、探索 DApp。你的密钥始终由你保管。\n下载 DreamKey：',
  },
  en: {
    title: 'Invite Friends',
    heading: 'Explore Web3 Together',
    subtitle: 'Share DreamKey with friends to manage assets and discover onchain apps together.',
    downloadLink: 'Download Link',
    copyLink: 'Copy Link',
    copied: 'Link Copied',
    shareLink: 'Share Link',
    shareImage: 'Share Poster',
    preparing: 'Preparing Poster…',
    loadingPoster: 'Loading Poster…',
    shareError: 'Unable to open sharing. Try again or copy the download link first.',
    placeholder: 'This demo link is not yet available for app downloads.',
    message: 'Try DreamKey: manage multichain assets, send and receive tokens, and explore DApps. Your keys stay in your control.\nDownload DreamKey: ',
  },
} as const;

function exportPoster(poster: Svg | null): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!poster) { reject(new Error('Poster is not ready')); return; }
    const timer = setTimeout(() => reject(new Error('Poster export timed out')), 10000);
    try {
      poster.toDataURL((data) => {
        clearTimeout(timer);
        if (data) resolve(data);
        else reject(new Error('Poster export failed'));
      }, { width: 1080, height: 1680 });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

export function InviteFriendsScreen({ onBack }: { onBack: () => void }) {
  const { language, t } = useI18n();
  const text = copy[language];
  const { width, fontScale } = useWindowDimensions();
  const stackActions = width < 360 || fontScale > 1.2;
  const posterRef = useRef<Svg>(null);
  const sharing = useRef(false);
  const mounted = useRef(true);
  const readyFrame = useRef<number | null>(null);
  const [posterReady, setPosterReady] = useState(false);
  const [busy, setBusy] = useState<'image' | 'link' | null>(null);
  const [copied, setCopied] = useState(false);
  const [shareError, setShareError] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (readyFrame.current !== null) cancelAnimationFrame(readyFrame.current);
    };
  }, []);

  const markPosterReady = useCallback(() => {
    // The SVG now contains only synchronous vectors. Wait for its native layout
    // before enabling capture, rather than an unrelated hidden image's onLoad.
    if (readyFrame.current !== null) cancelAnimationFrame(readyFrame.current);
    readyFrame.current = requestAnimationFrame(() => {
      readyFrame.current = null;
      if (mounted.current) setPosterReady(true);
    });
  }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2200);
    return () => clearTimeout(timer);
  }, [copied]);

  const share = async (kind: 'image' | 'link') => {
    if (sharing.current || (kind === 'image' && !posterReady)) return;
    sharing.current = true;
    setBusy(kind);
    setShareError(false);
    try {
      const message = `${text.message}${APP_DOWNLOAD_URL}`;
      if (kind === 'image') {
        const pngBase64 = await exportPoster(posterRef.current);
        if (!mounted.current) return;
        await shareInviteImage({ pngBase64, message, title: text.title });
      } else {
        await Share.share({ message, title: text.title });
      }
    } catch {
      if (mounted.current) setShareError(true);
    } finally {
      sharing.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('back')} onPress={onBack} style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
          <ArrowLeft size={22} color={c.ink} />
        </Pressable>
        <Text style={styles.title}>{text.title}</Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.intro}>
          <Text style={styles.heading}>{text.heading}</Text>
          <Text style={styles.subtitle}>{text.subtitle}</Text>
        </View>
        <View style={styles.poster}>
          <InvitePoster ref={posterRef} downloadUrl={APP_DOWNLOAD_URL} language={language} width={Math.min(380, Math.max(160, width - 42))} onLayout={markPosterReady} />
        </View>
        <View style={styles.linkCard}>
          <View style={styles.linkHeading}>
            <Link size={17} color="#b6a7ff" />
            <Text style={styles.linkTitle}>{text.downloadLink}</Text>
          </View>
          <Text selectable style={styles.url}>{APP_DOWNLOAD_URL}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => { Clipboard.setString(APP_DOWNLOAD_URL); setCopied(true); }}
            style={({ pressed }) => [styles.copyButton, pressed ? styles.pressed : null]}
          >
            {copied ? <Check size={17} color={c.success} /> : <Copy size={17} color="#b6a7ff" />}
            <Text accessibilityLiveRegion="polite" style={[styles.copyText, copied ? styles.success : null]}>{copied ? text.copied : text.copyLink}</Text>
          </Pressable>
        </View>
        {APP_DOWNLOAD_LINK_IS_PLACEHOLDER ? <Text style={styles.note}>{text.placeholder}</Text> : null}
      </ScrollView>
      {shareError ? <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.error}>{text.shareError}</Text> : null}
      <View style={[styles.actions, stackActions && styles.actionsStacked]}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy !== null, busy: busy === 'link' }}
          disabled={busy !== null}
          onPress={() => { void share('link'); }}
          style={({ pressed }) => [styles.action, stackActions && styles.stackedAction, styles.secondary, busy !== null ? styles.disabled : null, pressed ? styles.pressed : null]}
        >
          {busy === 'link' ? <ActivityIndicator size="small" color={c.ink} /> : <Link size={19} color={c.ink} />}
          <Text style={styles.actionText}>{text.shareLink}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy !== null || !posterReady, busy: busy === 'image' || !posterReady }}
          disabled={busy !== null || !posterReady}
          onPress={() => { void share('image'); }}
          style={({ pressed }) => [styles.action, stackActions && styles.stackedAction, styles.primary, busy !== null || !posterReady ? styles.disabled : null, pressed ? styles.pressed : null]}
        >
          {busy === 'image' || !posterReady ? <ActivityIndicator size="small" color={c.white} /> : <Share2 size={19} color={c.white} />}
          <Text style={styles.actionText}>{!posterReady ? text.loadingPoster : busy === 'image' ? text.preparing : text.shareImage}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8 },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, color: c.ink, fontSize: 20, fontWeight: '700', textAlign: 'center' },
  headerSpacer: { width: 44 },
  content: { padding: 16, paddingTop: 8, paddingBottom: 20, gap: 12, width: '100%', maxWidth: 640, alignSelf: 'center' },
  intro: { alignItems: 'center', gap: 6 },
  heading: { color: c.ink, fontSize: 23, lineHeight: 30, fontWeight: '700', textAlign: 'center' },
  subtitle: { color: c.textSecondary, fontSize: 13, lineHeight: 20, textAlign: 'center' },
  poster: { alignSelf: 'center', borderRadius: 24, borderCurve: 'continuous', overflow: 'hidden', borderWidth: 1, borderColor: '#3d3663' },
  linkCard: { width: '100%', maxWidth: 500, alignSelf: 'center', backgroundColor: c.surface, borderRadius: 16, borderCurve: 'continuous', padding: 14, gap: 8 },
  linkHeading: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  linkTitle: { color: c.textSecondary, fontSize: 12, fontWeight: '600' },
  url: { color: c.ink, fontSize: 13, lineHeight: 21 },
  copyButton: { alignSelf: 'flex-start', minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 12, borderRadius: 12, borderCurve: 'continuous', backgroundColor: c.primarySoft },
  copyText: { color: '#b6a7ff', fontSize: 13, fontWeight: '600' },
  success: { color: c.success },
  note: { color: c.textTertiary, fontSize: 12, lineHeight: 19, textAlign: 'center' },
  error: { color: c.danger, fontSize: 13, lineHeight: 20, textAlign: 'center', paddingHorizontal: 20, paddingVertical: 10, backgroundColor: c.dangerSoft },
  actions: { flexDirection: 'row', gap: 12, padding: 20, paddingTop: 12, borderTopWidth: 1, borderColor: c.border },
  actionsStacked: { flexDirection: 'column', gap: 8 },
  action: { flexGrow: 1, flexBasis: 0, minHeight: 52, borderRadius: 16, borderCurve: 'continuous', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 12 },
  stackedAction: { flexGrow: 0, flexBasis: 'auto' },
  primary: { backgroundColor: c.primary },
  secondary: { backgroundColor: c.surfaceMuted },
  actionText: { color: c.ink, fontSize: 14, fontWeight: '700', flexShrink: 1, textAlign: 'center' },
  disabled: { opacity: 0.6 },
  pressed: { opacity: 0.75 },
});
