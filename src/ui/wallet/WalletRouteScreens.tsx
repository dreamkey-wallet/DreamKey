import React from "react";
import { ActivityIndicator, Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import { useI18n } from "../../i18n.js";
import { useWalletContext } from "../../context/WalletContext.js";
import type { ScreenProps } from "../../navigation/types.js";
import type { WalletCore } from "../../core/wallet-core.js";
import type { NetworkConfig } from "../../core/types.js";
import { ArrowDownLeft, ArrowUpRight, ChevronDown, Compass, Eye, LockKeyhole, NetworkMark, RefreshCw, Settings, TokenIcon, Wallet } from "../icons.js";
import { colors, styles } from "../appStyles.js";
import { LoadingScreen } from "../AppSimpleScreens.js";
import { useWalletAssets, displayAssetBalance } from "../useWalletAssets.js";
import { useAssetPrices } from "../useAssetPrices.js";
import { formatUsd } from "../../core/asset-prices.js";
import { AssetsManagerScreen } from "../TransferScreens.js";
import { AssetDetailScreen } from "../AssetDetailScreen.js";
import { getRpcEndpointUrls, getRpcEndpointsHealth, probeRpcEndpoints, subscribeRpcEndpointHealth } from "../../core/rpc-endpoints.js";

function shorten(address: string, left = 6, right = 4): string {
  return `${address.slice(0, left)}…${address.slice(-right)}`;
}

function HomeAction({ icon, label, onPress }: { icon: React.ReactNode; label: string; onPress: () => void }) {
  const { fontScale } = useWindowDimensions();
  const [width, setWidth] = React.useState(0);
  const stacked = fontScale > 1.2 || (width > 0 && width < 128);
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={({ pressed }) => [styles.homeAction, homeStyles.action, stacked && homeStyles.actionStacked, pressed && styles.homePressed]} onPress={onPress}>{icon}<Text style={[styles.homeActionLabel, homeStyles.actionLabel]}>{label}</Text></Pressable>;
}

export function HomeRouteScreen({ navigation }: ScreenProps<"Main">) {
  const { core, selectedNetworkId } = useWalletContext();
  if (!core) return <LoadingScreen />;
  return <WalletHomeContent core={core} network={core.getNetwork(selectedNetworkId)} navigation={navigation} />;
}

function WalletHomeContent({ core, network, navigation }: { core: WalletCore; network: NetworkConfig; navigation: ScreenProps<"Main">["navigation"] }) {
  const { t, language } = useI18n();
  const { revision, selectedAccountIndex, lock, manager } = useWalletContext();
  const focused = useIsFocused();
  const account = core.getAccount(selectedAccountIndex);
  const { assets, loading, error, refresh, contextKey } = useWalletAssets(core, selectedAccountIndex, network);
  const prices = useAssetPrices(network, assets, contextKey, loading || Boolean(error), focused);
  const [refreshingKey, setRefreshingKey] = React.useState<string | null>(null);
  const rpcRouteKey = JSON.stringify(getRpcEndpointUrls(network));
  const rpcUrls = React.useMemo(() => JSON.parse(rpcRouteKey) as string[], [rpcRouteKey]);
  const subscribeRpcHealth = React.useCallback((listener: () => void) => {
    const unsubscribe = rpcUrls.map((url) => subscribeRpcEndpointHealth(network.chainId, url, listener));
    return () => { for (const stop of unsubscribe) stop(); };
  }, [network.chainId, rpcUrls]);
  const readRpcHealth = React.useCallback(() => getRpcEndpointsHealth(network.chainId, rpcUrls), [network.chainId, rpcUrls]);
  const rpcHealth = React.useSyncExternalStore(subscribeRpcHealth, readRpcHealth);
  const manualRefresh = React.useRef(0);
  React.useEffect(() => {
    setRefreshingKey(null);
    return () => { manualRefresh.current += 1; };
  }, [contextKey]);
  const refreshRpcHealth = React.useCallback(() => probeRpcEndpoints(network.chainId, rpcUrls), [network.chainId, rpcUrls]);
  // Reuse the picker's current status immediately and publish subsequent
  // measurements to both surfaces through the shared endpoint health store.
  useFocusEffect(React.useCallback(() => {
    void refreshRpcHealth();
  }, [refreshRpcHealth]));
  const refreshAll = React.useCallback(() => {
    const request = ++manualRefresh.current;
    setRefreshingKey(contextKey);
    void Promise.allSettled([refresh(), prices.refresh(true), refreshRpcHealth()]).then(() => {
      if (request === manualRefresh.current) setRefreshingKey(null);
    });
  }, [refresh, prices.refresh, refreshRpcHealth, contextKey]);
  useFocusEffect(React.useCallback(() => { void refresh(); void prices.refresh(); }, [refresh, prices.refresh, revision]));
  const updating = loading || prices.loading;
  // Keep the current wallet's last complete render visible during background work.
  // Other wallet/network contexts must never inherit its balances or valuation.
  const settled = React.useRef<{ key: string; assets: typeof assets; prices: typeof prices } | null>(null);
  if (focused && !updating) settled.current = { key: contextKey, assets, prices };
  const saved = (updating || !focused) && settled.current?.key === contextKey ? settled.current : null;
  const displayedAssets = saved?.assets ?? assets;
  const displayedPrices = saved?.prices ?? prices;
  const initialLoading = updating && !saved && displayedPrices.totalUsd === null;
  const valuationNotice = initialLoading ? t("updatingValuation") : error ? (language === "zh" ? "部分余额暂不可用，请刷新重试。" : "Some balances are unavailable. Refresh to try again.") : displayedPrices.stale ? t("stalePrices") : displayedPrices.error || (displayedPrices.totalUsd === null && displayedPrices.missingCount > 0) ? t("pricesUnavailable") : displayedPrices.missingCount > 0 ? t("partialValuation", { count: displayedPrices.missingCount }) : null;
  return <SafeAreaView style={styles.safe}>
    <ScrollView contentContainerStyle={[styles.homeContent, homeStyles.content]} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshingKey === contextKey} onRefresh={refreshAll} tintColor={colors.accentBright} colors={[colors.accent]} />}>
      <View style={styles.homeHeader}>
        <View style={homeStyles.networkGroup}><Pressable accessibilityRole="button" accessibilityLabel={`${t("networks")}: ${network.name}`} style={({ pressed }) => [styles.homeNetwork, homeStyles.network, pressed && styles.homePressed]} onPress={() => navigation.navigate("Networks")}><View style={styles.homeNetworkMark}><NetworkMark chainId={network.chainId} size={22} /></View><Text style={[styles.homeNetworkText, homeStyles.networkName]} numberOfLines={1}>{network.name}</Text><ChevronDown size={16} color={colors.muted} strokeWidth={1.8} /></Pressable><Pressable accessibilityRole="button" accessibilityLabel={language === 'zh' ? '切换 RPC 节点' : 'Switch RPC node'} onPress={() => navigation.navigate('Rpc')} style={({ pressed }) => [homeStyles.rpcStatus, pressed && styles.homePressed]}><View style={[homeStyles.rpcDot, { backgroundColor: rpcHealth.status === 'offline' ? colors.red : rpcHealth.status === 'unknown' ? '#e5be6c' : rpcHealth.status === 'slow' ? '#e5be6c' : colors.green }]} /></Pressable></View>
        <Pressable accessibilityRole="button" accessibilityLabel={t("lockWallet")} style={({ pressed }) => [styles.homeLock, pressed && styles.homePressed]} onPress={() => { void lock().then(() => navigation.reset({ index: 0, routes: [{ name: "Unlock" }] })).catch(() => Alert.alert(t("lockWallet"), t("unableToLockWallet"))); }}><LockKeyhole size={20} color={colors.muted} strokeWidth={1.8} /></Pressable>
      </View>
      <View style={homeStyles.overview}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${t("accounts")}: ${manager.getSelected()?.label ?? t("accountNumber", { number: selectedAccountIndex + 1 })}`} style={({ pressed }) => [styles.homeAccount, homeStyles.account, pressed && styles.homePressed]} onPress={() => navigation.navigate("Accounts")}><View style={[styles.homeAccountNameRow, homeStyles.accountNameRow]}><Text style={[styles.homeAccountName, homeStyles.accountName]} numberOfLines={1}>{manager.getSelected()?.label ?? t("accountNumber", { number: selectedAccountIndex + 1 })}</Text><ChevronDown size={16} color={colors.muted} strokeWidth={1.8} /></View><Text style={styles.homeAccountAddress}>{shorten(account.address, 8, 6)}</Text></Pressable>
        {core.isWatchOnly() ? <View style={homeStyles.watchBadge}><Eye size={13} color={colors.accentBright} /><Text style={homeStyles.watchBadgeText}>{language === "zh" ? "观察钱包" : "Watch-Only Wallet"}</Text></View> : null}
        <View style={[styles.homeBalance, homeStyles.balance]}><Text style={styles.homeBalanceLabel}>{t(displayedPrices.complete && !updating ? "totalAssetValue" : "estimatedAssetValue")}</Text><Text style={styles.homeBalanceValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{displayedPrices.totalUsd === null ? "—" : formatUsd(displayedPrices.totalUsd, "value", language)}</Text></View>
        {valuationNotice ? <View style={homeStyles.valuationStatus} accessibilityLiveRegion="polite">{initialLoading ? <ActivityIndicator size="small" color={colors.accentBright} /> : null}<Text style={homeStyles.valuationNotice}>{valuationNotice}</Text>{!updating ? <Pressable accessibilityRole="button" accessibilityLabel={language === "zh" ? "刷新余额和价格" : "Refresh Balances and Prices"} onPress={refreshAll} style={({ pressed }) => [homeStyles.retryButton, pressed && styles.homePressed]}><RefreshCw size={17} color={colors.accentBright} /></Pressable> : null}</View> : null}
        <View style={[styles.homeActions, homeStyles.actions]}>{!core.isWatchOnly() ? <HomeAction icon={<ArrowUpRight size={20} color="#fff" strokeWidth={2} />} label={t("send")} onPress={() => navigation.navigate("Send")} /> : null}<HomeAction icon={<ArrowDownLeft size={20} color="#fff" strokeWidth={2} />} label={t("receive")} onPress={() => navigation.navigate("Receive")} /></View>
        {core.isWatchOnly() ? <Text style={homeStyles.watchHint}>{t("watchOnly")}</Text> : null}
      </View>
      <View style={styles.homeAssetHeader}><Text style={styles.homeAssetHeading}>{t("assets")}</Text><Pressable accessibilityRole="button" onPress={() => navigation.navigate("Assets")} hitSlop={10}><Text style={styles.homeAssetManage}>{t("manage")}</Text></Pressable></View>
      {displayedAssets.map((asset) => <Pressable key={asset.id} accessibilityRole="button" style={({ pressed }) => [styles.homeAssetRow, homeStyles.assetRow, pressed && styles.homePressed]} onPress={() => navigation.navigate("Asset", { token: asset.token, networkId: network.id, accountIndex: selectedAccountIndex })}><View style={styles.homeAssetBadge}><TokenIcon chainId={network.chainId} address={asset.token?.address} native={asset.id === "native"} size={44} /></View><View style={styles.homeAssetMain}><Text style={styles.homeAssetName} numberOfLines={1}>{asset.symbol}</Text><Text style={styles.homeAssetPrice} numberOfLines={1}>{displayedPrices.assets[asset.id]?.priceUsd ? t("unitPrice", { price: formatUsd(displayedPrices.assets[asset.id].priceUsd, "price", language) }) : t(displayedPrices.loading ? "loading" : "noPrice")}</Text></View><View style={styles.homeAssetAmount}><Text style={styles.homeAssetValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{displayedPrices.assets[asset.id]?.valueUsd !== null && displayedPrices.assets[asset.id]?.valueUsd !== undefined ? formatUsd(displayedPrices.assets[asset.id].valueUsd, "value", language) : "—"}</Text><Text style={styles.homeAssetUnit} numberOfLines={1} ellipsizeMode="middle">{displayAssetBalance(asset.balance)} {asset.symbol}</Text></View></Pressable>)}
    </ScrollView>
    <View style={styles.homeNavigation}><Pressable accessibilityRole="tab" accessibilityState={{ selected: true }} style={styles.homeNavItem}><Wallet size={23} color={colors.accentBright} strokeWidth={1.8} /><Text style={styles.homeNavLabelActive}>{t("wallet")}</Text></Pressable><Pressable accessibilityRole="tab" accessibilityLabel="DApp" style={({ pressed }) => [styles.homeNavItem, pressed && styles.homePressed]} onPress={() => navigation.navigate("Browser")}><Compass size={23} color={colors.muted} strokeWidth={1.8} /><Text style={styles.homeNavLabel}>DApp</Text></Pressable><Pressable accessibilityRole="tab" style={({ pressed }) => [styles.homeNavItem, pressed && styles.homePressed]} onPress={() => navigation.navigate("Settings")}><Settings size={23} color={colors.muted} strokeWidth={1.8} /><Text style={styles.homeNavLabel}>{t("settings")}</Text></Pressable></View>
  </SafeAreaView>;
}

const homeStyles = StyleSheet.create({
  content: { paddingHorizontal: 20 },
  network: { maxWidth: "80%", minHeight: 44 },
  networkName: { flexShrink: 1 },
  networkGroup: { flexDirection: 'row', alignItems: 'center', gap: 7, flexShrink: 1 },
  rpcStatus: { minWidth: 24, minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3 },
  rpcDot: { width: 9, height: 9, borderRadius: 5 },
  overview: { padding: 18, paddingTop: 20, marginBottom: 26, borderRadius: 24, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line },
  account: { maxWidth: "100%", minHeight: 48, paddingHorizontal: 4 },
  accountNameRow: { maxWidth: "100%" },
  accountName: { flexShrink: 1 },
  watchBadge: { flexDirection: "row", alignItems: "center", alignSelf: "center", gap: 5, paddingHorizontal: 9, paddingVertical: 5, marginTop: 10, borderRadius: 10, backgroundColor: "#2a2450" },
  watchBadgeText: { color: colors.accentBright, fontSize: 11, fontWeight: "600" },
  balance: { paddingTop: 24, paddingBottom: 18 },
  valuationStatus: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: -4, marginBottom: 16, minHeight: 22 },
  valuationNotice: { color: colors.muted, fontSize: 11, lineHeight: 17, flexShrink: 1, textAlign: "center" },
  retryButton: { width: 44, minHeight: 44, alignItems: "center", justifyContent: "center", marginVertical: -8 },
  actions: { marginBottom: 0, gap: 12, alignItems: "stretch" },
  action: { maxWidth: undefined, minWidth: 0, paddingHorizontal: 10, paddingVertical: 10, gap: 7 },
  actionStacked: { flexDirection: "column", minHeight: 76 },
  actionLabel: { flexShrink: 1, textAlign: "center" },
  watchHint: { color: colors.muted, fontSize: 11, lineHeight: 17, textAlign: "center", marginTop: 14 },
  assetRow: { paddingVertical: 17, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
});

export function AssetsRouteScreen({ navigation }: ScreenProps<"Assets">) {
  const { core, selectedAccountIndex, selectedNetworkId, manager } = useWalletContext();
  if (!core) return <LoadingScreen />;
  const network = core.getNetwork(selectedNetworkId);
  return <AssetsManagerScreen core={core} accountIndex={selectedAccountIndex} network={network} walletName={manager.getSelected()?.label} onBack={() => navigation.goBack()} onSelectAsset={(asset) => navigation.navigate("Asset", { token: asset.token, networkId: network.id, accountIndex: selectedAccountIndex })} />;
}

export function AssetRouteScreen({ route, navigation }: ScreenProps<"Asset">) {
  const { core, manager } = useWalletContext();
  if (!core) return <LoadingScreen />;
  const { token, networkId, accountIndex } = route.params;
  const network = core.getNetwork(networkId);
  return <AssetDetailScreen core={core} accountIndex={accountIndex} walletName={manager.getSelected()?.label} network={network} token={token} readOnly={core.isWatchOnly()} onBack={() => navigation.goBack()} onSend={() => navigation.navigate("Send", { assetAddress: token?.address, networkId, accountIndex })} onReceive={() => navigation.navigate("Receive", { token, networkId, accountIndex })} onTransaction={(record) => navigation.navigate("Transaction", { hash: record.hash, networkId, accountIndex, record })} />;
}
