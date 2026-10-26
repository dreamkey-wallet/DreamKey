import React, { useEffect, useRef, useState } from 'react';
import Clipboard from '@react-native-clipboard/clipboard';
import { ActivityIndicator, BackHandler, Keyboard, KeyboardAvoidingView, PixelRatio, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ViewStyle } from 'react-native';
import { SecureModal as Modal } from '../SecureModal.js';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, ChevronRight, Eye, EyeOff, FileKey, KeyRound, LockKeyhole, Plus, ShieldCheck, Trash2, UserRound, Wallet, X } from '../icons.js';
import { useI18n } from '../../i18n.js';
import { WalletManager, type ManagedWalletRecord } from '../../core/wallet-manager.js';
import { walletColors as colors, walletRadii, walletSpacing, walletTypography } from '../theme.js';
import { PageHeader, PrimaryButton, SecondaryButton } from '../primitives.js';

export interface WalletManagementScreenProps {
  manager: WalletManager;
  onBack?: () => void;
  onChanged?: () => void;
  onSelect?: (wallet: ManagedWalletRecord) => void | Promise<void>;
  onCreateMnemonic?: () => void;
  onImportMnemonic?: () => void;
  onImportPrivateKey?: () => void;
  /** Sensitive exports are called only after a fresh host authentication step. */
  onExportPrivateKey?: (wallet: ManagedWalletRecord) => string | void | Promise<string | void>;
  onExportMnemonic?: (wallet: ManagedWalletRecord) => string | void | Promise<string | void>;
  authenticationMode?: 'biometric' | 'password' | 'both';
  /** Undefined requests biometrics; a supplied string requests password verification. */
  onAuthenticate?: (password?: string) => Promise<boolean>;
}

type ExportKind = 'privateKey' | 'mnemonic';
type Sheet = { kind: 'create' } | { kind: 'actions' | 'remove' | 'rename'; wallet: ManagedWalletRecord } | { kind: 'watch' } | { kind: 'export'; wallet: ManagedWalletRecord; exportKind: ExportKind };
type ExportSecret = { kind: ExportKind; value: string; walletLabel: string };

function shortAddress(address: string): string { return `${address.slice(0, 8)}…${address.slice(-6)}`; }

function SheetOption({ title, hint, icon, onPress, destructive = false, disabled }: { title: string; hint: string; icon: React.ReactNode; onPress: () => void; destructive?: boolean; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.option, pressed && styles.pressed, disabled && styles.disabled]}><View style={[styles.optionIcon, destructive && styles.dangerIcon]}>{icon}</View><View style={styles.optionCopy}><Text style={[styles.optionTitle, destructive && styles.dangerText]}>{title}</Text><Text style={styles.optionHint}>{hint}</Text></View><ChevronRight size={19} color={colors.textTertiary} /></Pressable>;
}

/** A single native sheet keeps selection, inputs and authentication from overlapping. */
export function WalletManagementScreen({ manager, onBack, onChanged, onSelect, onCreateMnemonic, onImportMnemonic, onImportPrivateKey, onExportPrivateKey, onExportMnemonic, authenticationMode = 'biometric', onAuthenticate }: WalletManagementScreenProps) {
  const { language } = useI18n(); const zh = language === 'zh'; const insets = useSafeAreaInsets();
  const [sheet, setSheet] = useState<Sheet | null>(null); const sheetRef = useRef<Sheet | null>(null);
  const [watchAddress, setWatchAddress] = useState(''); const [watchLabel, setWatchLabel] = useState(''); const [renameLabel, setRenameLabel] = useState(''); const [authPassword, setAuthPassword] = useState('');
  const [authMethod, setAuthMethod] = useState<'password' | 'biometric'>(authenticationMode === 'password' ? 'password' : 'biometric');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const busyRef = useRef(false);
  const [selectingWalletId, setSelectingWalletId] = useState<string | null>(null);
  const [exportSecret, setExportSecret] = useState<ExportSecret | null>(null); const [secretVisible, setSecretVisible] = useState(false); const [secretCopied, setSecretCopied] = useState(false); const [secretGridWidth, setSecretGridWidth] = useState(0);
  const [pendingNavigation, setPendingNavigation] = useState<(() => void | Promise<void>) | null>(null); const pendingNavigationRef = useRef<(() => void | Promise<void>) | null>(null);
  const mounted = useRef(true);
  const copiedSecret = useRef<string | null>(null);
  const clipboardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearCopiedSecret = () => {
    if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    clipboardTimer.current = null;
    const value = copiedSecret.current; copiedSecret.current = null;
    if (value) void Clipboard.getString().then((current) => { if (current === value && copiedSecret.current === null) Clipboard.setString(''); }).catch(() => {});
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pendingNavigationRef.current = null; clearCopiedSecret(); Keyboard.dismiss(); }; }, []);
  useEffect(() => {
    const listener = BackHandler.addEventListener('hardwareBackPress', () => busyRef.current);
    return () => listener.remove();
  }, []);
  const text = zh ? {
    title: '钱包管理', createWallet: '创建钱包', create: '创建助记词钱包', mnemonic: '导入助记词', privateKey: '导入私钥', watch: '添加观察钱包', empty: '还没有钱包', emptyHint: '创建或导入钱包，也可添加地址查看资产。', observed: '观察钱包', controlled: '可签名钱包', rename: '编辑名称', renameHint: '为钱包设置一个便于识别的名称。', namePlaceholder: '例如：主钱包', remove: '删除钱包', removeHint: '仅移除此设备上的钱包，链上资产不受影响。请确认已备份私钥或助记词，否则将无法恢复访问。', removeWatchHint: '仅移除此设备上的观察地址，链上资产不受影响。', removeAuthHint: '删除前需要验证身份。', removeVerify: '验证并删除', removeWarningTitle: '确认删除钱包？', removeWarningHint: '删除仅移除此设备上的钱包。请确认已备份私钥或助记词。', exportKey: '导出私钥', exportMnemonic: '导出助记词', exportSafetyTitle: '敏感信息，请谨慎保管', exportSafetyHint: '验证身份后显示私钥或助记词。请勿截图、分享，或粘贴到不可信的应用。', addMethods: '添加方式', walletActions: '钱包操作', exportActions: '导出与安全', deviceActions: '设备管理', watchHint: '仅查看地址、资产和交易记录，不保存密钥。', address: '钱包地址', label: '名称（可选）', cancel: '取消', save: '添加', saveName: '保存名称', invalid: '请输入有效的 EVM 地址。', duplicate: '此地址已添加。', failed: '操作失败，请重试。', authFailed: '验证失败，请重试。', authRequired: '操作前需要身份验证。', verify: '验证并导出', verifying: '验证中…', password: '钱包密码', biometric: '生物识别', passwordPlaceholder: '输入钱包密码', authHint: '验证身份后显示敏感信息，请避免他人查看屏幕。', chooseAuth: '选择验证方式',
  } : {
    title: 'Wallet Management', createWallet: 'Add Wallet', create: 'Create New Wallet', mnemonic: 'Import Recovery Phrase', privateKey: 'Import Private Key', watch: 'Add Watch-Only Wallet', empty: 'No Wallets Yet', emptyHint: 'Create or import a wallet, or add an address to view its assets.', observed: 'Watch-Only', controlled: 'Signing Wallet', rename: 'Edit Name', renameHint: 'Choose a name that makes this wallet easy to recognize.', namePlaceholder: 'For example: Main Wallet', remove: 'Remove Wallet', removeHint: 'This removes the wallet from this device. Your onchain assets are unaffected. Back up your private key or recovery phrase first so you can restore access.', removeWatchHint: 'This removes the watched address from this device. Your onchain assets are unaffected.', removeAuthHint: 'Verify your identity before removing this wallet.', removeVerify: 'Verify and Remove', removeWarningTitle: 'Remove This Wallet?', removeWarningHint: 'This wallet will be removed from this device. Make sure you have backed up its private key or recovery phrase.', exportKey: 'Export Private Key', exportMnemonic: 'Export Recovery Phrase', exportSafetyTitle: 'Keep This Information Private', exportSafetyHint: 'Your private key or recovery phrase is shown after verification. Never take screenshots, share it, or paste it into an untrusted app.', addMethods: 'Add Wallet', walletActions: 'Wallet Actions', exportActions: 'Export and Security', deviceActions: 'Device Management', watchHint: 'View assets and transaction history without storing keys.', address: 'Wallet Address', label: 'Name (Optional)', cancel: 'Cancel', save: 'Add', saveName: 'Save Name', invalid: 'Enter a valid EVM address.', duplicate: 'This address has already been added.', failed: 'The operation failed. Please try again.', authFailed: 'Verification failed. Please try again.', authRequired: 'Verify your identity before continuing.', verify: 'Verify and Export', verifying: 'Verifying…', password: 'Wallet Password', biometric: 'Biometrics', passwordPlaceholder: 'Enter Wallet Password', authHint: 'Verify your identity to view sensitive information. Make sure no one else can see your screen.', chooseAuth: 'Verification Method',
  };

  const privateKeyWalletLabel = zh ? '私钥钱包' : 'Private Key Wallet';
  const mnemonicWalletLabel = zh ? '助记词钱包' : 'Recovery Phrase Wallet';
  const privateKeyWalletHint = zh ? '此钱包通过私钥导入，没有助记词。请妥善备份私钥。' : 'This wallet was imported with a private key and has no recovery phrase. Keep a secure backup of its private key.';
  const exportSafetyHint = (kind: ExportKind) => kind === 'privateKey'
    ? (zh ? '验证身份后显示私钥。请勿截图、分享，或粘贴到不可信的应用。' : 'Your private key is shown after verification. Never take screenshots, share it, or paste it into an untrusted app.')
    : (zh ? '验证身份后显示助记词。请勿截图、分享，或粘贴到不可信的应用。' : 'Your recovery phrase is shown after verification. Never take screenshots, share it, or paste it into an untrusted app.');
  const removeHint = (wallet: ManagedWalletRecord) => wallet.watchOnly ? text.removeWatchHint : wallet.kind === 'privateKey'
    ? (zh ? '仅移除此设备上的钱包，链上资产不受影响。此钱包没有助记词，请确认已备份私钥，否则将无法恢复访问。' : 'This removes the wallet from this device. Your onchain assets are unaffected. This wallet has no recovery phrase, so back up its private key first to restore access.')
    : text.removeHint;
  const resetInputs = () => { setWatchAddress(''); setWatchLabel(''); setRenameLabel(''); setAuthPassword(''); setError(''); };
  const closeExportSecret = () => { clearCopiedSecret(); setExportSecret(null); setSecretVisible(false); setSecretCopied(false); };
  const copyExportSecret = () => {
    if (!exportSecret || !mounted.current) return;
    if (clipboardTimer.current) clearTimeout(clipboardTimer.current);
    copiedSecret.current = exportSecret.value; Clipboard.setString(exportSecret.value); setSecretCopied(true);
    clipboardTimer.current = setTimeout(() => { clearCopiedSecret(); if (mounted.current) setSecretCopied(false); }, 30_000);
  };
  const setCurrentSheet = (next: Sheet | null) => { sheetRef.current = next; setSheet(next); };
  const openSheet = (next: Sheet) => { if (busyRef.current || pendingNavigationRef.current) return; Keyboard.dismiss(); resetInputs(); setAuthMethod(authenticationMode === 'password' ? 'password' : 'biometric'); setCurrentSheet(next); };
  const closeSheet = () => { if (busyRef.current) return; Keyboard.dismiss(); resetInputs(); setCurrentSheet(null); };
  const beginOperation = () => { if (busyRef.current) return false; busyRef.current = true; setBusy(true); setError(''); Keyboard.dismiss(); return true; };
  const endOperation = () => { busyRef.current = false; setBusy(false); };
  const selectWallet = async (wallet: ManagedWalletRecord) => {
    if (!onSelect || !beginOperation()) return;
    setSelectingWalletId(wallet.id);
    try { await onSelect(wallet); } catch { setError(text.failed); } finally { setSelectingWalletId(null); endOperation(); }
  };
  const runPendingNavigation = () => {
    const next = pendingNavigationRef.current; if (!next) return;
    pendingNavigationRef.current = null; setPendingNavigation(null);
    void (async () => { try { await next(); } catch { setError(text.failed); } finally { endOperation(); } })();
  };
  const navigateFromSheet = (next: (() => void) | undefined) => {
    if (!next || pendingNavigationRef.current || !beginOperation()) return;
    Keyboard.dismiss(); resetInputs(); pendingNavigationRef.current = next; setPendingNavigation(() => next); setCurrentSheet(null);
    // Android onDismiss is not consistently fired by native Modal.
    if (Platform.OS !== 'ios') requestAnimationFrame(runPendingNavigation);
  };
  const addWatch = async () => {
    if (sheetRef.current?.kind !== 'watch' || !watchAddress.trim() || !beginOperation()) return;
    try { await manager.addWatchAddressAndPersist(watchAddress.trim(), watchLabel.trim() || undefined); resetInputs(); setCurrentSheet(null); onChanged?.(); }
    catch (cause) { const message = cause instanceof Error ? cause.message : ''; setError(/already/i.test(message) ? text.duplicate : /address/i.test(message) ? text.invalid : text.failed); }
    finally { endOperation(); }
  };
  const renameWallet = async () => {
    const request = sheetRef.current;
    if (request?.kind !== 'rename' || !renameLabel.trim() || !beginOperation()) return;
    try { await manager.renameAndPersist(request.wallet.id, renameLabel.trim()); resetInputs(); setCurrentSheet(null); onChanged?.(); }
    catch { setError(text.failed); }
    finally { endOperation(); }
  };
  const authenticateOperation = async () => {
    const method = authMethod;
    let authenticated = false;
    try { authenticated = await onAuthenticate?.(method === 'password' ? authPassword : undefined) ?? false; }
    catch { /* Cancellation, unavailable hardware and native errors use the same safe fallback. */ }
    if (!mounted.current) return false;
    if (authenticated) return true;
    setAuthPassword('');
    if (method === 'biometric' && authenticationMode === 'both') {
      setAuthMethod('password');
      setError(zh ? '生物识别未完成，请使用钱包密码验证。' : 'Biometric verification was not completed. Use your wallet password to continue.');
    } else setError(text.authFailed);
    return false;
  };
  const requestRemove = (wallet: ManagedWalletRecord) => {
    if (!onAuthenticate) { setError(text.authRequired); return; }
    openSheet({ kind: 'remove', wallet });
  };
  const removeWallet = async () => {
    const request = sheetRef.current;
    if (request?.kind !== 'remove' || !onAuthenticate || (authMethod === 'password' && !authPassword) || !beginOperation()) return;
    try {
      if (!(await authenticateOperation())) return;
      await manager.removeAndPersist(request.wallet.id); resetInputs(); setCurrentSheet(null); onChanged?.();
    } catch { setError(text.failed); } finally { endOperation(); }
  };
  const requestExport = (wallet: ManagedWalletRecord, exportKind: ExportKind) => {
    if (!onAuthenticate) { setError(text.authRequired); return; }
    openSheet({ kind: 'export', wallet, exportKind });
  };
  const confirmExport = async () => {
    const request = sheetRef.current;
    if (request?.kind !== 'export' || !onAuthenticate || (authMethod === 'password' && !authPassword) || !beginOperation()) return;
    try {
      if (!(await authenticateOperation())) return;
      const exportAfterDismiss = async () => {
        if (!mounted.current) return;
        const value = request.exportKind === 'privateKey' ? await onExportPrivateKey?.(request.wallet) : await onExportMnemonic?.(request.wallet);
        if (mounted.current && typeof value === 'string' && value.length > 0) setExportSecret({ kind: request.exportKind, value, walletLabel: request.wallet.label });
      };
      pendingNavigationRef.current = exportAfterDismiss; setPendingNavigation(() => exportAfterDismiss);
      resetInputs(); setCurrentSheet(null);
      if (Platform.OS !== 'ios') requestAnimationFrame(runPendingNavigation);
    } catch { setError(text.authFailed); } finally { if (!pendingNavigationRef.current) endOperation(); }
  };
  const chooseAuth = (next: 'password' | 'biometric') => { if (busyRef.current) return; Keyboard.dismiss(); setAuthMethod(next); setAuthPassword(''); setError(''); };
  const sheetTitle = sheet?.kind === 'create' ? text.createWallet : sheet?.kind === 'watch' ? text.watch : sheet?.kind === 'export' ? (sheet.exportKind === 'privateKey' ? text.exportKey : text.exportMnemonic) : sheet?.kind === 'remove' ? text.remove : sheet?.kind === 'rename' ? text.rename : sheet?.wallet.label ?? '';
  const sheetHint = sheet?.kind === 'create' ? (zh ? '选择一种方式添加钱包' : 'Choose how to add a wallet.') : sheet?.kind === 'watch' ? text.watchHint : sheet && 'wallet' in sheet ? shortAddress(sheet.wallet.address) : undefined;
  const sheetPadding: ViewStyle = { paddingBottom: Math.max(insets.bottom, walletSpacing.lg) };
  const wallets = manager.list();
  const fontScale = PixelRatio?.getFontScale?.() ?? 1;
  const mnemonicSingleColumn = fontScale >= 1.2 || (secretGridWidth > 0 && secretGridWidth < 320);

  return <View style={styles.screen}>
    <PageHeader title={text.title} onBack={() => { if (!busyRef.current) { Keyboard.dismiss(); onBack?.(); } }} />
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      {wallets.length ? <Text style={styles.intro}>{zh ? '轻点切换钱包，点击更多按钮编辑名称或管理安全信息。' : 'Tap a wallet to switch. Use its menu to edit the name or manage security.'}</Text> : null}
      {!wallets.length ? <View style={styles.empty}><View style={styles.emptyIcon}><UserRound size={28} color={colors.primary} /></View><Text style={styles.emptyTitle}>{text.empty}</Text><Text style={styles.emptyHint}>{text.emptyHint}</Text></View> : null}
      {wallets.map((wallet) => <Pressable accessibilityRole="button" accessibilityState={{ selected: manager.getSelectedId() === wallet.id, disabled: busy, busy: selectingWalletId === wallet.id }} disabled={busy} key={wallet.id} onPress={() => { void selectWallet(wallet); }} style={({ pressed }) => [styles.walletCard, manager.getSelectedId() === wallet.id && styles.walletCardSelected, pressed && styles.pressed, busy && selectingWalletId !== wallet.id && styles.disabled]}>
        <View style={styles.walletIcon}>{wallet.watchOnly ? <Eye size={21} color={colors.primary} /> : <KeyRound size={21} color={colors.primary} />}</View><View style={styles.walletCopy}><Text style={styles.walletLabel} numberOfLines={2}>{wallet.label}</Text><Text style={styles.walletType}>{wallet.watchOnly ? text.observed : wallet.kind === 'privateKey' ? privateKeyWalletLabel : mnemonicWalletLabel}{manager.getSelectedId() === wallet.id ? (zh ? ' · 当前' : ' · Current') : ''}</Text><Text style={styles.walletAddress} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85}>{shortAddress(wallet.address)}</Text></View>
        {selectingWalletId === wallet.id ? <ActivityIndicator size="small" color={colors.primary} /> : manager.getSelectedId() === wallet.id ? <Check size={19} color={colors.primary} /> : null}<Pressable accessibilityRole="button" accessibilityLabel={zh ? '钱包操作' : 'Wallet Actions'} accessibilityHint={wallet.label} disabled={busy} onPress={(event) => { event.stopPropagation(); openSheet({ kind: 'actions', wallet }); }} style={({ pressed }) => [styles.iconButton, pressed && styles.menuPressed]}><Text style={styles.moreText}>•••</Text></Pressable>
      </Pressable>)}
      {!sheet && error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    </ScrollView>
    <View style={styles.footer}><PrimaryButton title={text.createWallet} disabled={busy || Boolean(pendingNavigation)} onPress={() => openSheet({ kind: 'create' })} /></View>
    <Modal visible={Boolean(sheet)} animationType="slide" transparent onRequestClose={closeSheet} onDismiss={runPendingNavigation}>
      <KeyboardAvoidingView style={styles.modalBackdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable accessibilityRole="button" accessibilityLabel={text.cancel} disabled={busy} onPress={closeSheet} style={styles.scrim} />
        <View style={[styles.sheet, sheetPadding]}>
          <View style={styles.handle} />
          <View style={styles.sheetHeader}>
            {sheet ? <View style={[styles.sheetIcon, sheet.kind === 'remove' && styles.sheetIconDanger, sheet.kind === 'export' && styles.sheetIconSensitive]}>
              {sheet.kind === 'create' || sheet.kind === 'actions' ? <Wallet size={22} color={colors.primary} /> : null}
              {sheet.kind === 'watch' ? <Eye size={22} color={colors.primary} /> : null}
              {sheet.kind === 'rename' ? <UserRound size={22} color={colors.primary} /> : null}
              {sheet.kind === 'export' ? (sheet.exportKind === 'privateKey' ? <KeyRound size={22} color={colors.primary} /> : <FileKey size={22} color={colors.primary} />) : null}
              {sheet.kind === 'remove' ? <Trash2 size={22} color={colors.danger} /> : null}
            </View> : null}
            <View style={styles.sheetHeading}><Text style={styles.modalTitle} numberOfLines={2}>{sheetTitle}</Text>{sheetHint ? <Text style={styles.createHint}>{sheetHint}</Text> : null}</View><Pressable accessibilityRole="button" accessibilityLabel={text.cancel} disabled={busy} onPress={closeSheet} style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}><X size={19} color={colors.textSecondary} /></Pressable>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false} contentContainerStyle={styles.sheetContent}>
            {sheet?.kind === 'create' ? <View style={styles.createOptions}>
              <Text style={styles.optionGroupLabel}>{text.addMethods}</Text>
              {onCreateMnemonic ? <SheetOption title={text.create} hint={zh ? '生成新的助记词钱包' : 'Create a wallet with a new recovery phrase.'} icon={<Plus size={20} color={colors.primary} />} onPress={() => navigateFromSheet(onCreateMnemonic)} /> : null}
              {onImportMnemonic ? <SheetOption title={text.mnemonic} hint={zh ? '使用已有助记词恢复钱包' : 'Restore a wallet using its recovery phrase.'} icon={<FileKey size={20} color={colors.primary} />} onPress={() => navigateFromSheet(onImportMnemonic)} /> : null}
              {onImportPrivateKey ? <SheetOption title={text.privateKey} hint={zh ? '导入单个私钥账户' : 'Import one account using its private key.'} icon={<KeyRound size={20} color={colors.primary} />} onPress={() => navigateFromSheet(onImportPrivateKey)} /> : null}
              <SheetOption title={text.watch} hint={zh ? '只查看地址和资产，不保存密钥' : 'Track an address without storing keys.'} icon={<Eye size={20} color={colors.primary} />} onPress={() => openSheet({ kind: 'watch' })} />
            </View> : null}
            {sheet?.kind === 'actions' ? <View style={styles.createOptions}>
              {!sheet.wallet.watchOnly && sheet.wallet.kind === 'privateKey' ? <Text style={styles.authHint}>{privateKeyWalletHint}</Text> : null}
              <SheetOption title={text.rename} hint={text.renameHint} icon={<UserRound size={20} color={colors.primary} />} onPress={() => { openSheet({ kind: 'rename', wallet: sheet.wallet }); setRenameLabel(sheet.wallet.label); }} />
              {(!sheet.wallet.watchOnly && (onExportPrivateKey || (sheet.wallet.kind === 'mnemonic' && onExportMnemonic))) ? <Text style={styles.optionGroupLabel}>{text.exportActions}</Text> : null}
              {!sheet.wallet.watchOnly && onExportPrivateKey ? <SheetOption title={text.exportKey} hint={zh ? '验证身份后查看私钥' : 'Verify your identity to view the private key.'} icon={<KeyRound size={20} color={colors.primary} />} onPress={() => requestExport(sheet.wallet, 'privateKey')} /> : null}
              {!sheet.wallet.watchOnly && sheet.wallet.kind === 'mnemonic' && onExportMnemonic ? <SheetOption title={text.exportMnemonic} hint={zh ? '验证身份后查看助记词' : 'Verify your identity to view the recovery phrase.'} icon={<FileKey size={20} color={colors.primary} />} onPress={() => requestExport(sheet.wallet, 'mnemonic')} /> : null}
              <Text style={styles.optionGroupLabel}>{text.deviceActions}</Text>
              <SheetOption title={text.remove} hint={zh ? '验证身份后从此设备移除钱包记录' : 'Verify your identity to remove this wallet from this device.'} destructive icon={<Trash2 size={20} color={colors.danger} />} onPress={() => requestRemove(sheet.wallet)} />
            </View> : null}
            {sheet?.kind === 'watch' ? <View style={styles.form}>
              <Text style={styles.authHint}>{zh ? '输入 EVM 钱包地址，只查看资产和交易记录。' : 'Enter an EVM address to view assets and transaction history.'}</Text><Text style={styles.fieldLabel}>{text.address}</Text><TextInput accessibilityLabel={text.address} value={watchAddress} editable={!busy} onChangeText={(value) => { setWatchAddress(value); setError(''); }} autoCapitalize="none" autoCorrect={false} placeholder="0x…" placeholderTextColor={colors.textTertiary} style={styles.field} returnKeyType="done" onSubmitEditing={Keyboard.dismiss} /><Text style={styles.fieldLabel}>{text.label}</Text><TextInput accessibilityLabel={text.label} value={watchLabel} editable={!busy} onChangeText={(value) => { setWatchLabel(value); setError(''); }} placeholder={text.observed} placeholderTextColor={colors.textTertiary} maxLength={80} style={styles.field} returnKeyType="done" onSubmitEditing={() => { void addWatch(); }} />
            </View> : null}
            {sheet?.kind === 'rename' ? <View style={styles.form}>
              <Text style={styles.authHint}>{text.renameHint}</Text><Text style={styles.fieldLabel}>{zh ? '钱包名称' : 'Wallet Name'}</Text><TextInput accessibilityLabel={zh ? '钱包名称' : 'Wallet Name'} value={renameLabel} editable={!busy} onChangeText={(value) => { setRenameLabel(value); setError(''); }} autoCapitalize="sentences" autoCorrect={false} placeholder={text.namePlaceholder} placeholderTextColor={colors.textTertiary} maxLength={80} style={styles.field} returnKeyType="done" onSubmitEditing={() => { void renameWallet(); }} />
            </View> : null}
            {sheet?.kind === 'export' || sheet?.kind === 'remove' ? <View style={styles.form}>
              {sheet.kind === 'export' ? <View style={styles.sensitiveCard}>
                <View style={styles.sensitiveIcon}><ShieldCheck size={21} color={colors.primary} /></View>
                <View style={styles.sensitiveCopy}><Text style={styles.sensitiveTitle}>{text.exportSafetyTitle}</Text><Text style={styles.sensitiveHint}>{exportSafetyHint(sheet.exportKind)}</Text></View>
              </View> : <View style={styles.dangerCard}>
                <View style={styles.dangerCardIcon}><Trash2 size={20} color={colors.danger} /></View>
                <View style={styles.sensitiveCopy}><Text style={styles.dangerCardTitle}>{text.removeWarningTitle}</Text><Text style={styles.sensitiveHint}>{removeHint(sheet.wallet)}</Text></View>
              </View>}
              <Text style={styles.authHint}>{sheet.kind === 'remove' ? text.removeAuthHint : text.authHint}</Text>
              {authenticationMode === 'both' ? <><Text style={styles.fieldLabel}>{text.chooseAuth}</Text><View style={styles.authTabs}><Pressable accessibilityRole="radio" accessibilityState={{ selected: authMethod === 'biometric' }} disabled={busy} onPress={() => chooseAuth('biometric')} style={[styles.authTab, authMethod === 'biometric' && styles.authTabSelected]}><ShieldCheck size={18} color={authMethod === 'biometric' ? colors.primary : colors.textSecondary} /><Text style={[styles.authTabText, authMethod === 'biometric' && styles.authTabTextSelected]}>{text.biometric}</Text></Pressable><Pressable accessibilityRole="radio" accessibilityState={{ selected: authMethod === 'password' }} disabled={busy} onPress={() => chooseAuth('password')} style={[styles.authTab, authMethod === 'password' && styles.authTabSelected]}><LockKeyhole size={18} color={authMethod === 'password' ? colors.primary : colors.textSecondary} /><Text style={[styles.authTabText, authMethod === 'password' && styles.authTabTextSelected]}>{text.password}</Text></Pressable></View></> : null}
              {authMethod === 'password' ? <TextInput accessibilityLabel={text.password} value={authPassword} editable={!busy} onChangeText={(value) => { setAuthPassword(value); setError(''); }} secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder={text.passwordPlaceholder} placeholderTextColor={colors.textTertiary} style={styles.field} returnKeyType="done" onSubmitEditing={() => { if (sheet.kind === 'remove') void removeWallet(); else void confirmExport(); }} /> : <View style={styles.authNotice}><ShieldCheck size={21} color={colors.primary} /><Text style={styles.authNoticeText}>{zh ? '点击下方按钮进行生物识别验证' : 'Tap the button below to verify with biometrics.'}</Text></View>}
            </View> : null}
            {error ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
            {sheet?.kind === 'watch' || sheet?.kind === 'rename' || sheet?.kind === 'export' || sheet?.kind === 'remove' ? <View style={styles.modalActions}><SecondaryButton title={text.cancel} disabled={busy} onPress={closeSheet} style={styles.sheetAction} /><PrimaryButton title={sheet.kind === 'watch' ? text.save : sheet.kind === 'rename' ? text.saveName : sheet.kind === 'remove' ? text.removeVerify : busy ? text.verifying : text.verify} loading={busy} disabled={busy || (sheet.kind === 'watch' && !watchAddress.trim()) || (sheet.kind === 'rename' && !renameLabel.trim()) || ((sheet.kind === 'export' || sheet.kind === 'remove') && authMethod === 'password' && !authPassword)} onPress={() => { if (sheet.kind === 'watch') void addWatch(); else if (sheet.kind === 'rename') void renameWallet(); else if (sheet.kind === 'remove') void removeWallet(); else void confirmExport(); }} style={[styles.sheetAction, sheet.kind === 'remove' && styles.deleteButton]} /></View> : null}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
    <Modal visible={Boolean(exportSecret)} animationType="fade" transparent onRequestClose={closeExportSecret}>
      <View style={styles.secretModalBackdrop}>
        <View style={styles.secretModalCard}>
          <View style={styles.secretModalHeader}>
            <View style={styles.secretModalIcon}><ShieldCheck size={21} color={colors.primary} /></View>
            <View style={styles.secretModalHeading}>
              <Text style={styles.modalTitle}>{exportSecret?.kind === 'privateKey' ? text.exportKey : text.exportMnemonic}</Text>
              {exportSecret?.walletLabel ? <Text style={styles.createHint} numberOfLines={2}>{exportSecret.walletLabel}</Text> : null}
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={text.cancel} onPress={closeExportSecret} style={styles.closeButton}><X size={19} color={colors.textSecondary} /></Pressable>
          </View>
          <ScrollView style={styles.secretBody} contentContainerStyle={styles.secretBodyContent} showsVerticalScrollIndicator={false}>
          <View style={styles.secretWarning}><ShieldCheck size={18} color={colors.primary} /><Text style={styles.secretWarningText}>{exportSafetyHint(exportSecret?.kind ?? 'privateKey')}</Text></View>
          <View style={styles.secretValueCard}>
            <ScrollView style={styles.secretValueScroll} contentContainerStyle={styles.secretValueScrollContent} nestedScrollEnabled showsVerticalScrollIndicator={secretVisible}>
              {secretVisible && exportSecret?.kind === 'mnemonic' ? <View onLayout={(event) => setSecretGridWidth(event.nativeEvent.layout.width)} style={[styles.mnemonicGrid, mnemonicSingleColumn && styles.mnemonicGridSingleColumn]}>{exportSecret.value.trim().split(/\s+/).map((word, index) => <View key={index} style={[styles.mnemonicWord, mnemonicSingleColumn && styles.mnemonicWordSingleColumn]}><Text style={styles.mnemonicIndex}>{index + 1}</Text><Text selectable numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} style={styles.mnemonicText}>{word}</Text></View>)}</View> : <Text selectable={secretVisible} style={[styles.secretValue, !secretVisible && styles.secretValueHidden]}>{secretVisible ? exportSecret?.value : '•••• •••• •••• ••••'}</Text>}
            </ScrollView>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={secretVisible ? (zh ? '隐藏敏感信息' : 'Hide Sensitive Information') : (zh ? '显示敏感信息' : 'Show Sensitive Information')} onPress={() => setSecretVisible((visible) => !visible)} style={({ pressed }) => [styles.secretToggle, pressed && styles.pressed]}>{secretVisible ? <EyeOff size={18} color={colors.primary} /> : <Eye size={18} color={colors.primary} />}<Text style={styles.secretToggleText}>{secretVisible ? (zh ? '隐藏内容' : 'Hide Details') : (zh ? '显示内容' : 'Show Details')}</Text></Pressable>
          <View style={styles.secretModalActions}>
            <SecondaryButton title={secretCopied ? (zh ? '已复制' : 'Copied') : (zh ? '复制' : 'Copy')} onPress={copyExportSecret} style={styles.flex} />
            <PrimaryButton title={zh ? '完成' : 'Done'} onPress={closeExportSecret} style={styles.flex} />
          </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  intro: { ...walletTypography.body, color: colors.textSecondary, lineHeight: 22, marginTop: walletSpacing.sm, marginBottom: walletSpacing.sm },
  walletCardSelected: { borderWidth: 1, borderColor: colors.primary, backgroundColor: colors.primarySoft },
  menuPressed: { backgroundColor: colors.surfaceMuted, borderRadius: 12 },
  sheetAction: { width: '100%' },
  secretBody: { flexShrink: 1 },
  secretBodyContent: { paddingBottom: walletSpacing.xs },
  secretToggleText: { ...walletTypography.caption, color: colors.primary },
  mnemonicGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: walletSpacing.sm, width: '100%' }, mnemonicGridSingleColumn: { flexDirection: 'column', flexWrap: 'nowrap' },
  mnemonicWord: { flexDirection: 'row', alignItems: 'center', width: '47%', minHeight: 40, paddingHorizontal: walletSpacing.sm, gap: 7, borderRadius: walletRadii.sm, backgroundColor: colors.background }, mnemonicWordSingleColumn: { width: '100%' },
  mnemonicIndex: { color: colors.textTertiary, fontSize: 10, width: 15 },
  mnemonicText: { color: colors.ink, ...walletTypography.mono, flex: 1 },
  screen: { flex: 1, backgroundColor: colors.background, paddingHorizontal: walletSpacing.lg }, content: { paddingBottom: walletSpacing.lg, gap: walletSpacing.md }, footer: { paddingVertical: walletSpacing.lg },
  empty: { alignItems: 'center', paddingVertical: walletSpacing.xxl * 2 }, emptyIcon: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft, marginBottom: walletSpacing.md }, emptyTitle: { ...walletTypography.heading, color: colors.ink }, emptyHint: { ...walletTypography.body, color: colors.textSecondary, textAlign: 'center', marginTop: walletSpacing.sm, maxWidth: 300 },
  walletCard: { flexDirection: 'row', alignItems: 'center', gap: walletSpacing.md, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: walletRadii.lg, padding: walletSpacing.md }, walletIcon: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, walletCopy: { flex: 1, minWidth: 0 }, walletLabel: { ...walletTypography.bodyMedium, color: colors.ink }, walletType: { ...walletTypography.caption, color: colors.textSecondary, marginTop: 2 }, walletAddress: { ...walletTypography.mono, color: colors.textSecondary, marginTop: 2 }, iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, moreText: { color: colors.textSecondary, fontSize: 15, letterSpacing: 1.5 },
  modalBackdrop: { flex: 1, justifyContent: 'flex-end' }, scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)' }, sheet: { backgroundColor: colors.background, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: walletSpacing.xl, maxHeight: '85%' }, handle: { width: 38, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginTop: 10, marginBottom: 18 }, sheetHeader: { flexDirection: 'row', alignItems: 'center', gap: walletSpacing.md, marginBottom: walletSpacing.lg }, sheetHeading: { flex: 1, minWidth: 0 }, sheetIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, sheetIconSensitive: { backgroundColor: colors.primarySoft }, sheetIconDanger: { backgroundColor: colors.dangerSoft }, modalTitle: { ...walletTypography.heading, color: colors.ink }, createHint: { ...walletTypography.caption, color: colors.textSecondary, marginTop: 3 }, closeButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted }, sheetContent: { gap: walletSpacing.md, paddingBottom: walletSpacing.sm },
  secretModalBackdrop: { flex: 1, justifyContent: 'center', padding: walletSpacing.lg, backgroundColor: 'rgba(0,0,0,0.68)' }, secretModalCard: { maxHeight: '90%', width: '100%', maxWidth: 480, alignSelf: 'center', backgroundColor: colors.background, borderRadius: walletRadii.lg, padding: walletSpacing.lg, borderWidth: 1, borderColor: colors.border }, secretModalHeader: { flexDirection: 'row', alignItems: 'center', gap: walletSpacing.md, marginBottom: walletSpacing.lg }, secretModalIcon: { width: 42, height: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, secretModalHeading: { flex: 1, minWidth: 0 }, secretWarning: { flexDirection: 'row', alignItems: 'flex-start', gap: walletSpacing.sm, padding: walletSpacing.md, borderRadius: walletRadii.md, backgroundColor: colors.primarySoft, borderWidth: 1, borderColor: colors.primary, marginBottom: walletSpacing.md }, secretWarningText: { ...walletTypography.caption, color: colors.textSecondary, lineHeight: 18, flex: 1 }, secretValueCard: { minHeight: 116, gap: walletSpacing.sm, padding: walletSpacing.md, borderRadius: walletRadii.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }, secretValueScroll: { maxHeight: 248 }, secretValueScrollContent: { flexGrow: 1, justifyContent: 'center' }, secretValue: { flexShrink: 1, color: colors.ink, ...walletTypography.mono, fontSize: 14, lineHeight: 22 }, secretValueHidden: { color: colors.textTertiary, letterSpacing: 1, textAlign: 'center' }, secretToggle: { minHeight: 44, flexDirection: 'row', alignSelf: 'center', alignItems: 'center', justifyContent: 'center', gap: walletSpacing.sm, paddingHorizontal: walletSpacing.md, marginTop: walletSpacing.sm }, secretModalActions: { flexDirection: 'row', gap: walletSpacing.md, marginTop: walletSpacing.lg },
  createOptions: { gap: walletSpacing.sm }, optionGroupLabel: { ...walletTypography.caption, color: colors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.7, marginTop: walletSpacing.xs, marginBottom: walletSpacing.xs }, option: { flexDirection: 'row', alignItems: 'center', gap: walletSpacing.md, padding: walletSpacing.md, borderRadius: walletRadii.lg, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }, optionIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primarySoft }, optionCopy: { flex: 1, minWidth: 0 }, optionTitle: { ...walletTypography.bodyMedium, color: colors.ink }, optionHint: { ...walletTypography.caption, color: colors.textSecondary, marginTop: 3 }, dangerIcon: { backgroundColor: colors.dangerSoft }, dangerText: { color: colors.danger }, pressed: { opacity: 0.75 }, disabled: { opacity: 0.5 },
  form: { gap: walletSpacing.sm }, authHint: { ...walletTypography.body, color: colors.textSecondary, lineHeight: 22, marginBottom: walletSpacing.sm }, fieldLabel: { ...walletTypography.caption, color: colors.textSecondary }, field: { minHeight: 52, borderWidth: 1, borderColor: colors.border, borderRadius: walletRadii.md, color: colors.ink, backgroundColor: colors.surface, paddingHorizontal: walletSpacing.md, ...walletTypography.body }, error: { ...walletTypography.caption, color: colors.danger, lineHeight: 19 }, modalActions: { flexDirection: 'column-reverse', gap: walletSpacing.sm, marginTop: walletSpacing.md }, flex: { flex: 1 }, deleteButton: { backgroundColor: colors.dangerSoft, borderWidth: 1, borderColor: colors.danger },
  sensitiveCard: { flexDirection: 'row', alignItems: 'flex-start', gap: walletSpacing.md, padding: walletSpacing.md, borderRadius: walletRadii.lg, backgroundColor: colors.primarySoft, borderWidth: 1, borderColor: colors.primary }, sensitiveIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, sensitiveCopy: { flex: 1, minWidth: 0 }, sensitiveTitle: { ...walletTypography.bodyMedium, color: colors.ink }, sensitiveHint: { ...walletTypography.caption, color: colors.textSecondary, lineHeight: 18, marginTop: 3 }, dangerCard: { flexDirection: 'row', alignItems: 'flex-start', gap: walletSpacing.md, padding: walletSpacing.md, borderRadius: walletRadii.lg, backgroundColor: colors.dangerSoft, borderWidth: 1, borderColor: colors.danger }, dangerCardIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface }, dangerCardTitle: { ...walletTypography.bodyMedium, color: colors.danger },
  authTabs: { flexDirection: 'row', gap: walletSpacing.sm, marginBottom: walletSpacing.sm }, authTab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: walletSpacing.sm, paddingHorizontal: walletSpacing.sm, paddingVertical: walletSpacing.sm, minHeight: 48, borderRadius: walletRadii.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }, authTabSelected: { backgroundColor: colors.primarySoft, borderColor: colors.primary }, authTabText: { ...walletTypography.bodyMedium, color: colors.textSecondary, flexShrink: 1, textAlign: 'center' }, authTabTextSelected: { color: colors.primary }, authNotice: { flexDirection: 'row', gap: walletSpacing.sm, alignItems: 'center', paddingVertical: walletSpacing.md }, authNoticeText: { ...walletTypography.caption, color: colors.textSecondary, flex: 1 },
});
