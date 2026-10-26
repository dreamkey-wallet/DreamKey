import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import type { DappLoadError } from './types.js';

export function websiteHost(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

const copy = {
  zh: {
    title: '网页暂时打不开',
    unavailable: '暂时无法连接到这个网站，请稍后再试。',
    closed: '与网站的连接中断了，可以稍后重新加载。',
    dns: '暂时找不到这个网站，请检查网址是否拼写正确。',
    timeout: '网站响应时间较长，请检查网络后再试一次。',
    certificate: '无法建立安全连接，请确认网址或稍后再试。',
    missing: '这个页面可能已移动或删除，请检查网址。',
    denied: '网站暂时拒绝访问，可以稍后再试或打开其他网站。',
    server: '网站服务暂时不可用，请稍后再试。',
    invalid: '请使用正确的 HTTPS 网站地址。',
    hint: '你也可以修改顶部网址，或返回收藏和最近访问。',
    retry: '重新加载', edit: '修改网址', back: '返回 DApp',
  },
  en: {
    title: 'Page Unavailable',
    unavailable: 'We could not reach this website. Please try again later.',
    closed: 'The connection to this website was interrupted. Try reloading it.',
    dns: 'We could not find this website. Check the spelling of its address.',
    timeout: 'This website is taking too long to respond. Check your connection and try again.',
    certificate: 'A secure connection could not be established. Check the address or try again later.',
    missing: 'This page may have moved or been removed. Check its address.',
    denied: 'This website has refused access. Try again later or visit another website.',
    server: 'This website is temporarily unavailable. Please try again later.',
    invalid: 'Please enter a valid HTTPS website address.',
    hint: 'You can edit the address above or return to your favorites and recent visits.',
    retry: 'Reload Page', edit: 'Edit Address', back: 'Back to DApp',
  },
} as const;

interface Props {
  error?: DappLoadError;
  url: string;
  language: 'zh' | 'en';
  invalid?: boolean;
  onRetry?: () => void;
  onEditUrl?: () => void;
  onBack?: () => void;
}

export function DappErrorPage({ error, url, language, invalid, onRetry, onEditUrl, onBack }: Props) {
  const text = copy[language];
  const description = error?.message ?? '';
  const host = websiteHost(url);
  const message = invalid ? text.invalid
    : error?.kind === 'http' ? error.code === 404 || error.code === 410 ? text.missing
      : error.code === 401 || error.code === 403 ? text.denied : text.server
    : /CERT|SSL/i.test(description) || [-11, -1200, -1201, -1202, -1203, -1204].includes(error?.code ?? 0) ? text.certificate
    : /NAME_NOT_RESOLVED|CANNOT_FIND_HOST/i.test(description) || [-2, -1003].includes(error?.code ?? 0) ? text.dns
    : /TIMED_OUT|TIMEOUT/i.test(description) || [-8, -1001].includes(error?.code ?? 0) ? text.timeout
    : /CONNECTION_CLOSED|CONNECTION_RESET|NETWORK_CONNECTION_LOST/i.test(description) || error?.code === -1005 ? text.closed
    : text.unavailable;

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <View style={styles.illustration} accessibilityElementsHidden importantForAccessibility="no">
        <View style={styles.halo} />
        <Svg width={156} height={136} viewBox="0 0 156 136">
          <Rect x="16" y="18" width="124" height="94" rx="18" fill="#19243e" stroke="#39476a" strokeWidth="1.5" />
          <Line x1="17" y1="43" x2="139" y2="43" stroke="#39476a" strokeWidth="1.5" />
          <Circle cx="31" cy="31" r="2.5" fill="#b6a7ff" />
          <Circle cx="41" cy="31" r="2.5" fill="#7786a6" />
          <Circle cx="51" cy="31" r="2.5" fill="#7786a6" />
          <Circle cx="77" cy="76" r="23" fill="#252b53" stroke="#b6a7ff" strokeWidth="2" />
          <Path d="M77 53c-12 12-12 34 0 46m0-46c12 12 12 34 0 46M54 76h46m-42-12h38m-38 24h38" fill="none" stroke="#b6a7ff" strokeWidth="1.6" />
          <Circle cx="117" cy="106" r="18" fill="#30223b" stroke="#644054" strokeWidth="1.5" />
          <Path d="m111 100 12 12m0-12-12 12" stroke="#eaa3b8" strokeWidth="2.5" strokeLinecap="round" />
        </Svg>
      </View>
      <View accessibilityRole="alert" style={styles.message}>
        <Text style={styles.title}>{text.title}</Text>
        {host ? <View style={styles.hostPill}><Text selectable style={styles.host} numberOfLines={2}>{host}</Text></View> : null}
        <Text style={styles.description}>{message}</Text>
        <Text style={styles.hint}>{text.hint}</Text>
      </View>
      <View style={styles.actions}>
        {onRetry ? <Pressable accessibilityRole="button" onPress={onRetry} style={({ pressed }) => [styles.button, styles.primary, pressed ? styles.pressed : null]}><Text style={styles.primaryText}>{text.retry}</Text></Pressable> : null}
        {onEditUrl ? <Pressable accessibilityRole="button" onPress={onEditUrl} style={({ pressed }) => [styles.button, styles.secondary, pressed ? styles.pressed : null]}><Text style={styles.secondaryText}>{text.edit}</Text></Pressable> : null}
        {onBack ? <Pressable accessibilityRole="button" onPress={onBack} style={({ pressed }) => [styles.backButton, pressed ? styles.pressed : null]}><Text style={styles.backText}>{text.back}</Text></Pressable> : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#0c1224' },
  content: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 32 },
  illustration: { width: 160, height: 144, alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  halo: { position: 'absolute', width: 140, height: 140, borderRadius: 70, backgroundColor: '#151b36' },
  message: { alignItems: 'center', maxWidth: 340 },
  title: { color: '#f7f9ff', fontSize: 23, lineHeight: 32, fontWeight: '700', textAlign: 'center', marginBottom: 12 },
  hostPill: { borderRadius: 10, backgroundColor: '#1b2441', paddingHorizontal: 13, paddingVertical: 7, marginBottom: 18, maxWidth: '100%' },
  host: { color: '#b6a7ff', fontSize: 13, lineHeight: 19, fontWeight: '600', textAlign: 'center' },
  description: { color: '#cbd2e3', fontSize: 14, lineHeight: 23, textAlign: 'center' },
  hint: { color: '#8290ae', fontSize: 12, lineHeight: 21, textAlign: 'center', marginTop: 10 },
  actions: { width: '100%', maxWidth: 320, marginTop: 28, gap: 11 },
  button: { minHeight: 50, borderRadius: 15, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  primary: { backgroundColor: '#7b61ff' },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  secondary: { backgroundColor: '#19233d', borderWidth: 1, borderColor: '#303d5c' },
  secondaryText: { color: '#d2d9ec', fontSize: 14, fontWeight: '600' },
  backButton: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  backText: { color: '#a899ef', fontSize: 13, fontWeight: '600' },
  pressed: { opacity: 0.75 },
});
