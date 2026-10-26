import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Clipboard from '@react-native-clipboard/clipboard';
import QRCode from 'react-native-qrcode-svg';
import { ArrowLeft, Check, ChevronDown, Copy, NetworkMark, Share2, ShieldCheck, TokenIcon, UserRound } from './icons.js';
import type { AccountInfo, NetworkConfig } from '../core/types.js';
import type { StoredToken } from '../native/token-storage.js';
import { useI18n } from '../i18n.js';

interface ReceiveScreenProps {
  account: AccountInfo;
  network: NetworkConfig;
  onBack: () => void;
  token?: StoredToken;
  onChangeAccount?: () => void;
  onChangeNetwork?: () => void;
  walletName?: string;
}

const c = { background: '#0c1224', surface: '#19233d', border: '#2d3a5b', ink: '#f7f9ff', muted: '#a8b1c7', primary: '#7b61ff', soft: '#a895ff', green: '#49d89a' };

export function ReceiveScreen({ account, network, token, onBack, onChangeAccount, onChangeNetwork, walletName }: ReceiveScreenProps) {
  const { language, t } = useI18n();
  const zh = language === 'zh';
  const { width, height } = useWindowDimensions();
  const qrSize = Math.max(120, Math.min(200, width - 112, height * 0.25));
  const [copied, setCopied] = useState(false);
  const [shareError, setShareError] = useState(false);
  const [sharing, setSharing] = useState(false);
  const sharePending = useRef(false);
  useEffect(() => {
    setCopied(false);
    setShareError(false);
  }, [account.address, network.id]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2200);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = () => {
    Clipboard.setString(account.address);
    setCopied(true);
  };
  const share = async () => {
    if (sharePending.current) return;
    sharePending.current = true;
    setSharing(true);
    setShareError(false);
    try {
      await Share.share({ message: `${walletName ?? t('accountNumber', { number: account.index + 1 })} · ${network.name}\n${account.address}`, title: t('receive') });
    } catch { setShareError(true); }
    finally { sharePending.current = false; setSharing(false); }
  };

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('back')} onPress={onBack} style={({ pressed }) => [s.iconButton, pressed && s.pressed]}><ArrowLeft size={22} color={c.ink} /></Pressable>
        <Text style={s.title}>{t('receive')}{token ? ` ${token.symbol}` : ''}</Text>
        <View style={s.headerSpace} />
      </View>
      <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <Text style={s.intro}>{token ? (zh ? `扫码或分享地址，接收 ${token.symbol}` : `Scan the QR code or share your address to receive ${token.symbol}.`) : (zh ? '扫码或分享地址，接收你的资产' : 'Scan the QR code or share your address to receive assets.')}</Text>
        {token ? <View style={s.token}><TokenIcon chainId={network.chainId} address={token.address} size={30} /><View style={s.tokenCopy}><Text style={s.accountName}>{token.name}</Text><Text style={s.noticeText}>{token.symbol} · {network.name}</Text></View></View> : null}
        <View style={s.card}>
          <Pressable accessibilityRole={onChangeAccount ? 'button' : undefined} disabled={!onChangeAccount} onPress={onChangeAccount} style={({ pressed }) => [s.account, pressed && s.pressed]}>
            <View style={s.avatar}><UserRound size={22} color={c.soft} /></View>
            <Text numberOfLines={2} style={s.walletName}>{walletName ?? t('accountNumber', { number: account.index + 1 })}</Text>
            {onChangeAccount ? <ChevronDown size={17} color={c.muted} /> : null}
          </Pressable>
          <View style={s.qrPaper}>
            <QRCode value={account.address} size={qrSize} backgroundColor="#ffffff" color="#10162b" ecl="M" />
          </View>
          <Pressable accessibilityRole={onChangeNetwork ? 'button' : undefined} disabled={!onChangeNetwork} accessibilityLabel={t('networks')} onPress={onChangeNetwork} style={({ pressed }) => [s.network, pressed && s.pressed]}>
            <NetworkMark chainId={network.chainId} size={17} />
            <Text style={s.networkText}>{network.name}</Text>
            {onChangeNetwork ? <ChevronDown size={14} color={c.muted} /> : null}
          </Pressable>
          <View style={s.addressBox}>
            <Text style={s.addressLabel}>{zh ? '钱包地址' : 'Wallet Address'}</Text>
            <Text selectable style={s.address}>{account.address}</Text>
          </View>
        </View>
        <View style={s.notice}>
          <ShieldCheck size={21} color={c.soft} />
          <Text style={s.noticeText}>{token ? (zh ? `请使用 ${network.name} 网络发送 ${token.symbol}。上方二维码是你的钱包地址。` : `Send ${token.symbol} on ${network.name}. The QR code contains your wallet address.`) : (zh ? `请确认发送方使用 ${network.name} 网络。此地址可接收 ${network.nativeSymbol ?? 'ETH'} 和该网络的 ERC-20 代币。` : `Use the ${network.name} network to send ${network.nativeSymbol ?? 'ETH'} or ERC-20 tokens to this address.`)}{zh ? '不同网络的资产不会自动跨链转移。' : ' Assets do not move between networks automatically.'}</Text>
        </View>
        {shareError ? <Text accessibilityRole="alert" style={s.error}>{zh ? '无法打开分享，请复制地址重试。' : 'Unable to share. Please copy the address instead.'}</Text> : null}
      </ScrollView>
      <View style={s.actions}>
        <Pressable accessibilityRole="button" onPress={copy} style={({ pressed }) => [s.copyButton, pressed && s.pressed]}>
          {copied ? <Check size={19} color="#fff" /> : <Copy size={19} color="#fff" />}
          <Text accessibilityLiveRegion="polite" style={s.copyText}>{copied ? (zh ? '地址已复制' : 'Address Copied') : (zh ? '复制地址' : 'Copy Address')}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: sharing, busy: sharing }} disabled={sharing} onPress={() => { void share(); }} style={({ pressed }) => [s.shareButton, (pressed || sharing) && s.pressed]}>
          {sharing ? <ActivityIndicator size="small" color={c.ink} /> : <Share2 size={19} color={c.ink} />}<Text style={s.shareText}>{zh ? '分享' : 'Share'}</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 4 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, minWidth: 0, paddingHorizontal: 8, color: c.ink, fontSize: 19, fontWeight: '700', textAlign: 'center' },
  headerSpace: { width: 44 },
  content: { width: '100%', maxWidth: 520, alignSelf: 'center', padding: 16, paddingTop: 2, paddingBottom: 18 },
  intro: { color: c.muted, fontSize: 13, textAlign: 'center', marginBottom: 8, lineHeight: 19 },
  token: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8, paddingHorizontal: 2 }, tokenCopy: { flex: 1, gap: 3 },
  card: { backgroundColor: c.surface, borderRadius: 20, padding: 12, borderWidth: 1, borderColor: c.border, alignItems: 'center' },
  account: { maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8, minHeight: 44 },
  avatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: '#344761', justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: c.ink, fontSize: 13, fontWeight: '700' },
  accountName: { color: c.ink, fontSize: 16, fontWeight: '600' },
  walletName: { flexShrink: 1, color: c.ink, fontSize: 16, lineHeight: 23, fontWeight: '600' },
  qrPaper: { padding: 10, backgroundColor: '#fff', borderRadius: 14 },
  network: { maxWidth: '100%', minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 8, paddingHorizontal: 12, marginTop: 8, borderRadius: 18, backgroundColor: c.background },
  networkDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#8392e8' },
  bscDot: { backgroundColor: '#f5ce62' },
  networkText: { flexShrink: 1, color: c.ink, fontSize: 12, lineHeight: 18, fontWeight: '600' },
  addressBox: { alignSelf: 'stretch', marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderColor: c.border },
  addressLabel: { color: c.muted, fontSize: 12, textAlign: 'center', marginBottom: 4 },
  address: { color: c.ink, fontSize: 13, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', lineHeight: 22, textAlign: 'center' },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 11, paddingHorizontal: 2 },
  noticeText: { flex: 1, color: c.muted, fontSize: 12, lineHeight: 20 },
  actions: { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 10, gap: 10, borderTopWidth: 1, borderColor: c.border },
  copyButton: { flex: 1, minWidth: 0, minHeight: 52, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 15, backgroundColor: c.primary, flexDirection: 'row', gap: 8, justifyContent: 'center', alignItems: 'center' },
  copyText: { flexShrink: 1, color: '#fff', fontWeight: '700', fontSize: 14, lineHeight: 21, textAlign: 'center' },
  shareButton: { flexShrink: 1, minWidth: 98, maxWidth: '42%', minHeight: 52, borderRadius: 15, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, flexDirection: 'row', gap: 8, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 15, paddingVertical: 12 },
  shareText: { flexShrink: 1, color: c.ink, fontWeight: '600', fontSize: 14, lineHeight: 21, textAlign: 'center' },
  pressed: { opacity: 0.75 },
  error: { color: '#ff7187', fontSize: 13, lineHeight: 20 },
});
