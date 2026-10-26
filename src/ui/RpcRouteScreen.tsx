import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useI18n } from "../i18n.js";
import { useWalletContext } from "../context/WalletContext.js";
import type { ScreenProps } from "../navigation/types.js";
import { Check } from "./icons.js";
import { colors, styles as appStyles } from "./appStyles.js";
import { LoadingScreen } from "./AppSimpleScreens.js";
import { PageHeader } from "./primitives.js";
import { clearPreferredRpcEndpoint, getPreferredRpcEndpoint, getRpcEndpointChoices, getRpcEndpointHealth, probeRpcEndpoint, setPreferredRpcEndpoint, subscribeRpcEndpointHealth, supportsRpcEndpointPreference } from "../core/rpc-endpoints.js";
import { rpcPreferencesStorage } from "../native/rpc-preferences-storage.js";

export function RpcRouteScreen({ navigation }: ScreenProps<"Rpc">) {
  const { core, selectedNetworkId } = useWalletContext();
  const { t, language } = useI18n();
  const [, redraw] = React.useReducer((value) => value + 1, 0);
  const network = core?.getNetwork(selectedNetworkId);
  const choices = network && supportsRpcEndpointPreference(network) ? getRpcEndpointChoices(network.chainId) : [];
  React.useEffect(() => {
    if (!network) return;
    // Read the same measurements as the home indicator. Each completed probe
    // updates its row immediately, without waiting for the slowest endpoint.
    const unsubscribe = choices.map((url) => subscribeRpcEndpointHealth(network.chainId, url, redraw));
    for (const url of choices) void probeRpcEndpoint(network.chainId, url);
    return () => { for (const stop of unsubscribe) stop(); };
  }, [network?.chainId, choices.join("|")]);
  if (!network) return <LoadingScreen />;
  const preferred = getPreferredRpcEndpoint(network.chainId);
  const choose = (url?: string) => { if (url) { if (!setPreferredRpcEndpoint(network.chainId, url)) return; void rpcPreferencesStorage.set(network.chainId, url); } else { clearPreferredRpcEndpoint(network.chainId); void rpcPreferencesStorage.clear(network.chainId); } redraw(); };
  return <SafeAreaView style={appStyles.safe}><View style={styles.header}><PageHeader title={t("rpcEndpoint")} subtitle={network.name} onBack={() => navigation.goBack()} /></View><ScrollView contentContainerStyle={styles.content}><Text style={styles.description}>{t("rpcEndpointDescription")}</Text><Pressable accessibilityRole="radio" accessibilityState={{ checked: !preferred }} style={({ pressed }) => [styles.row, !preferred && styles.selected, pressed && styles.pressed]} onPress={() => choose()}><View style={styles.copy}><Text style={styles.name}>{t("rpcAutomatic")}</Text><Text style={styles.url}>{t("rpcAutomaticDescription")}</Text></View><View style={styles.check}>{!preferred ? <Check size={15} color={colors.accentBright} /> : null}</View></Pressable>{choices.map((url) => { const value = getRpcEndpointHealth(network.chainId, url); const status = value.status === "offline" ? (language === "zh" ? "不可用" : "Unavailable") : (value.status === "ok" || value.status === "slow") && value.latencyMs !== undefined ? `${value.latencyMs} ms` : (language === "zh" ? "检测中" : "Checking"); return <Pressable key={url} accessibilityRole="radio" accessibilityState={{ checked: preferred === url }} style={({ pressed }) => [styles.row, preferred === url && styles.selected, pressed && styles.pressed]} onPress={() => choose(url)}><View style={styles.copy}><Text style={styles.name}>{new URL(url).hostname}</Text><Text style={styles.url}>{url} · {status}</Text></View><View style={styles.dotWrap}><View style={[styles.dot, { backgroundColor: value.status === "offline" ? colors.red : value.status === "slow" ? "#e5be6c" : value.status === "ok" ? colors.green : colors.muted }]} /><View style={styles.check}>{preferred === url ? <Check size={15} color={colors.accentBright} /> : null}</View></View></Pressable>; })}</ScrollView></SafeAreaView>;
}
const styles = StyleSheet.create({ header: { paddingHorizontal: 20 }, content: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 32, gap: 8 }, description: { color: colors.muted, fontSize: 14, lineHeight: 22, marginBottom: 8 }, row: { minHeight: 64, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 14, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.panel }, selected: { borderColor: colors.accent, backgroundColor: "#24203f" }, copy: { flex: 1, minWidth: 0 }, name: { color: colors.ink, fontSize: 14, lineHeight: 20, fontWeight: "600" }, url: { color: colors.muted, fontSize: 11, lineHeight: 17, marginTop: 2 }, check: { width: 23, height: 23, borderRadius: 12, borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center" }, dotWrap: { flexDirection: "row", alignItems: "center", gap: 8 }, dot: { width: 9, height: 9, borderRadius: 5 }, pressed: { opacity: 0.72 } });
