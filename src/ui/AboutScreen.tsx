import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, Compass, KeyRound, ShieldCheck, Wallet } from './icons.js';
import { useI18n } from '../i18n.js';
import { getAppVersionName } from '../native/app-info.js';
import { appUpdates } from '../native/app-updates.js';
import { walletColors as c } from './theme.js';
import { DreamKeyLogo } from './DreamKeyLogo.js';

export function AboutScreen({ title, onBack }: { title?: string; onBack: () => void }) {
  const { t, language } = useI18n();
  const [bundleVersion, setBundleVersion] = useState<number | null>(null);
  const heading = title ?? t('aboutUs');
  useEffect(() => {
    let mounted = true;
    void appUpdates.getState().then((state) => {
      if (mounted) setBundleVersion(state.bundleVersion);
    }).catch(() => {
      if (mounted) setBundleVersion(null);
    });
    return () => { mounted = false; };
  }, []);
  const zh = language === 'zh';
  const features = [
    { icon: Wallet, title: zh ? '资产一处管理' : 'Your Assets in One Place', description: zh ? '管理多链资产，轻松收发代币。' : 'Manage multichain assets and send or receive tokens.' },
    { icon: KeyRound, title: zh ? '密钥由你保管' : 'Your Keys Stay with You', description: zh ? '密钥保存在设备上，签名和交易由你确认。' : 'Keys stay on your device. You approve signatures and transactions.' },
    { icon: Compass, title: zh ? '连接链上应用' : 'Connect to DApps', description: zh ? '通过内置浏览器探索 Web3。' : 'Explore Web3 with the built-in DApp browser.' },
  ];
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('back')} onPress={onBack} style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
          <ArrowLeft size={22} color={c.ink} />
        </Pressable>
        <Text style={styles.title}>{heading}</Text>
        <View style={styles.spacer} />
      </View>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <View style={styles.logoFrame}><DreamKeyLogo size={72} style={styles.logo} /></View>
          <Text style={styles.brand}>DreamKey</Text>
          <Text style={styles.tagline}>{zh ? '由你掌控的多链钱包' : 'Your Multichain Wallet'}</Text>
          <View style={styles.versionBadge}><Text selectable style={styles.version}>Version {getAppVersionName()} · Bundle {bundleVersion ?? '—'}</Text></View>
        </View>
        <View style={styles.card}>
          {features.map(({ icon: Icon, title: featureTitle, description }, index) => (
            <View key={featureTitle} style={[styles.feature, index > 0 && styles.featureBorder]}>
              <View style={styles.featureIcon}><Icon size={22} color="#b6a7ff" /></View>
              <View style={styles.featureCopy}>
                <Text style={styles.featureTitle}>{featureTitle}</Text>
                <Text style={styles.body}>{description}</Text>
              </View>
            </View>
          ))}
        </View>
        <View style={styles.backupNote}>
          <ShieldCheck size={19} color={c.warning} />
          <View style={styles.featureCopy}>
            <Text style={styles.backupTitle}>{zh ? '记得做好离线备份' : 'Keep an Offline Backup'}</Text>
            <Text style={styles.caption}>{zh ? '请妥善备份助记词或私钥。遗失后，DreamKey 无法代你恢复钱包。' : 'Keep your recovery phrase or private key safe. DreamKey cannot recover your wallet if you lose it.'}</Text>
          </View>
        </View>
        <Text style={styles.footer}>DreamKey Wallet · {zh ? '你的密钥，你的资产。' : 'Your keys. Your assets.'}</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: c.background },
  content: { padding: 16, paddingTop: 0, paddingBottom: 28, width: '100%', maxWidth: 640, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 5 },
  back: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  pressed: { backgroundColor: c.surfaceMuted },
  title: { color: c.ink, fontSize: 20, fontWeight: '700', flex: 1, textAlign: 'center' },
  spacer: { width: 44 },
  hero: { alignItems: 'center', paddingVertical: 16, paddingBottom: 18 },
  logoFrame: { padding: 5, borderRadius: 28, borderWidth: 1, borderColor: '#3f346e', backgroundColor: c.primarySoft, marginBottom: 10 },
  logo: { width: 72, height: 72, borderRadius: 22 },
  brand: { color: c.ink, fontSize: 28, lineHeight: 34, fontWeight: '800', letterSpacing: -0.5 },
  tagline: { color: c.textSecondary, fontSize: 14, lineHeight: 21, marginTop: 6, textAlign: 'center' },
  versionBadge: { marginTop: 10, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 18, backgroundColor: c.surface },
  version: { color: '#b6a7ff', fontSize: 12, lineHeight: 18, textAlign: 'center', fontVariant: ['tabular-nums'] },
  card: { backgroundColor: c.surface, borderRadius: 18, paddingHorizontal: 12, borderWidth: 1, borderColor: c.border },
  feature: { flexDirection: 'row', gap: 10, paddingVertical: 13, alignItems: 'flex-start' },
  featureBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border },
  featureIcon: { width: 36, height: 36, borderRadius: 11, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' },
  featureCopy: { flex: 1, minWidth: 0 },
  featureTitle: { color: c.ink, fontSize: 14, lineHeight: 21, fontWeight: '600', marginBottom: 4 },
  body: { color: c.textSecondary, lineHeight: 20, fontSize: 13 },
  backupNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, padding: 13, marginTop: 12, borderRadius: 14, backgroundColor: c.warningSoft },
  backupTitle: { color: c.warning, fontSize: 13, lineHeight: 20, fontWeight: '600', marginBottom: 5 },
  caption: { color: c.textSecondary, fontSize: 12, lineHeight: 19 },
  footer: { color: c.textTertiary, fontSize: 11, lineHeight: 18, textAlign: 'center', marginTop: 18 },
});
