import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useI18n } from '../i18n.js';
import type { DappNavigationState } from '../dapp/types.js';
import { ArrowLeft, ArrowRight, RefreshCw, X } from './icons.js';
import { walletColors as colors } from './theme.js';

interface Props {
  navigation: DappNavigationState;
  onGoBack: () => void;
  onGoForward: () => void;
  onReload: () => void;
}

/** Closing belongs beside the address, separate from the browser's history. */
export function DappBrowserCloseButton({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return <Pressable accessibilityRole="button" accessibilityLabel={t('browserClose')} onPress={onClose} style={({ pressed }) => [styles.closeButton, pressed ? styles.pressed : null]}><X size={21} color={colors.ink} /></Pressable>;
}

/** Browser history actions sit beneath the page, within the screen's safe area. */
export function DappBrowserToolbar({ navigation, onGoBack, onGoForward, onReload }: Props) {
  const { t } = useI18n();
  return (
    <View style={styles.toolbar}>
      <View style={styles.historyActions}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('browserBack')} accessibilityState={{ disabled: !navigation.canGoBack }} disabled={!navigation.canGoBack} onPress={onGoBack} style={({ pressed }) => [styles.iconButton, !navigation.canGoBack ? styles.disabled : null, pressed ? styles.pressed : null]}>
          <ArrowLeft size={22} color={colors.ink} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={t('browserForward')} accessibilityState={{ disabled: !navigation.canGoForward }} disabled={!navigation.canGoForward} onPress={onGoForward} style={({ pressed }) => [styles.iconButton, !navigation.canGoForward ? styles.disabled : null, pressed ? styles.pressed : null]}>
          <ArrowRight size={22} color={colors.ink} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={navigation.loading ? t('loading') : t('browserReload')} accessibilityState={{ disabled: navigation.loading, busy: navigation.loading }} disabled={navigation.loading} onPress={onReload} style={({ pressed }) => [styles.iconButton, pressed ? styles.pressed : null]}>
          {navigation.loading ? <ActivityIndicator size="small" color={colors.primary} accessibilityLabel={t('loading')} /> : <RefreshCw size={22} color={colors.ink} />}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: { minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  historyActions: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' },
  iconButton: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  closeButton: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.3 },
  pressed: { backgroundColor: colors.surfaceMuted },
});
