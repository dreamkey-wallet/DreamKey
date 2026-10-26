import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View, Linking } from 'react-native';
import { UPDATE_DOWNLOAD_HOSTS, UPDATE_IOS_STORE_HOSTS, UPDATE_JSON_URL } from '../config/app-updates.js';
import { appUpdates, type UpdateProgress } from '../native/app-updates.js';
import { subscribeAppVisibility } from '../native/app-visibility.js';
import { useI18n } from '../i18n.js';
import { SecureModal } from '../ui/SecureModal.js';
import { ArrowDownLeft, ShieldCheck } from '../ui/icons.js';
import { colors } from '../ui/appStyles.js';
import { fetchUpdateManifest } from './check-update.js';
import { selectUpdate, UpdateError, type AvailableUpdate } from './update-policy.js';

type Phase = 'offer' | 'downloading' | 'ready' | 'staged';
interface UpdateContextValue { checking: boolean; checkForUpdates(): Promise<void> }
const UpdateContext = createContext<UpdateContextValue | null>(null);

export function useAppUpdates(): UpdateContextValue {
  const value = useContext(UpdateContext);
  if (!value) throw new Error('UpdateProvider is missing');
  return value;
}

export function UpdateProvider({ children, safeToPrompt, navigationReady }: {
  children: React.ReactNode; safeToPrompt: boolean; navigationReady: boolean;
}) {
  const { language } = useI18n();
  const zh = language === 'zh';
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<AvailableUpdate | null>(null);
  const [visible, setVisible] = useState(false);
  const [modalShown, setModalShown] = useState(false);
  const [phase, setPhase] = useState<Phase>('offer');
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingPrompt, setPendingPrompt] = useState(false);
  const [foreground, setForeground] = useState(false);
  const checkingRef = useRef(false);
  const downloadingRef = useRef(false);
  const actionRevision = useRef(0);
  const foregroundRef = useRef(false);
  const mounted = useRef(true);
  const rollbackNoticePending = useRef(false);
  const currentLanguage = useRef(zh);
  currentLanguage.current = zh;

  const describeError = useCallback((reason: unknown): string => {
    const code = typeof reason === 'object' && reason ? String((reason as { code?: string }).code ?? '') : '';
    const chinese = currentLanguage.current;
    if (code === 'E_UPDATE_CONFIG') return chinese ? '此版本暂未开放在线更新。' : 'Online updates are not available in this version yet.';
    if (code === 'E_UPDATE_NATIVE') return chinese ? '此安装包不支持在线更新，请通过官方下载渠道获取新版本。' : 'This build does not support online updates. Get the latest version from the official download source.';
    if (code === 'E_INSTALL_PERMISSION') return chinese ? '请在系统设置中允许安装此来源的应用，返回后点击“安装更新”。' : 'Allow installs from this source in system settings, then return and tap Install Update.';
    if (code === 'E_UPDATE_URL') return chinese ? '更新链接不可用，请稍后重试。' : 'The update link is unavailable. Please try again later.';
    if (code === 'E_UPDATE_JSON' || code === 'E_UPDATE_VERSION') return chinese ? '暂时无法读取版本信息，请稍后重试。' : 'Version information is unavailable. Please try again later.';
    if (/KEY|SIGNATURE|HASH|MANIFEST|ZIP|CERT|PACKAGE|COMPAT|VERSION|VERIFY|DOWNGRADE|REPLAY/.test(code)) return chinese ? '更新包校验未通过，请联系发布者。当前版本保持不变。' : 'The update could not be verified. Your current version remains installed.';
    return chinese ? '更新失败，请检查网络后重试。当前版本保持不变。' : 'The update failed. Check your connection and retry. Your current version remains installed.';
  }, []);

  const check = useCallback(async (manual: boolean) => {
    if (checkingRef.current || downloadingRef.current || (!manual && !foregroundRef.current)) return false;
    if (!UPDATE_JSON_URL && !manual) return true;
    checkingRef.current = true;
    const revision = actionRevision.current;
    if (manual) setPendingPrompt(false);
    setChecking(true);
    try {
      if (!UPDATE_JSON_URL) throw new UpdateError('E_UPDATE_CONFIG');
      const state = await appUpdates.getState();
      if (!mounted.current || revision !== actionRevision.current) return false;
      const rollbackNotice = state.rollback
        ? (currentLanguage.current ? '上次补丁未能正常启动，已自动恢复到上一可用版本。' : 'The previous patch failed to start and was rolled back to the last working version.') : '';
      if (state.rollback && mounted.current) {
        rollbackNoticePending.current = true;
        setError('');
        setNotice(rollbackNotice);
        setPendingPrompt(true);
      }
      const manifest = await fetchUpdateManifest(UPDATE_JSON_URL);
      // A user may start the previously offered APK while this GET is in
      // flight. That operation owns its displayed version through completion.
      if (!mounted.current || revision !== actionRevision.current) return false;
      const update = selectUpdate(manifest, state, Platform.OS, UPDATE_DOWNLOAD_HOSTS, UPDATE_IOS_STORE_HOSTS);
      if (!mounted.current) return false;
      setError('');
      if (!state.rollback) setNotice('');
      if (update) {
        // OTA bundles are always staged silently. They take effect on the next
        // full restart; APK/native upgrades still use the explicit update UI.
        if (update.kind === 'bundle') {
          let staged = false;
          if (!downloadingRef.current) {
            downloadingRef.current = true;
            setProgress(null);
            try {
              await appUpdates.stageBundle(update.url, update.manifest.appVersion, update.manifest.bundleVersion);
              staged = true;
            } catch (reason) {
              // Keep OTA silent and let the bounded foreground retry handle
              // temporary failures, including a launch awaiting confirmation.
              if (manual) throw reason;
            } finally {
              downloadingRef.current = false;
            }
          }
          if (mounted.current) {
            setAvailable(null);
            setProgress(null);
            if (!state.rollback) { setVisible(false); setPendingPrompt(false); }
          }
          return staged;
        }
        setAvailable(update);
        setNotice(rollbackNotice);
        setPhase(state.apkReady && state.apkVersion === manifest.appVersion && update.kind === 'apk' ? 'ready' : 'offer');
        setProgress(null);
        // This must be state: legacy RN can commit each preceding setter in
        // a Promise separately, before a ref mutation would become visible.
        setPendingPrompt(true);
        if (manual) setVisible(true);
      } else if (state.rollback || manual) {
        setAvailable(null);
        const chinese = currentLanguage.current;
        setNotice(state.rollback
          ? rollbackNotice
          : state.pendingBundleVersion > state.bundleVersion
            ? (chinese ? '补丁已下载，完全关闭并重新打开应用后即可生效。' : 'A patch is ready and will apply after you fully close and reopen the app.')
            : !state.supported && manifest.appVersion === state.appVersion && manifest.bundleVersion > state.bundleVersion
              ? (chinese ? '此安装包不支持热更新，请安装正式版本。' : 'This build does not support hot updates. Install a release version to use them.')
              : (chinese ? '当前已是最新版本。' : 'You are using the latest version.'));
        if (manual) setVisible(true);
        else setPendingPrompt(true);
      } else {
        // A withdrawn release must not leave an old forced-update dialog or
        // a deferred prompt pointing at an update no longer offered online.
        setAvailable(null); setNotice(''); setError(''); setPendingPrompt(false); setVisible(false);
      }
      return true;
    } catch (reason) {
      if (manual && mounted.current && revision === actionRevision.current) {
        setPendingPrompt(false);
        // A check outage cannot withdraw a previously discovered required
        // release. Retain that offer until a successful manifest replaces it.
        setError(describeError(reason)); setNotice(''); setVisible(true);
      }
      return false;
    } finally {
      checkingRef.current = false;
      if (mounted.current) setChecking(false);
    }
  }, [describeError]);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = appUpdates.subscribe((event) => { if (mounted.current) setProgress(event); });
    const unsubscribeVisibility = subscribeAppVisibility((state) => {
      foregroundRef.current = state === 'foreground';
      setForeground(foregroundRef.current);
    });
    return () => { mounted.current = false; foregroundRef.current = false; unsubscribe(); unsubscribeVisibility(); };
  }, []);

  useEffect(() => {
    if (!navigationReady) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = false;
    let disposed = false;
    let generation = 0;
    let attempts = 0;
    const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    const scheduleCheck = (delay: number) => {
      clear();
      const revision = generation;
      timer = setTimeout(() => {
        timer = undefined;
        attempts += 1;
        void check(false).then((succeeded) => {
          // A temporary startup/network error or an unconfirmed OTA launch
          // gets two retries, without needing another app foreground event.
          if (!succeeded && !disposed && active && revision === generation && attempts < 3) {
            scheduleCheck(attempts === 1 ? 15000 : 30000);
          }
        });
      }, delay);
    };
    const unsubscribe = subscribeAppVisibility((state) => {
      active = state === 'foreground';
      generation += 1;
      clear();
      if (active) { attempts = 0; scheduleCheck(2500); }
    });
    return () => { disposed = true; clear(); unsubscribe(); };
  }, [check, navigationReady]);

  useEffect(() => {
    if (foreground && safeToPrompt && pendingPrompt) { setPendingPrompt(false); setVisible(true); }
  }, [foreground, safeToPrompt, pendingPrompt]);

  useEffect(() => {
    if (!visible || !foreground) setModalShown(false);
  }, [visible, foreground]);

  useEffect(() => {
    if (!modalShown || !visible || !foreground || !safeToPrompt || !notice || !rollbackNoticePending.current) return;
    rollbackNoticePending.current = false;
    void appUpdates.acknowledgeRollback().catch(() => { rollbackNoticePending.current = true; });
  }, [modalShown, visible, foreground, safeToPrompt, notice]);

  // Confirm only after the first navigation render has stayed alive in foreground.
  // The native pending marker survives fatal startup failures and triggers rollback.
  useEffect(() => {
    if (!navigationReady) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let confirmed = false;
    let foreground = false;
    let disposed = false;
    let attempts = 0;
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    const confirm = () => {
      if (disposed || confirmed || !foreground) return;
      void appUpdates.markLaunchSuccessful().then(() => {
        confirmed = true;
        clear();
      }).catch(() => {
        // Native storage can briefly be busy while the bridge is coming up.
        // Retry a few times while the app remains in the foreground instead
        // of silently leaving the patch in the unconfirmed state.
        if (!disposed && !confirmed && foreground && attempts < 6) schedule(5000);
      });
    };
    // Five seconds of continuous foreground time is enough to get past the
    // first navigation paint while keeping the unconfirmed window bounded.
    // Failed bridge/storage calls retry every five seconds for at most 30s.
    const schedule = (delay = 5000) => {
      clear();
      if (!disposed && !confirmed && foreground) {
        attempts += 1;
        timer = setTimeout(confirm, delay);
      }
    };
    const onVisibilityChange = (state: string) => {
      const wasForeground = foreground;
      foreground = state === 'foreground';
      if (!wasForeground && foreground) attempts = 0;
      if (foreground) schedule();
      else clear();
    };
    const unsubscribe = subscribeAppVisibility(onVisibilityChange);
    return () => { disposed = true; clear(); unsubscribe(); };
  }, [navigationReady]);

  const applyUpdate = async () => {
    if (!available || downloadingRef.current) return;
    const target = available;
    const revision = ++actionRevision.current;
    downloadingRef.current = true;
    setError('');
    try {
      if (target.kind === 'store') {
        await Linking.openURL(target.url);
      } else if (target.kind === 'apk') {
        if (phase !== 'ready') {
          setPhase('downloading'); setProgress(null);
          await appUpdates.downloadApk(target.url, target.manifest.appVersion);
          if (mounted.current) setPhase('ready');
        }
        // Downloading may outlive the screen or the foreground session. Keep
        // the verified APK ready and let the user install after returning.
        if (mounted.current && foregroundRef.current) await appUpdates.installApk();
      } else {
        setPhase('downloading'); setProgress(null);
        await appUpdates.stageBundle(target.url, target.manifest.appVersion, target.manifest.bundleVersion);
        if (mounted.current) setPhase('staged');
      }
    } catch (reason) {
      if (mounted.current) {
        setError(describeError(reason));
        try {
          const state = await appUpdates.getState();
          if (mounted.current && revision === actionRevision.current) {
            setPhase(target.kind === 'apk' && state.apkReady && state.apkVersion === target.manifest.appVersion ? 'ready' : 'offer');
          }
        } catch { if (mounted.current && revision === actionRevision.current) setPhase('offer'); }
      }
    } finally { downloadingRef.current = false; }
  };

  const dismiss = () => { setVisible(false); setPendingPrompt(false); };
  const percent = progress && progress.total > 0 ? Math.min(100, Math.floor(progress.received * 100 / progress.total)) : null;
  const downloading = phase === 'downloading';
  const mandatory = Boolean(available?.manifest.mandatory) && phase !== 'staged';
  const primaryLabel = phase === 'staged' ? (zh ? '知道了' : 'Done')
    : phase === 'ready' ? (zh ? '安装更新' : 'Install Update')
      : available?.kind === 'store' ? (zh ? '前往更新' : 'Open Update')
        : (zh ? '下载更新' : 'Download Update');

  return <UpdateContext.Provider value={{ checking, checkForUpdates: async () => { await check(true); } }}>
    {children}
    <SecureModal visible={visible && foreground} transparent animationType="fade" onShow={() => setModalShown(true)} onRequestClose={() => { if (!mandatory && !downloading) dismiss(); }}>
      <View style={styles.overlay}><View style={styles.sheet}>
        <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent} showsVerticalScrollIndicator={false}>
        <View style={styles.icon}><ArrowDownLeft size={28} color={colors.accentBright} /></View>
        <Text style={styles.heading}>{available ? (zh ? '发现新版本' : 'Update Available') : (zh ? '检查更新' : 'Check for Updates')}</Text>
        {available ? <Text style={styles.version}>{available.manifest.appVersion}{available.kind === 'bundle' ? ` · ${zh ? '补丁' : 'Patch'} ${available.manifest.bundleVersion}` : ''}{available.manifest.mandatory ? (zh ? ' · 必须更新' : ' · Required') : ''}</Text> : null}
        {available ? <Text style={styles.body}>{available.manifest.description || (zh ? '修复问题并提升使用体验。' : 'Bug fixes and improvements.')}</Text> : null}
        {phase === 'staged' && available ? <Text style={styles.success}>{zh ? '更新已准备好，完全关闭并重新打开应用后生效。' : 'The update is ready. Fully close and reopen the app to apply it.'}</Text> : null}
        {notice ? <Text style={styles.body}>{notice}</Text> : null}
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {downloading && available ? <View style={styles.progressWrap}>
          <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${percent ?? 0}%` }]} /></View>
          <View style={styles.progressText}><ActivityIndicator color={colors.accentBright} size="small" /><Text style={styles.body}>{percent === 100 ? (zh ? '正在校验更新包…' : 'Verifying update…') : `${zh ? '正在下载' : 'Downloading'}${percent === null ? '…' : ` ${percent}%`}`}</Text></View>
        </View> : null}
        {available ? <View style={styles.hint}><ShieldCheck size={17} color={colors.green} /><Text style={styles.hintText}>{available.kind === 'bundle' ? (zh ? '校验通过后才会启用，启动失败会自动回退。' : 'The patch is verified before use and rolls back automatically if startup fails.') : (zh ? '由系统确认安装，应用数据会保留。' : 'The system confirms the update and preserves app data.')}</Text></View> : null}
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: downloading, busy: downloading }} disabled={downloading} onPress={() => { if (!available || phase === 'staged') dismiss(); else void applyUpdate(); }} style={({ pressed }) => [styles.primary, downloading && styles.disabled, pressed && styles.pressed]}><Text style={styles.primaryText}>{available ? (downloading ? (zh ? '更新中…' : 'Updating…') : primaryLabel) : (zh ? '关闭' : 'Close')}</Text></Pressable>
        {available && phase !== 'staged' && !downloading && !mandatory ? <Pressable accessibilityRole="button" onPress={dismiss} style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}><Text style={styles.secondaryText}>{zh ? '稍后更新' : 'Update Later'}</Text></Pressable> : null}
        </ScrollView>
      </View></View>
    </SecureModal>
  </UpdateContext.Provider>;
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.66)', justifyContent: 'center', padding: 24 },
  sheet: { width: '100%', maxWidth: 440, alignSelf: 'center', maxHeight: '88%', backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: 24, overflow: 'hidden' },
  sheetScroll: { flexGrow: 0, flexShrink: 1 },
  sheetContent: { padding: 24, gap: 14 },
  icon: { width: 54, height: 54, borderRadius: 18, backgroundColor: '#2a2450', justifyContent: 'center', alignItems: 'center' },
  heading: { color: colors.ink, fontSize: 23, fontWeight: '800' },
  version: { color: colors.accentBright, fontSize: 14, fontWeight: '600' },
  body: { color: colors.muted, fontSize: 14, lineHeight: 22 },
  error: { color: colors.red, fontSize: 14, lineHeight: 22 },
  success: { color: colors.green, fontSize: 14, lineHeight: 22 },
  progressWrap: { gap: 10 }, progressTrack: { height: 6, borderRadius: 3, backgroundColor: colors.line, overflow: 'hidden' },
  progressFill: { height: 6, backgroundColor: colors.accentBright }, progressText: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  hint: { flexDirection: 'row', gap: 7, alignItems: 'center' }, hintText: { flex: 1, color: colors.muted, fontSize: 12, lineHeight: 18 },
  primary: { minHeight: 49, paddingHorizontal: 16, paddingVertical: 13, borderRadius: 14, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', marginTop: 5 },
  primaryText: { color: colors.ink, fontSize: 16, lineHeight: 23, fontWeight: '700', textAlign: 'center' }, disabled: { opacity: 0.55 },
  pressed: { opacity: 0.72 },
  secondary: { minHeight: 44, paddingHorizontal: 12, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' }, secondaryText: { color: colors.muted, fontSize: 14, lineHeight: 21, textAlign: 'center' },
});
