import React from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useI18n } from "../i18n.js";
import { AboutScreen } from "./AboutScreen.js";
import { DreamKeyLogo } from "./DreamKeyLogo.js";
import { colors } from "./appStyles.js";
import { useAppUpdates } from "../updates/UpdateProvider.js";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Globe,
  ShieldCheck,
  Share2,
  RefreshCw,
  Wallet,
} from "./icons.js";

type BackHandler = () => void;

function PageHeader({ title, onBack }: { title: string; onBack: BackHandler }) {
  const { t } = useI18n();
  return (
    <View style={styles.pageHeader}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("back")}
        onPress={onBack}
        style={({ pressed }) => [styles.pageBackButton, pressed && styles.settingsRowPressed]}
      >
        <ArrowLeft size={22} color={colors.ink} />
      </Pressable>
      <Text style={styles.pageTitle}>{title}</Text>
      <View style={styles.pageHeaderSpacer} />
    </View>
  );
}

export function SettingsRow({
  title,
  description,
  onPress,
  icon,
  disabled = false,
  last = false,
  trailing,
}: {
  title: string;
  description: string;
  onPress: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
  last?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.settingsRow,
        !last && styles.settingsRowBorder,
        pressed && styles.settingsRowPressed,
        disabled && styles.settingsRowDisabled,
      ]}
    >
      {icon ? <View style={styles.settingsRowIcon}>{icon}</View> : null}
      <View style={styles.settingsRowCopy}>
        <Text style={styles.settingsRowTitle}>{title}</Text>
        <Text style={styles.settingsRowDescription}>{description}</Text>
        {trailing ? <View style={styles.settingsRowValue}>{trailing}</View> : null}
      </View>
      <ChevronRight size={19} color={colors.muted} />
    </Pressable>
  );
}

export function SettingsScreen({
  onBack,
  onLanguage,
  onSecurity,
  onInviteFriends,
  onAbout,
}: {
  onBack: BackHandler;
  onLanguage: () => void;
  onSecurity: () => void;
  onInviteFriends: () => void;
  onAbout: () => void;
}) {
  const { t, language } = useI18n();
  const updates = useAppUpdates();
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.fixedHeader}><PageHeader title={t("settings")} onBack={onBack} /></View>
      <ScrollView contentContainerStyle={styles.pageScroll} showsVerticalScrollIndicator={false}>
        <View style={styles.settingsBrand}>
          <DreamKeyLogo size={54} style={styles.settingsLogo} />
          <View style={styles.settingsBrandCopy}>
            <Text style={styles.settingsBrandTitle}>DreamKey</Text>
            <Text style={styles.settingsBrandSubtitle}>{t("brandSubtitle")}</Text>
          </View>
        </View>
        <Text style={styles.groupLabel}>{language === 'zh' ? '偏好与安全' : 'Preferences & Security'}</Text>
        <View style={styles.settingsGroup}>
          <SettingsRow
            icon={<Globe size={22} color={colors.accentBright} />}
            title={t("languageSettings")}
            description={t("languageDescription")}
            onPress={onLanguage}
            trailing={<Text style={styles.valueBadge}>{language === 'zh' ? '中文' : 'English'}</Text>}
          />
          <SettingsRow
            icon={<ShieldCheck size={22} color={colors.accentBright} />}
            title={t("securitySettings")}
            description={t("securityDescription")}
            onPress={onSecurity}
            last
          />
        </View>
        <Text style={styles.groupLabel}>{language === 'zh' ? '关于应用' : 'App & Sharing'}</Text>
        <View style={styles.settingsGroup}>
          <SettingsRow
            icon={<Share2 size={22} color={colors.accentBright} />}
            title={t("inviteFriends")}
            description={t("inviteFriendsDescription")}
            onPress={onInviteFriends}
          />
          <SettingsRow
            icon={updates.checking ? <ActivityIndicator size="small" color={colors.accentBright} /> : <RefreshCw size={22} color={colors.accentBright} />}
            title={language === 'zh' ? '检查更新' : 'Check for Updates'}
            description={updates.checking ? (language === 'zh' ? '正在检查新版本…' : 'Checking for updates…') : (language === 'zh' ? '查看是否有新版本可用。' : 'Check whether a newer version is available.')}
            onPress={() => { void updates.checkForUpdates(); }}
            disabled={updates.checking}
          />
          <SettingsRow
            icon={<Wallet size={22} color={colors.accentBright} />}
            title={t("aboutUs")}
            description={t("aboutDescription")}
            onPress={onAbout}
            last
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export function LanguageSettingsScreen({ onBack }: { onBack: BackHandler }) {
  const { language, setLanguage, t } = useI18n();
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.fixedHeader}><PageHeader title={t("languageSettings")} onBack={onBack} /></View>
      <ScrollView contentContainerStyle={styles.pageScroll} showsVerticalScrollIndicator={false}>
        <Text style={styles.bodyText}>{t("languageDescription")}</Text>
        <View style={styles.settingsGroup} accessibilityRole="radiogroup">
          {(["zh", "en"] as const).map((value, index) => (
            <Pressable
              key={value}
              accessibilityRole="radio"
              accessibilityState={{ checked: language === value }}
              style={({ pressed }) => [styles.settingsRow, index === 0 && styles.settingsRowBorder, language === value && styles.languageSelected, pressed && styles.settingsRowPressed]}
              onPress={() => setLanguage(value)}
            >
              <View style={styles.settingsRowCopy}>
                <Text style={styles.languageLabel}>{value === "zh" ? "简体中文" : "English"}</Text>
                <Text style={styles.languageNative}>{value === "zh" ? "Simplified Chinese" : "英语"}</Text>
              </View>
              <View style={[styles.radio, language === value && styles.radioSelected]}>{language === value ? <Check size={15} color={colors.ink} /> : null}</View>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export function AboutRouteScreen({ onBack }: { onBack: BackHandler }) {
  return <AboutScreen onBack={onBack} />;
}

export function LoadingScreen() {
  return (
    <SafeAreaView style={[styles.safe, styles.center]}>
      <ActivityIndicator color={colors.accentBright} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  center: { alignItems: "center", justifyContent: "center" },
  fixedHeader: { paddingHorizontal: 20, paddingTop: 8 },
  pageScroll: { padding: 16, paddingTop: 8, paddingBottom: 32, width: '100%', maxWidth: 640, alignSelf: 'center' },
  pageHeader: { flexDirection: "row", alignItems: "center", minHeight: 44, marginBottom: 4 },
  pageBackButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", marginLeft: -8 },
  pageTitle: { color: colors.ink, fontSize: 20, fontWeight: "700", flex: 1, textAlign: "center" },
  pageHeaderSpacer: { width: 36 },
  bodyText: { color: colors.muted, fontSize: 14, lineHeight: 21, marginBottom: 16 },
  settingsBrand: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 18, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, marginBottom: 18 },
  settingsBrandCopy: { flex: 1, minWidth: 0 },
  settingsLogo: { width: 54, height: 54, borderRadius: 16 },
  settingsBrandTitle: { color: colors.ink, fontSize: 23, fontWeight: "700", marginBottom: 3 },
  settingsBrandSubtitle: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  groupLabel: { color: colors.muted, fontSize: 12, lineHeight: 18, fontWeight: '600', marginBottom: 7, marginLeft: 4 },
  settingsGroup: { backgroundColor: colors.panel, borderRadius: 16, borderWidth: 1, borderColor: colors.line, overflow: "hidden", marginBottom: 12 },
  settingsRow: { minHeight: 64, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", backgroundColor: colors.panel },
  settingsRowBorder: { borderBottomWidth: 1, borderBottomColor: colors.line },
  settingsRowPressed: { opacity: 0.65 },
  settingsRowDisabled: { opacity: 0.6 },
  settingsRowIcon: { width: 36, height: 36, borderRadius: 11, backgroundColor: "#2a2450", alignItems: "center", justifyContent: "center", marginRight: 10 },
  settingsRowCopy: { flex: 1, minWidth: 0, paddingRight: 8 },
  settingsRowTitle: { color: colors.ink, fontSize: 15, lineHeight: 21, fontWeight: "700", marginBottom: 2 },
  settingsRowDescription: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  settingsRowValue: { alignSelf: 'flex-start', maxWidth: '100%', backgroundColor: '#2a2450', borderRadius: 8, marginTop: 6, paddingHorizontal: 8, paddingVertical: 3 },
  valueBadge: { color: colors.accentBright, fontSize: 11, lineHeight: 17, fontWeight: '600', flexShrink: 1 },
  languageLabel: { color: colors.ink, fontSize: 15, lineHeight: 21, fontWeight: "700" },
  languageNative: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 3 },
  languageSelected: { backgroundColor: '#211e3e' },
  radio: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  radioSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
});
