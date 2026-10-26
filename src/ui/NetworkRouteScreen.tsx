import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useI18n } from "../i18n.js";
import { useWalletContext } from "../context/WalletContext.js";
import type { ScreenProps } from "../navigation/types.js";
import { Check, NetworkMark } from "./icons.js";
import { colors, styles as appStyles } from "./appStyles.js";
import { LoadingScreen } from "./AppSimpleScreens.js";
import { PageHeader } from "./primitives.js";

export function NetworkRouteScreen({ navigation }: ScreenProps<"Networks">) {
  const { core, selectedNetworkId, setSelectedNetworkId } = useWalletContext();
  const { t } = useI18n();
  if (!core) return <LoadingScreen />;
  return <SafeAreaView style={appStyles.safe}><View style={styles.header}><PageHeader title={t("networks")} onBack={() => navigation.goBack()} /></View><ScrollView contentContainerStyle={styles.content}><Text style={styles.description}>{t("rpcDescription")}</Text><View style={styles.networks}>{core.listNetworks().map((network) => { const selected = selectedNetworkId === network.id; return <Pressable key={network.id} accessibilityRole="radio" accessibilityState={{ checked: selected }} accessibilityLabel={network.name} style={({ pressed }) => [styles.networkRow, selected && styles.networkRowSelected, pressed && styles.pressed]} onPress={() => { setSelectedNetworkId(network.id); navigation.goBack(); }}><View style={styles.networkAvatar}><NetworkMark chainId={network.chainId} size={32} /></View><View style={styles.listMain}><Text style={styles.listTitle}>{network.name}</Text><Text style={styles.listSub}>{t("chain", { chainId: network.chainId, symbol: network.nativeSymbol ?? "Native" })}</Text></View><View style={[styles.selection, selected && styles.selectionActive]}>{selected ? <Check size={17} color={colors.accentBright} /> : null}</View></Pressable>; })}</View></ScrollView></SafeAreaView>;
}
const styles = StyleSheet.create({ header: { paddingHorizontal: 20 }, content: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 32 }, description: { color: colors.muted, fontSize: 14, lineHeight: 22, marginBottom: 22 }, networks: { gap: 10 }, networkRow: { flexDirection: "row", alignItems: "center", gap: 13, padding: 16, minHeight: 82, borderRadius: 18, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.panel }, networkRowSelected: { borderColor: colors.accent, backgroundColor: "#24203f" }, networkAvatar: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: colors.background }, listMain: { flex: 1, minWidth: 0 }, listTitle: { color: colors.ink, fontSize: 16, lineHeight: 22, fontWeight: "600" }, listSub: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 4 }, selection: { width: 25, height: 25, borderRadius: 13, borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center" }, selectionActive: { borderColor: colors.accent, backgroundColor: "#2a2450" }, pressed: { opacity: 0.72 } });
