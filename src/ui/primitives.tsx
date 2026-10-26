import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { walletColors, walletRadii, walletSpacing, walletTypography } from './theme.js';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useI18n } from '../i18n.js';
import { Activity, ArrowDownLeft, ArrowLeft, ArrowLeftRight, ArrowUpRight, AssetMark, Check, ChevronRight, CircleAlert, Clock3, Coins, Compass, Settings, Signature, UserRound, Wallet, type IconProps } from './icons.js';

function badgeIcon(label: string): React.ComponentType<IconProps> {
  if (label === '↑') return ArrowUpRight;
  if (label === '↓') return ArrowDownLeft;
  if (label === '⇄') return ArrowLeftRight;
  if (label === '⌁') return Signature;
  if (label === '◎') return Compass;
  if (label === '✓') return Check;
  if (label === '!') return CircleAlert;
  if (label === '…') return Clock3;
  if (label.startsWith('0x')) return UserRound;
  return Coins;
}

export function IconBadge({ label, icon, color = walletColors.primary, size = 40 }: { label: string; icon?: React.ReactNode; color?: string; size?: number }) {
  const Icon = badgeIcon(label);
  return (
    <View style={[styles.iconBadge, { width: size, height: size, borderRadius: size / 2, backgroundColor: color }]}>
      {icon ?? <Icon size={size * 0.58} color={walletColors.white} />}
    </View>
  );
}

export function Screen({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <SafeAreaView style={[styles.screen, style]}>{children}</SafeAreaView>;
}

export function PageHeader({ title, subtitle, onBack, right }: { title: string; subtitle?: string; onBack?: () => void; right?: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <View style={styles.pageHeader}>
      <View style={styles.headerLeading}>
        {onBack ? <Pressable accessibilityRole="button" accessibilityLabel={t('back')} onPress={onBack} style={({ pressed }) => [styles.headerBack, pressed && styles.rowPressed]}><ArrowLeft size={22} color={walletColors.ink} /></Pressable> : null}
        <View style={styles.headerCopy}>
          <Text style={styles.pageTitle}>{title}</Text>
          {subtitle ? <Text style={styles.pageSubtitle}>{subtitle}</Text> : null}
        </View>
      </View>
      {right}
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function PrimaryButton({ title, onPress, disabled, loading, style }: { title: string; onPress?: (event: GestureResponderEvent) => void; disabled?: boolean; loading?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ busy: Boolean(loading), disabled: Boolean(disabled || loading) }} disabled={disabled || loading} onPress={onPress} style={({ pressed }) => [styles.button, style, (pressed || disabled) && styles.buttonPressed, disabled && styles.buttonDisabled]}>
      <View style={styles.buttonContent}>
        {loading ? <ActivityIndicator color={walletColors.white} size="small" /> : null}
        <Text style={styles.buttonText}>{title}</Text>
      </View>
    </Pressable>
  );
}

export function SecondaryButton({ title, onPress, disabled, style }: { title: string; onPress?: (event: GestureResponderEvent) => void; disabled?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.secondaryButton, style, pressed && styles.secondaryPressed, disabled && styles.buttonDisabled]}>
      <Text style={styles.secondaryText}>{title}</Text>
    </Pressable>
  );
}

export function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress?: () => void }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: Boolean(selected) }} onPress={onPress} style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.rowPressed]}><Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text></Pressable>;
}

export function Field({ label, value, placeholder, onChangeText, secureTextEntry, keyboardType = 'default', multiline }: { label?: string; value: string; placeholder?: string; onChangeText: (value: string) => void; secureTextEntry?: boolean; keyboardType?: 'default' | 'numeric' | 'email-address' | 'url'; multiline?: boolean }) {
  const Input = require('react-native').TextInput as typeof import('react-native').TextInput;
  return (
    <View style={styles.fieldWrap}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      <Input accessibilityLabel={label} value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={walletColors.textTertiary} secureTextEntry={secureTextEntry} keyboardType={keyboardType} multiline={multiline} style={[styles.field, multiline && styles.fieldMultiline]} autoCapitalize="none" autoCorrect={false} spellCheck={false} />
    </View>
  );
}

export function RowButton({ title, description, icon, onPress, destructive }: { title: string; description?: string; icon?: string; onPress?: () => void; destructive?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.rowButton, pressed && styles.rowPressed]}>
      {icon ? <IconBadge label={icon} color={destructive ? walletColors.danger : walletColors.primary} size={34} /> : null}
      <View style={styles.rowCopy}><Text style={[styles.rowTitle, destructive && { color: walletColors.danger }]}>{title}</Text>{description ? <Text style={styles.rowDescription}>{description}</Text> : null}</View>
      <ChevronRight size={20} color={walletColors.textTertiary} />
    </Pressable>
  );
}

export function AssetRow({ symbol, name, amount, fiat, iconColor, onPress, chainId, address, native }: { symbol: string; name?: string; amount: string; fiat?: string; iconColor?: string; onPress?: () => void; chainId?: number; address?: string; native?: boolean }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.assetRow, pressed && styles.rowPressed]}>
      <View style={[styles.iconBadge, { width: 42, height: 42, borderRadius: 21, backgroundColor: walletColors.surfaceMuted }]}><AssetMark chainId={chainId} address={address} native={native} size={38} /></View>
      <View style={styles.assetCopy}><Text style={styles.assetSymbol}>{symbol}</Text>{name ? <Text style={styles.assetName}>{name}</Text> : null}</View>
      <View style={styles.assetAmount}><Text style={styles.assetValue}>{amount}</Text>{fiat ? <Text style={styles.assetFiat}>{fiat}</Text> : null}</View>
    </Pressable>
  );
}

export function BottomNav({ active, onChange }: { active: 'wallet' | 'activity' | 'browser' | 'settings'; onChange: (tab: 'wallet' | 'activity' | 'browser' | 'settings') => void }) {
  const items: Array<{ key: 'wallet' | 'activity' | 'browser' | 'settings'; label: string; icon: React.ComponentType<IconProps> }> = [
    { key: 'wallet', label: 'Wallet', icon: Wallet }, { key: 'activity', label: 'Activity', icon: Activity }, { key: 'browser', label: 'DApp', icon: Compass }, { key: 'settings', label: 'Settings', icon: Settings },
  ];
  return <View style={styles.bottomNav}>{items.map((item) => <Pressable key={item.key} accessibilityRole="tab" accessibilityState={{ selected: active === item.key }} onPress={() => onChange(item.key)} style={styles.navItem}><item.icon size={23} color={active === item.key ? walletColors.primary : walletColors.textSecondary} /><Text style={[styles.navLabel, active === item.key && styles.navActive]}>{item.label}</Text></Pressable>)}</View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: walletColors.background, paddingHorizontal: walletSpacing.lg },
  pageHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: walletSpacing.lg, paddingBottom: walletSpacing.md },
  headerLeading: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: walletSpacing.sm },
  headerCopy: { flex: 1, minWidth: 0 },
  headerBack: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginLeft: -walletSpacing.xs },
  headerBackText: { fontSize: 34, lineHeight: 34, color: walletColors.ink, fontWeight: '300' },
  pageTitle: { ...walletTypography.heading, color: walletColors.ink },
  pageSubtitle: { ...walletTypography.caption, color: walletColors.textSecondary, marginTop: 2 },
  card: { backgroundColor: walletColors.surface, borderRadius: walletRadii.lg, padding: walletSpacing.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: walletColors.border },
  iconBadge: { alignItems: 'center', justifyContent: 'center' },
  iconBadgeText: { color: walletColors.white, fontWeight: '700', fontSize: 16 },
  button: { minHeight: 52, borderRadius: walletRadii.md, backgroundColor: walletColors.primary, alignItems: 'center', justifyContent: 'center', paddingHorizontal: walletSpacing.lg, paddingVertical: walletSpacing.md },
  buttonPressed: { backgroundColor: walletColors.primaryPressed, opacity: 0.92 },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { ...walletTypography.bodyMedium, color: walletColors.white, textAlign: 'center', flexShrink: 1 },
  buttonContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: walletSpacing.sm },
  secondaryButton: { minHeight: 48, borderRadius: walletRadii.md, borderWidth: 1, borderColor: walletColors.border, backgroundColor: walletColors.surface, alignItems: 'center', justifyContent: 'center', paddingHorizontal: walletSpacing.lg, paddingVertical: walletSpacing.md },
  secondaryPressed: { backgroundColor: walletColors.surfaceMuted },
  secondaryText: { ...walletTypography.bodyMedium, color: walletColors.ink, textAlign: 'center', flexShrink: 1 },
  chip: { minHeight: 44, justifyContent: 'center', paddingHorizontal: walletSpacing.md, paddingVertical: walletSpacing.sm, borderRadius: walletRadii.pill, backgroundColor: walletColors.surfaceMuted },
  chipSelected: { backgroundColor: walletColors.primarySoft },
  chipText: { ...walletTypography.caption, color: walletColors.textSecondary },
  chipTextSelected: { color: walletColors.ink, fontWeight: '700' },
  fieldWrap: { marginBottom: walletSpacing.md },
  fieldLabel: { ...walletTypography.caption, color: walletColors.textSecondary, marginBottom: walletSpacing.xs },
  field: { minHeight: 50, borderWidth: 1, borderColor: walletColors.border, borderRadius: walletRadii.md, backgroundColor: walletColors.surface, paddingHorizontal: walletSpacing.md, color: walletColors.ink, ...walletTypography.body },
  fieldMultiline: { minHeight: 100, paddingTop: walletSpacing.md, textAlignVertical: 'top' },
  rowButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: walletSpacing.md, gap: walletSpacing.md },
  rowPressed: { opacity: 0.72 },
  rowCopy: { flex: 1, minWidth: 0 },
  rowTitle: { ...walletTypography.bodyMedium, color: walletColors.ink },
  rowDescription: { ...walletTypography.caption, color: walletColors.textSecondary, marginTop: 2 },
  chevron: { fontSize: 28, color: walletColors.textTertiary, marginLeft: walletSpacing.sm },
  assetRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: walletSpacing.md, gap: walletSpacing.md },
  assetCopy: { flex: 1, minWidth: 0 },
  assetSymbol: { ...walletTypography.bodyMedium, color: walletColors.ink },
  assetName: { ...walletTypography.caption, color: walletColors.textSecondary, marginTop: 2 },
  assetAmount: { alignItems: 'flex-end', maxWidth: '48%', flexShrink: 1 },
  assetValue: { ...walletTypography.bodyMedium, color: walletColors.ink, textAlign: 'right' },
  assetFiat: { ...walletTypography.caption, color: walletColors.textSecondary, marginTop: 2 },
  bottomNav: { flexDirection: 'row', backgroundColor: walletColors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: walletColors.border, paddingBottom: 8, paddingTop: 8 },
  navItem: { flex: 1, alignItems: 'center', gap: 2 },
  navIcon: { fontSize: 21, color: walletColors.textTertiary },
  navLabel: { ...walletTypography.caption, color: walletColors.textTertiary },
  navActive: { color: walletColors.primary },
});

export const primitiveStyles = styles;
