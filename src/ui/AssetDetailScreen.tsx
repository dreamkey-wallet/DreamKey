import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Linking, Pressable, RefreshControl, StyleSheet, Text, View, type ListRenderItemInfo } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatUnits } from 'ethers';
import type { WalletCore } from '../core/wallet-core.js';
import type { NetworkConfig } from '../core/types.js';
import type { AssetTransaction } from '../core/asset-history.js';
import { formatUsd } from '../core/asset-prices.js';
import type { StoredToken } from '../native/token-storage.js';
import { useI18n } from '../i18n.js';
import { ArrowDownLeft, ArrowLeft, ArrowLeftRight, ArrowUpRight, ChevronRight, Clock3, Link, TokenIcon } from './icons.js';
import { walletColors as c } from './theme.js';
import { displayAssetBalance, useWalletAssets } from './useWalletAssets.js';
import { useAssetHistory } from './useAssetHistory.js';
import { useAssetPrices } from './useAssetPrices.js';

interface Props {
  core: WalletCore;
  accountIndex: number;
  walletName?: string;
  network: NetworkConfig;
  token?: StoredToken;
  /** Watch-only wallets can inspect history and receive, but never send. */
  readOnly?: boolean;
  onBack: () => void;
  onSend: () => void;
  onReceive: () => void;
  onTransaction: (record: AssetTransaction) => void;
}

const text = {
  zh: { balance: '当前余额', transactions: '交易记录', all: '全部', sent: '发送', received: '接收', self: '内部转账', interaction: '合约交互',
    incoming: '转入', outgoing: '转出',
    confirmed: '已确认', pending: '确认中', failed: '失败', loading: '正在加载交易记录…', empty: '暂无交易记录',
    emptyIncoming: '暂无转入记录', emptyOutgoing: '暂无转出记录',
    moreHint: '当前记录中没有匹配项，可继续加载更早的记录。',
    emptyHint: '该币种的转入和转出记录会显示在这里。', retry: '重试', more: '加载更多', explorer: '在区块浏览器查看',
    unavailable: '历史记录暂不可用，当前仅展示已保存的记录。', limited: '已展示查询范围内的记录，更早记录可在区块浏览器查看。',
    partial: '部分记录未能加载，请重试或在区块浏览器查看。', back: '返回', contract: '合约地址', account: '账户',
    balanceError: '余额读取失败，下拉刷新重试。', unsupported: '此网络暂不支持完整交易记录，当前显示本机保存的记录。',
    assetValue: '资产估值', noPrice: '暂无报价', noValue: '暂无估值', priceLoading: '正在更新价格…', lastPrice: '当前使用最近报价，下拉刷新更新。' },
  en: { balance: 'Current Balance', transactions: 'Transactions', all: 'All', sent: 'Send', received: 'Receive', self: 'Self Transfer', interaction: 'Contract Interaction',
    incoming: 'Incoming', outgoing: 'Outgoing',
    confirmed: 'Confirmed', pending: 'Pending', failed: 'Failed', loading: 'Loading transactions…', empty: 'No Transactions Yet',
    emptyIncoming: 'No Incoming Transactions', emptyOutgoing: 'No Outgoing Transactions',
    moreHint: 'No matches in the loaded records. Load more to check older activity.',
    emptyHint: 'Incoming and outgoing transfers for this asset will appear here.', retry: 'Retry', more: 'Load More', explorer: 'View on Block Explorer',
    unavailable: 'Transaction history is unavailable. Showing saved records only.', limited: 'Showing records within the available range. View older activity on the block explorer.',
    partial: 'Some records could not be loaded. Retry or check the block explorer.', back: 'Back', contract: 'Contract Address', account: 'Account',
    balanceError: 'Balance unavailable. Pull down to retry.', unsupported: 'Full transaction history is unavailable for this network. Showing records saved on this device.',
    assetValue: 'Asset Value', noPrice: 'Price Unavailable', noValue: 'Value Unavailable', priceLoading: 'Updating prices…', lastPrice: 'Using the latest saved price. Pull down to refresh.' },
};
type Labels = typeof text.zh | typeof text.en;
type HistoryFilter = 'all' | 'in' | 'out';
const short = (address: string) => `${address.slice(0, 7)}…${address.slice(-5)}`;
const keyExtractor = (record: AssetTransaction) => record.id;

const TransactionRow = memo(function TransactionRow({ record, labels, formatter, onPress }: { record: AssetTransaction; labels: Labels; formatter: Intl.DateTimeFormat; onPress: (record: AssetTransaction) => void }) {
  const incoming = record.direction === 'in';
  const Icon = record.direction === 'self' ? ArrowLeftRight : incoming ? ArrowDownLeft : ArrowUpRight;
  const title = record.type === 'interaction' ? labels.interaction : record.direction === 'self' ? labels.self : incoming ? labels.incoming : labels.outgoing;
  const color = record.state === 'failed' ? c.danger : record.state === 'pending' ? c.warning : incoming ? c.success : c.ink;
  let amount = '—';
  try { amount = displayAssetBalance(formatUnits(record.rawValue, record.decimals)); } catch { /* Invalid indexer values never become zero. */ }
  const timestamp = record.timestamp ? new Date(record.timestamp * 1000) : undefined;
  const date = timestamp && Number.isFinite(timestamp.getTime()) ? formatter.format(timestamp) : short(record.hash);
  const state = record.state === 'confirmed' ? labels.confirmed : record.state === 'failed' ? labels.failed : labels.pending;
  return <Pressable accessibilityRole="button" accessibilityLabel={`${title}, ${amount} ${record.symbol}, ${state}`} onPress={() => onPress(record)} style={({ pressed }) => [s.transaction, pressed && s.pressed]}>
    <View style={[s.transactionIcon, incoming && s.incoming, record.state === 'failed' && s.failed]}><Icon size={21} color={record.state === 'failed' ? c.danger : incoming ? c.success : c.primary} /></View>
    <View style={s.transactionCopy}><Text style={s.rowTitle}>{title}</Text><Text style={s.caption}>{date}</Text><Text style={s.small}>{short(incoming ? record.from : record.to)}</Text></View>
    <View style={s.amountColumn}><Text style={[s.transactionAmount, { color }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{record.state === 'failed' || record.rawValue === '0' ? '' : incoming ? '+' : record.direction === 'self' ? '' : '−'}{amount}</Text><Text numberOfLines={1} style={s.small}>{record.symbol}</Text><Text style={[s.small, { color: record.state === 'confirmed' ? c.textSecondary : color }]}>{state}</Text></View>
    <ChevronRight size={16} color={c.textTertiary} />
  </Pressable>;
});

export function AssetDetailScreen({ core, accountIndex, walletName, network, token, readOnly = core.isWatchOnly(), onBack, onSend, onReceive, onTransaction }: Props) {
  const { language } = useI18n();
  const labels = text[language];
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all');
  const [refreshing, setRefreshing] = useState(false);
  const manualRefresh = useRef(0);
  const accountAddress = core.getAccount(accountIndex).address;
  const symbol = token?.symbol ?? network.nativeSymbol ?? 'ETH';
  const { assets, loading: balancesLoading, error: balanceError, contextKey, refresh: refreshBalances } = useWalletAssets(core, accountIndex, network);
  // Keep this screen's snapshot when a transaction is pushed over it. The
  // hooks perform their first load; subsequent network reads are user driven.
  const prices = useAssetPrices(network, assets, contextKey, balancesLoading || Boolean(balanceError), true, false);
  const refreshPrices = prices.refresh;
  const asset = assets.find((entry) => entry.id === (token?.address.toLowerCase() ?? 'native'));
  const valuation = prices.assets[token?.address.toLowerCase() ?? 'native'];
  const unitPrice = valuation?.priceUsd !== null && valuation?.priceUsd !== undefined ? `${valuation.stale ? '≈ ' : ''}${formatUsd(valuation.priceUsd, 'price', language)}` : prices.loading ? '—' : labels.noPrice;
  const holdingValue = valuation?.valueUsd !== null && valuation?.valueUsd !== undefined ? `${valuation.stale || asset?.loading ? '≈ ' : ''}${formatUsd(valuation.valueUsd, 'value', language)}` : prices.loading || balancesLoading ? '—' : labels.noValue;
  const history = useAssetHistory(core, accountAddress, network, token);
  useEffect(() => { setHistoryFilter('all'); }, [accountAddress, network.chainId, token?.address]);
  const visibleRecords = useMemo(() => history.records.filter((record) => historyFilter === 'all' || record.direction === historyFilter), [history.records, historyFilter]);
  const formatter = useMemo(() => new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), [language]);
  useEffect(() => {
    setRefreshing(false);
    return () => { manualRefresh.current += 1; };
  }, [contextKey, token?.address]);
  const refresh = useCallback(async () => {
    const revision = ++manualRefresh.current;
    setRefreshing(true);
    try { await Promise.all([refreshBalances(), history.refresh(), refreshPrices(true)]); }
    finally { if (revision === manualRefresh.current) setRefreshing(false); }
  }, [refreshBalances, history.refresh, refreshPrices]);
  const renderItem = useCallback(({ item }: ListRenderItemInfo<AssetTransaction>) => <TransactionRow record={item} labels={labels} formatter={formatter} onPress={onTransaction} />, [labels, formatter, onTransaction]);
  const explorerUrl = network.explorerUrl ? token ? `${network.explorerUrl.replace(/\/$/, '')}/token/${token.address}?a=${accountAddress}` : `${network.explorerUrl.replace(/\/$/, '')}/address/${accountAddress}` : undefined;
  const openExplorer = useCallback(() => { if (explorerUrl) void Linking.openURL(explorerUrl).catch(() => undefined); }, [explorerUrl]);
  const warning = history.warning === 'history-unavailable' ? labels.unavailable : history.warning === 'partial-history' ? labels.partial : history.warning === 'unsupported-network' ? labels.unsupported : history.warning ? labels.limited : undefined;
  const emptyTitle = historyFilter === 'in' ? labels.emptyIncoming : historyFilter === 'out' ? labels.emptyOutgoing : labels.empty;
  const emptyHint = history.hasMore ? labels.moreHint : warning ?? labels.emptyHint;

  const header = <>
    <View style={s.hero}>
      <View style={s.coin}><TokenIcon chainId={network.chainId} address={token?.address} native={!token} size={44} /></View>
      <Text style={s.balanceLabel}>{labels.balance}</Text>
      <Text style={s.balance} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>{displayAssetBalance(asset?.balance ?? null)}</Text>
      {asset?.loading && asset.balance === null ? <ActivityIndicator color={c.primary} style={s.progress} /> : null}
      {token ? <Text style={s.assetName}>{token.name}</Text> : null}
      <View style={s.valuation}>
        <View style={s.priceColumn}><Text style={s.caption}>USD</Text><Text style={s.price} numberOfLines={1} adjustsFontSizeToFit>{unitPrice}</Text></View>
        <View style={[s.priceColumn, s.valueColumn]}><Text style={s.caption}>{labels.assetValue} · USD</Text><Text style={s.value} numberOfLines={1} adjustsFontSizeToFit>{holdingValue}</Text></View>
      </View>
      {valuation?.stale ? <Text style={s.priceStatus}>{labels.lastPrice}</Text> : prices.loading ? <Text style={s.small}>{labels.priceLoading}</Text> : null}
      <View style={s.accountPill}><Text accessibilityLabel={`${walletName ?? `${labels.account} ${accountIndex + 1}`} · ${accountAddress}`} numberOfLines={2} ellipsizeMode="tail" style={s.small}>{walletName ?? `${labels.account} ${accountIndex + 1}`} · {short(accountAddress)}</Text></View>
      {token ? <Pressable accessibilityRole="button" accessibilityLabel={labels.contract} onPress={openExplorer} disabled={!explorerUrl} style={s.contract}><Text style={s.small}>{labels.contract} · {short(token.address)}</Text><Link size={13} color={c.textSecondary} /></Pressable> : null}
      {asset?.error ? <Text accessibilityRole="alert" style={s.error}>{labels.balanceError}</Text> : null}
    </View>
    <View style={s.section}>
      <Text style={s.sectionTitle}>{labels.transactions}</Text>
      <View style={s.filterTabs}>
        {([['all', labels.all], ['in', labels.incoming], ['out', labels.outgoing]] as const).map(([value, title]) => (
          <Pressable key={value} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ selected: historyFilter === value }} onPress={() => setHistoryFilter(value)} style={({ pressed }) => [s.filterTab, historyFilter === value && s.filterTabActive, pressed && s.pressed]}>
            <Text style={[s.filterTabText, historyFilter === value && s.filterTabTextActive]}>{title}</Text>
          </Pressable>
        ))}
      </View>
    </View>
    {warning ? <View style={s.warning}><Text style={s.warningText}>{warning}</Text><Pressable accessibilityRole="button" disabled={history.loading} onPress={() => { void history.refresh(); }} style={({ pressed }) => [s.retryButton, (pressed || history.loading) && s.pressed]}><Text style={s.link}>{labels.retry}</Text></Pressable></View> : null}
    {history.loading && history.records.length ? <ActivityIndicator color={c.primary} style={s.progress} /> : null}
  </>;
  const empty = <View style={s.empty}>{history.loading ? <><ActivityIndicator color={c.primary} /><Text style={s.caption}>{labels.loading}</Text></> : <><View style={s.emptyIcon}><Clock3 size={30} color={c.textTertiary} /></View><Text style={s.emptyTitle}>{emptyTitle}</Text><Text style={s.emptyHint}>{emptyHint}</Text></>}</View>;
  const footer = <View style={s.listFooter}>{history.hasMore ? <Pressable accessibilityRole="button" accessibilityState={{ disabled: history.loading || history.loadingMore, busy: history.loadingMore }} disabled={history.loading || history.loadingMore} onPress={() => { void history.loadMore(); }} style={({ pressed }) => [s.more, (pressed || history.loading || history.loadingMore) && s.pressed]}>{history.loadingMore ? <ActivityIndicator size="small" color={c.primary} /> : null}<Text style={s.link}>{labels.more}</Text></Pressable> : null}{explorerUrl ? <Pressable accessibilityRole="button" onPress={openExplorer} style={({ pressed }) => [s.explorer, pressed && s.pressed]}><Text style={s.explorerText}>{labels.explorer}</Text><Link size={14} color={c.textSecondary} /></Pressable> : null}</View>;

  return <SafeAreaView style={s.screen}>
    <View style={s.header}><Pressable accessibilityRole="button" accessibilityLabel={labels.back} onPress={onBack} style={({ pressed }) => [s.back, pressed && s.pressed]}><ArrowLeft size={23} color={c.ink} /></Pressable><View style={s.titleGroup}><Text style={s.title} numberOfLines={1}>{symbol}</Text><Text numberOfLines={1} style={s.caption}>{network.name}</Text></View><View style={s.headerSpacer} /></View>
    <FlatList data={visibleRecords} keyExtractor={keyExtractor} renderItem={renderItem} ListHeaderComponent={header} ListEmptyComponent={empty} ListFooterComponent={footer} contentContainerStyle={s.listContent} initialNumToRender={12} windowSize={7} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh(); }} tintColor={c.primary} colors={[c.primary]} />} />
    <View style={s.actions}>
      {!readOnly ? <Pressable accessibilityRole="button" onPress={onSend} style={({ pressed }) => [s.action, s.send, pressed && s.pressed]}><ArrowUpRight size={21} color={c.white} /><Text style={s.actionText}>{labels.sent}</Text></Pressable> : null}
      <Pressable accessibilityRole="button" onPress={onReceive} style={({ pressed }) => [s.action, s.receive, readOnly && s.receiveOnly, pressed && s.pressed]}><ArrowDownLeft size={21} color={c.primary} /><Text style={[s.actionText, s.receiveText]}>{labels.received}</Text></Pressable>
    </View>
  </SafeAreaView>;
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.background }, header: { paddingHorizontal: 16, paddingVertical: 4, flexDirection: 'row', alignItems: 'center' },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, headerSpacer: { width: 44 }, titleGroup: { flex: 1, minWidth: 0, alignItems: 'center', gap: 3, paddingHorizontal: 8 }, title: { color: c.ink, fontSize: 19, fontWeight: '700' },
  listContent: { paddingHorizontal: 18, paddingBottom: 10, flexGrow: 1 }, hero: { alignItems: 'center', paddingTop: 4, paddingBottom: 12 }, coin: { width: 54, height: 54, borderRadius: 27, backgroundColor: c.surface, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  balanceLabel: { color: c.textSecondary, fontSize: 13, marginBottom: 4 }, balance: { color: c.ink, fontSize: 34, fontWeight: '700', width: '100%', textAlign: 'center' }, assetName: { color: c.textSecondary, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 3 },
  valuation: { alignSelf: 'stretch', flexDirection: 'row', gap: 12, marginTop: 10, marginBottom: 2, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 15, backgroundColor: c.surface }, priceColumn: { flex: 1, minWidth: 0, gap: 4 }, valueColumn: { alignItems: 'flex-end' }, price: { color: c.ink, fontSize: 16, fontWeight: '600' }, value: { color: c.ink, fontSize: 19, fontWeight: '700' }, priceStatus: { color: c.warning, fontSize: 11, lineHeight: 17, textAlign: 'center' },
  accountPill: { maxWidth: '100%', backgroundColor: c.surface, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7, marginTop: 8 }, contract: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 9 }, caption: { color: c.textSecondary, fontSize: 12, lineHeight: 18 }, small: { color: c.textSecondary, fontSize: 11, lineHeight: 16 },
  section: { paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border }, sectionTitle: { fontSize: 18, color: c.ink, fontWeight: '700', marginBottom: 8 },
  filterTabs: { flexDirection: 'row', alignItems: 'stretch', gap: 8 }, filterTab: { flex: 1, minWidth: 0, minHeight: 44, paddingHorizontal: 10, paddingVertical: 10, alignItems: 'center', justifyContent: 'center', borderRadius: 11, backgroundColor: c.surface }, filterTabActive: { backgroundColor: c.primary }, filterTabText: { color: c.textSecondary, fontSize: 13, lineHeight: 19, textAlign: 'center', fontWeight: '600' }, filterTabTextActive: { color: c.white },
  transaction: { minHeight: 84, flexDirection: 'row', gap: 9, alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border, paddingVertical: 12 }, transactionIcon: { width: 40, height: 40, borderRadius: 14, backgroundColor: c.primarySoft, alignItems: 'center', justifyContent: 'center' }, incoming: { backgroundColor: c.successSoft }, failed: { backgroundColor: c.dangerSoft }, transactionCopy: { flex: 1, minWidth: 0, gap: 2 }, rowTitle: { color: c.ink, fontSize: 15, fontWeight: '600' },
  amountColumn: { maxWidth: '36%', alignItems: 'flex-end', gap: 2 }, transactionAmount: { fontSize: 15, fontWeight: '600' }, progress: { paddingVertical: 14 }, empty: { minHeight: 175, alignItems: 'center', justifyContent: 'center', paddingVertical: 26, gap: 10 }, emptyIcon: { width: 58, height: 58, borderRadius: 20, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center', marginBottom: 4 }, emptyTitle: { color: c.ink, fontSize: 16, fontWeight: '600' }, emptyHint: { color: c.textSecondary, fontSize: 12, lineHeight: 20, textAlign: 'center' },
  warning: { padding: 13, backgroundColor: c.surface, marginTop: 14, borderRadius: 12, flexDirection: 'row', gap: 10, alignItems: 'center' }, warningText: { flex: 1, color: c.textSecondary, fontSize: 12, lineHeight: 19 }, retryButton: { minWidth: 48, minHeight: 44, alignItems: 'center', justifyContent: 'center' }, link: { color: c.primary, fontSize: 13, fontWeight: '600' }, error: { color: c.danger, fontSize: 12, marginTop: 10 }, listFooter: { paddingVertical: 18, gap: 12 }, more: { minHeight: 48, padding: 12, flexDirection: 'row', gap: 8, justifyContent: 'center', alignItems: 'center', borderRadius: 14, backgroundColor: c.surface }, explorer: { minHeight: 44, alignItems: 'center', justifyContent: 'center', gap: 7, flexDirection: 'row', paddingVertical: 8 }, explorerText: { flexShrink: 1, textAlign: 'center', color: c.textSecondary, fontSize: 12, lineHeight: 18 },
  actions: { paddingHorizontal: 18, paddingVertical: 10, flexDirection: 'row', gap: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border }, action: { flex: 1, minWidth: 0, minHeight: 52, paddingHorizontal: 10, paddingVertical: 10, borderRadius: 15, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center' }, send: { backgroundColor: c.primary }, receive: { backgroundColor: c.surface, borderWidth: 1, borderColor: c.border }, receiveOnly: { flex: 1 }, actionText: { flexShrink: 1, textAlign: 'center', color: c.white, fontSize: 15, lineHeight: 22, fontWeight: '700' }, receiveText: { color: c.primary }, pressed: { opacity: 0.72 },
});
