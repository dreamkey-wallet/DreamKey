import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SecureModal as Modal } from './SecureModal.js';
import Clipboard from '@react-native-clipboard/clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { ArrowLeft, ArrowUpRight, TokenIcon, Check, ChevronDown, ChevronRight, CircleAlert, Coins, Fuel, Plus, Search, ShieldCheck, Trash2, X, Copy, QrCode } from './icons.js';
import { Contract, Interface, ZeroAddress, formatEther, getAddress, isAddress, parseUnits, type TransactionRequest } from 'ethers';
import type { AssetTransaction } from '../core/asset-history.js';
import type { WalletCore } from '../core/wallet-core.js';
import type { NetworkConfig } from '../core/types.js';
import { estimateAdditionalNetworkFees } from '../core/network-fees.js';
import { getUncertainBroadcastHash } from '../core/rpc-broadcast.js';
import { formatUsd } from '../core/asset-prices.js';
import { useI18n } from '../i18n.js';
import { removeToken, saveToken, type StoredToken } from '../native/token-storage.js';
import { displayAssetBalance, useWalletAssets, type WalletAssetBalance } from './useWalletAssets.js';
import { useAssetPrices } from './useAssetPrices.js';
import { QrScannerModal } from './QRScannerModal.js';

const colors = {
  background: '#0c1224', surface: '#19233d', elevated: '#202d4d', line: '#2d3a5b',
  ink: '#f7f9ff', muted: '#a8b1c7', subtle: '#7c8aa7', accent: '#a895ff',
  purple: '#7b61ff', green: '#49d89a', red: '#ff7187',
};

const copy = {
  zh: {
    send: '发送', assets: '管理资产', network: '网络', account: '发送账户', accountNumber: '账户', recipient: '接收地址',
    recipientHint: '输入 0x 开头的钱包地址', asset: '币种', selectAsset: '选择币种', available: '可用余额',
    amount: '发送数量', amountHint: '0.00', next: '下一步', review: '确认转账', sendConfirm: '确认发送',
    back: '返回', edit: '修改', native: '原生代币', tokens: '代币', import: '导入代币', contract: '代币合约地址',
    contractHint: '0x…', search: '搜索币种或合约地址', readMetadata: '查询代币', importConfirm: '确认导入',
    importHint: '输入当前网络的 ERC-20 合约地址，代币信息将从链上读取。',
    symbol: '代币符号', decimals: '精度', remove: '移除代币', removeHint: '仅从资产列表移除，不会影响链上资产。',
    cancel: '取消', gas: '预计网络费用', gasLimit: 'Gas 上限', maxFee: '网络费用上限', total: '最高总支出',
    feeNote: '实际费用取决于链上 Gas 消耗，最终以交易回执为准。',
    baseFeeNote: '包含 L1 数据费用及运营费用，已预留费用余量。费用可能随网络变化，最终以交易回执为准。',
    feeBudget: '预留网络费用', estimatedTotal: '预计总支出', additionalFee: 'L1 数据及运营费用',
    feeToken: '网络费用支付币种', reviewHint: '发送前请核对完整接收地址、数量和网络。',
    noTokens: '添加代币', noTokensHint: '添加 ERC-20 代币合约后，即可查看余额并发送代币。',
    unavailable: '余额暂不可用', retry: '重试', balanceError: '部分余额读取失败，请重试。', storageError: '无法读取本地代币列表，请重试。', loading: '正在读取余额…',
    invalidRecipient: '请输入有效的 EVM 钱包地址。', zeroRecipient: '不能发送到零地址。',
    invalidAmount: '请输入大于零的数量。', precision: '数量的小数位超过该币种精度。',
    insufficient: '可用余额不足。', insufficientGas: '原生代币余额不足以支付网络费用。',
    unknownBalance: '无法读取可用余额，请刷新后再试。', invalidToken: '请输入有效的代币合约地址。',
    noContract: '这个地址不是当前网络的合约。', invalidMetadata: '无法读取标准 ERC-20 代币信息。',
    failed: '操作失败，请重试。', checking: '正在估算费用…', sending: '正在发送…', tokenLoaded: '已从链上读取代币信息',
    submissionUnknown: '发送状态待确认', submissionUnknownHint: '节点未返回明确结果，这笔交易可能已经提交。请先查询交易状态，避免重复发送。',
    checkTransaction: '查询交易状态', checkingTransaction: '正在查询交易状态…', transactionHash: '交易哈希',
    transactionNotFound: '暂未查到这笔交易，可能仍在传播。请稍后再查询，也可在交易记录中查看。',
    transactionLookupFailed: '暂时无法查询交易状态，请稍后继续查询。请勿重复发送。',
    imported: '已导入', tokenWarning: '添加代币不代表 DreamKey 已审核该项目，请从可信来源核对合约地址。',
    noPrice: '无报价', noValue: '未估值', lastPrice: '最近报价',
    noResults: '未找到匹配资产', noResultsHint: '试试代币名称、符号或完整合约地址。', clearSearch: '清空搜索', pasteEmpty: '剪贴板为空，请复制接收地址后重试。', pasteFailed: '无法读取剪贴板，请直接输入接收地址。',
    toContract: '接收地址不能是所选代币的合约地址。', feeUnavailable: '当前 RPC 无法提供网络费用，请重试。',
    reviewExpired: '账户或网络已变化，请重新检查这笔转账。', close: '关闭', paste: '粘贴', scan: '扫描二维码', scanHint: '将收款地址二维码放入取景框中', cameraDenied: '无法使用相机，请在系统设置中允许相机权限。', transactionFailed: '交易预估或发送失败，请检查接收地址、代币和余额。', rpcError: '网络暂时无法连接，请重试。',
  },
  en: {
    send: 'Send', assets: 'Manage Assets', network: 'Network', account: 'From Account', accountNumber: 'Account', recipient: 'Recipient Address',
    recipientHint: 'Enter a wallet address starting with 0x', asset: 'Asset', selectAsset: 'Select Asset', available: 'Available Balance',
    amount: 'Amount', amountHint: '0.00', next: 'Continue', review: 'Review Transfer', sendConfirm: 'Confirm Send',
    back: 'Back', edit: 'Edit', native: 'Native Token', tokens: 'Tokens', import: 'Import Token', contract: 'Token Contract Address',
    contractHint: '0x…', search: 'Search Assets or Contract Addresses', readMetadata: 'Look Up Token', importConfirm: 'Import Token',
    importHint: 'Enter an ERC-20 contract address on this network. Token details will be read from the blockchain.',
    symbol: 'Symbol', decimals: 'Decimals', remove: 'Remove Token', removeHint: 'This removes the token from your list. Your assets on the blockchain are unaffected.',
    cancel: 'Cancel', gas: 'Estimated Network Fee', gasLimit: 'Gas Limit', maxFee: 'Maximum Network Fee', total: 'Maximum Total',
    feeNote: 'The actual fee depends on gas used. Check the transaction receipt for the final fee.',
    baseFeeNote: 'Includes L1 data and operator fees, with extra reserved for fee changes. Check the transaction receipt for the final fee.',
    feeBudget: 'Network Fee Budget', estimatedTotal: 'Estimated Total', additionalFee: 'L1 Data and Operator Fees',
    feeToken: 'Network Fee Token', reviewHint: 'Check the full recipient address, amount, and network before sending.',
    noTokens: 'Add Tokens', noTokensHint: 'Import an ERC-20 token contract to view its balance and send tokens.',
    unavailable: 'Balance Unavailable', retry: 'Retry', balanceError: 'Some balances could not be loaded. Please retry.', storageError: 'Could not load the local token list. Please retry.', loading: 'Loading balances…',
    invalidRecipient: 'Enter a valid EVM wallet address.', zeroRecipient: 'Cannot send to the zero address.',
    invalidAmount: 'Enter an amount greater than zero.', precision: 'The amount exceeds this asset’s decimal precision.',
    insufficient: 'Insufficient available balance.', insufficientGas: 'Not enough native tokens to cover the network fee.',
    unknownBalance: 'Could not load the available balance. Refresh and try again.', invalidToken: 'Enter a valid token contract address.',
    noContract: 'This address is not a contract on the selected network.', invalidMetadata: 'Could not read standard ERC-20 token details.',
    failed: 'The operation failed. Please try again.', checking: 'Estimating network fees…', sending: 'Sending…', tokenLoaded: 'Token details loaded from the blockchain',
    submissionUnknown: 'Submission Unconfirmed', submissionUnknownHint: 'The node did not return a definite result. This transaction may already be submitted. Check its status before sending again.',
    checkTransaction: 'Check Transaction Status', checkingTransaction: 'Checking transaction status…', transactionHash: 'Transaction Hash',
    transactionNotFound: 'This transaction has not been found yet and may still be propagating. Check again later or open your transaction history.',
    transactionLookupFailed: 'Transaction status is temporarily unavailable. Check again later. Do not send this transaction again.',
    imported: 'Imported', tokenWarning: 'Adding a token does not mean DreamKey has reviewed the project. Check the contract address with a trusted source.',
    noPrice: 'Price Unavailable', noValue: 'Value Unavailable', lastPrice: 'Last Quote',
    noResults: 'No Matching Assets', noResultsHint: 'Try a token name, symbol, or full contract address.', clearSearch: 'Clear Search', pasteEmpty: 'Your clipboard is empty. Copy a recipient address and try again.', pasteFailed: 'Could not read the clipboard. Enter the recipient address instead.',
    toContract: 'The recipient cannot be the selected token’s contract address.', feeUnavailable: 'The network could not provide a fee estimate. Please retry.',
    reviewExpired: 'The account or network changed. Review this transfer again.', close: 'Close', paste: 'Paste', scan: 'Scan QR Code', scanHint: 'Place the recipient address QR code inside the frame', cameraDenied: 'Camera access is unavailable. Allow camera access in system settings.', transactionFailed: 'The transfer could not be estimated or sent. Check the recipient, token, and balance.', rpcError: 'Could not connect to the network. Please retry.',
  },
};

type Labels = typeof copy.zh | typeof copy.en;
type FiatValues = ReturnType<typeof useAssetPrices>['assets'];
const tokenAbi = ['function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function name() view returns (string)', 'function transfer(address to, uint256 amount) returns (bool)'];
const transferInterface = new Interface(tokenAbi);
const shortAddress = (address: string) => `${address.slice(0, 7)}…${address.slice(-5)}`;

/** Accept plain EVM addresses and common EIP-681 ethereum: QR payloads. */
function recipientFromQrPayload(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith('ethereum:')) return trimmed;
  const payload = trimmed.slice('ethereum:'.length).split(/[?@]/, 1)[0];
  return payload.trim();
}

function errorMessage(error: unknown, labels: Labels): string {
  if (getUncertainBroadcastHash(error)) return labels.submissionUnknownHint;
  if (error instanceof Error && Object.values(labels).includes(error.message)) return error.message;
  if (error && typeof error === 'object' && 'code' in error) {
    if (error.code === 'INSUFFICIENT_FUNDS') return labels.insufficientGas;
    if (error.code === 'CALL_EXCEPTION') return labels.transactionFailed;
    if (error.code === 'NETWORK_FEE_UNAVAILABLE') return labels.feeUnavailable;
    if (error.code === 'NETWORK_ERROR' || error.code === 'SERVER_ERROR' || error.code === 'TIMEOUT') return labels.rpcError;
  }
  return labels.failed;
}

function Button({ title, onPress, loading, disabled, secondary = false }: { title: string; onPress: () => void; loading?: boolean; disabled?: boolean; secondary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled || loading), busy: Boolean(loading) }} disabled={disabled || loading} onPress={onPress} style={({ pressed }) => [styles.button, secondary && styles.secondary, (disabled || loading) && styles.disabled, pressed && styles.pressed]}>{loading ? <ActivityIndicator color={colors.ink} size="small" /> : null}<Text style={[styles.buttonText, secondary && styles.secondaryText]}>{title}</Text></Pressable>;
}

function Header({ title, network, onBack, labels, disabled = false }: { title: string; network: NetworkConfig; onBack: () => void; labels: Labels; disabled?: boolean }) {
  return <View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel={labels.back} accessibilityState={{ disabled }} disabled={disabled} onPress={onBack} style={({ pressed }) => [styles.iconButton, disabled && styles.disabled, pressed && styles.pressed]}><ArrowLeft size={22} color={colors.ink} /></Pressable><View style={styles.headerCopy}><Text style={styles.title}>{title}</Text><View style={styles.networkBadge}><View style={styles.dot} /><Text numberOfLines={1} style={styles.networkName}>{network.name}</Text></View></View><View style={styles.headerSpacer} /></View>;
}

function AssetIcon({ network, tokenAddress }: { network: NetworkConfig; tokenAddress?: string }) {
  return <View style={styles.assetIcon}><TokenIcon chainId={network.chainId} address={tokenAddress} native={!tokenAddress} size={42} /></View>;
}

function AssetListRow({ asset, network, labels, language, valuation, priceLoading, selected, onPress, onRemove }: { asset: WalletAssetBalance; network: NetworkConfig; labels: Labels; language: 'zh' | 'en'; valuation?: FiatValues[string]; priceLoading?: boolean; selected?: boolean; onPress: () => void; onRemove?: () => void }) {
  const unitPrice = valuation?.priceUsd !== null && valuation?.priceUsd !== undefined ? `${valuation.stale ? '≈ ' : ''}${formatUsd(valuation.priceUsd, 'price', language)}` : priceLoading ? '—' : labels.noPrice;
  const holdingValue = valuation?.valueUsd !== null && valuation?.valueUsd !== undefined ? `${valuation.stale || asset.loading ? '≈ ' : ''}${formatUsd(valuation.valueUsd, 'value', language)}` : priceLoading || asset.loading ? '—' : labels.noValue;
  return <View style={styles.assetRowWrap}><Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={({ pressed }) => [styles.assetRow, pressed && styles.pressed]}><AssetIcon network={network} tokenAddress={asset.token?.address} /><View style={styles.rowCopy}><Text numberOfLines={1} style={styles.rowTitle}>{asset.symbol}</Text><Text numberOfLines={1} style={styles.caption}>{asset.token ? asset.name : labels.native}</Text><Text numberOfLines={1} style={styles.small}>{unitPrice}</Text>{asset.token ? <Text style={styles.contractCaption}>{shortAddress(asset.token.address)}</Text> : null}</View><View style={styles.balanceCopy}><Text numberOfLines={1} adjustsFontSizeToFit style={styles.rowTitle}>{holdingValue}</Text><Text numberOfLines={1} style={styles.small}>{asset.balance === null ? labels.unavailable : `${displayAssetBalance(asset.balance)} ${asset.symbol}`}</Text>{valuation?.stale ? <Text style={styles.priceStatus}>{labels.lastPrice}</Text> : null}</View>{selected ? <Check size={19} color={colors.accent} /> : <ChevronRight size={18} color={colors.subtle} />}</Pressable>{onRemove ? <Pressable onPress={onRemove} accessibilityRole="button" accessibilityLabel={`${labels.remove} ${asset.symbol}`} style={styles.removeButton}><Trash2 size={17} color={colors.muted} /></Pressable> : null}</View>;
}

function Detail({ label, value, address = false }: { label: string; value: string; address?: boolean }) {
  return <View style={styles.detail}><Text style={styles.caption}>{label}</Text><Text selectable style={[styles.detailValue, address && styles.address]}>{value}</Text></View>;
}

function TokenImportModal({ visible, core, network, onClose, onImported, labels }: { visible: boolean; core: WalletCore; network: NetworkConfig; onClose: () => void; onImported?: (token: StoredToken) => void; labels: Labels }) {
  const [address, setAddress] = useState('');
  const [token, setToken] = useState<StoredToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const busyRef = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    revision.current += 1;
    setAddress(''); setToken(null); setError(''); setBusy(false); busyRef.current = false;
    return () => { revision.current += 1; busyRef.current = false; };
  }, [visible, network.chainId, network.rpcUrl]);

  const lookup = async () => {
    if (!visibleRef.current || busyRef.current) return;
    busyRef.current = true;
    Keyboard.dismiss();
    const current = ++revision.current;
    setError(''); setToken(null); setBusy(true);
    try {
      const target = address.trim();
      if (!isAddress(target) || target.toLowerCase() === ZeroAddress) throw new Error(labels.invalidToken);
      await core.assertNetwork(network.id);
      const provider = core.getSigner(0, network.id).provider!;
      if (await provider.getCode(target) === '0x') throw new Error(labels.noContract);
      const contract = new Contract(target, tokenAbi, provider);
      const [decimalsValue, symbolValue, nameValue] = await Promise.all([contract.decimals(), contract.symbol(), contract.name()]);
      const decimals = Number(decimalsValue);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 80 || typeof symbolValue !== 'string' || !symbolValue.trim() || typeof nameValue !== 'string') throw new Error(labels.invalidMetadata);
      if (current === revision.current) setToken({ address: getAddress(target), symbol: symbolValue.slice(0, 24), name: nameValue.slice(0, 100), decimals });
    } catch (failure) {
      if (current === revision.current) setError(failure && typeof failure === 'object' && 'code' in failure && failure.code === 'CALL_EXCEPTION' ? labels.invalidMetadata : errorMessage(failure, labels));
    } finally { if (current === revision.current) { busyRef.current = false; setBusy(false); } }
  };

  const confirm = async () => {
    if (!token || !visibleRef.current || busyRef.current) return;
    busyRef.current = true;
    const current = revision.current;
    setBusy(true); setError('');
    try {
      await saveToken(network.chainId, token);
      if (current === revision.current && visibleRef.current) { onImported?.(token); onClose(); }
    }
    catch { if (current === revision.current) setError(labels.failed); }
    finally { if (current === revision.current) { busyRef.current = false; setBusy(false); } }
  };
  const close = () => { if (!busyRef.current) onClose(); };
  const changeAddress = (value: string) => {
    if (busyRef.current || !visibleRef.current) return;
    revision.current += 1;
    setAddress(value); setToken(null); setError('');
  };

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}><SafeAreaView style={styles.screen}><KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><View style={styles.modalHeader}><Text style={styles.title}>{labels.import}</Text><Pressable accessibilityRole="button" accessibilityLabel={labels.close} accessibilityState={{ disabled: busy }} disabled={busy} onPress={close} style={[styles.iconButton, busy && styles.disabled]}><X size={23} color={colors.ink} /></Pressable></View><ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.content}><View style={styles.networkPill}><View style={styles.dot} /><Text style={styles.networkPillText}>{network.name}</Text></View><Text style={styles.explainer}>{labels.importHint}</Text><Text style={styles.label}>{labels.contract}</Text><TextInput accessibilityLabel={labels.contract} editable={!busy} value={address} onChangeText={changeAddress} autoCapitalize="none" autoCorrect={false} returnKeyType="search" onSubmitEditing={() => { if (!token) void lookup(); }} placeholder={labels.contractHint} placeholderTextColor={colors.subtle} style={styles.input} />{token ? <View style={styles.card}><View style={styles.tokenHeading}><AssetIcon network={network} tokenAddress={token.address} /><View style={styles.rowCopy}><Text style={styles.rowTitle}>{token.name}</Text><Text style={styles.caption}>{labels.tokenLoaded}</Text></View><ShieldCheck size={21} color={colors.green} /></View><Detail label={labels.symbol} value={token.symbol} /><Detail label={labels.decimals} value={String(token.decimals)} /><Detail label={labels.contract} value={token.address} address /></View> : null}<View style={styles.notice}><CircleAlert size={18} color={colors.accent} /><Text style={styles.noticeText}>{labels.tokenWarning}</Text></View>{error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}</ScrollView><View style={styles.footer}><Button title={token ? labels.importConfirm : labels.readMetadata} loading={busy} disabled={!address.trim()} onPress={() => { void (token ? confirm() : lookup()); }} /></View></KeyboardAvoidingView></SafeAreaView></Modal>;
}

function AssetPicker({ visible, assets, network, labels, language, valuations, priceLoading, selectedId, loading, onRefresh, onSelect, onImport, onClose, onDismiss }: { visible: boolean; assets: WalletAssetBalance[]; network: NetworkConfig; labels: Labels; language: 'zh' | 'en'; valuations: FiatValues; priceLoading: boolean; selectedId: string; loading: boolean; onRefresh: () => void; onSelect: (asset: WalletAssetBalance) => void; onImport: () => void; onClose: () => void; onDismiss: () => void }) {
  const [query, setQuery] = useState('');
  useEffect(() => { if (visible) setQuery(''); }, [visible]);
  const filtered = useMemo(() => assets.filter((asset) => `${asset.symbol} ${asset.name} ${asset.token?.address ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())), [assets, query]);
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose} onDismiss={onDismiss}>
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.modalHeader}><Text style={styles.title}>{labels.selectAsset}</Text><Pressable accessibilityRole="button" accessibilityLabel={labels.close} onPress={onClose} style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}><X size={23} color={colors.ink} /></Pressable></View>
        <View style={styles.searchWrap}>
          <Search size={19} color={colors.muted} />
          <TextInput accessibilityLabel={labels.search} value={query} onChangeText={setQuery} placeholder={labels.search} placeholderTextColor={colors.subtle} autoCapitalize="none" autoCorrect={false} returnKeyType="search" style={styles.searchInput} />
          {query ? <Pressable accessibilityRole="button" accessibilityLabel={labels.clearSearch} onPress={() => setQuery('')} style={({ pressed }) => [styles.clearSearch, pressed && styles.pressed]}><X size={18} color={colors.muted} /></Pressable> : null}
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading || priceLoading} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} />}>
          {loading ? <View style={styles.loadingRow}><ActivityIndicator color={colors.accent} /><Text style={styles.caption}>{labels.loading}</Text></View> : null}
          {filtered.length ? <View style={styles.listCard}>{filtered.map((asset) => <AssetListRow key={asset.id} asset={asset} network={network} labels={labels} language={language} valuation={valuations[asset.id]} priceLoading={priceLoading} selected={selectedId === asset.id} onPress={() => { Keyboard.dismiss(); onSelect(asset); onClose(); }} />)}</View> : !loading ? <View style={styles.empty}><View style={styles.emptyIcon}><Search size={28} color={colors.accent} /></View><Text style={styles.emptyTitle}>{labels.noResults}</Text><Text style={styles.emptyDescription}>{labels.noResultsHint}</Text>{query ? <Button title={labels.clearSearch} secondary onPress={() => setQuery('')} /> : null}</View> : null}
        </ScrollView>
        <View style={styles.footer}><Button title={labels.import} secondary onPress={() => { Keyboard.dismiss(); onImport(); }} /></View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

interface FeeOverrides {
  gasLimit?: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

interface ReviewedTransfer {
  key: string;
  recipient: string;
  amount: string;
  rawAmount: string;
  asset: WalletAssetBalance;
  from: string;
  estimatedFee: bigint;
  maxFee: bigint;
  additionalFee: bigint;
  totalIsEstimate: boolean;
  overrides: FeeOverrides;
}

export interface SendFlowScreenProps {
  core: WalletCore;
  accountIndex: number;
  network: NetworkConfig;
  walletName?: string;
  initialAssetAddress?: string;
  onBack: () => void;
  onSubmitted: (hash: string, record: AssetTransaction) => void;
}

/** Carry the reviewed public transfer into details without waiting for history storage. */
function submittedTransferRecord(network: NetworkConfig, review: ReviewedTransfer, hash: string): AssetTransaction {
  const tokenAddress = review.asset.token?.address;
  return {
    id: `${hash.toLowerCase()}:${tokenAddress?.toLowerCase() ?? 'native'}:submitted`,
    hash, chainId: network.chainId, accountAddress: review.from,
    from: review.from, to: review.recipient, tokenAddress,
    symbol: review.asset.symbol, decimals: review.asset.decimals, rawValue: review.rawAmount,
    direction: review.from.toLowerCase() === review.recipient.toLowerCase() ? 'self' : 'out',
    state: 'pending', timestamp: Math.floor(Date.now() / 1000), source: 'local', type: 'transfer',
  };
}

/** Asset selection -> recipient/amount -> fee review -> explicit broadcast. */
export function SendFlowScreen({ core, accountIndex, network, walletName, initialAssetAddress, onBack, onSubmitted }: SendFlowScreenProps) {
  const { language } = useI18n();
  const focused = useIsFocused();
  const labels = copy[language];
  const { assets, loading, contextKey: assetContextKey, error: balanceError, refresh } = useWalletAssets(core, accountIndex, network);
  const [selectedId, setSelectedId] = useState(initialAssetAddress?.toLowerCase() ?? 'native');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [picker, setPicker] = useState(false);
  const prices = useAssetPrices(network, assets, assetContextKey, loading || Boolean(balanceError), picker && focused);
  const refreshPrices = prices.refresh;
  const refreshPicker = useCallback(() => { void refresh(); void refreshPrices(true); }, [refresh, refreshPrices]);
  const [importing, setImporting] = useState(false);
  const pendingImport = useRef(false);
  const importFrame = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<ReviewedTransfer | null>(null);
  const [uncertainHash, setUncertainHash] = useState<string | null>(null);
  const uncertainHashRef = useRef<string | null>(null);
  const [scannerVisible, setScannerVisible] = useState(false);
  const clipboardRevision = useRef(0);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const selected = assets.find((asset) => asset.id === selectedId) ?? assets[0];
  const contextKey = `${accountIndex}:${network.id}:${network.chainId}:${network.rpcUrl}`;
  const currentContext = useRef(contextKey);
  currentContext.current = contextKey;
  const nativeSymbol = network.nativeSymbol ?? 'ETH';

  useFocusEffect(useCallback(() => { if (!busyRef.current) void refresh(); }, [refresh]));

  useEffect(() => {
    generation.current += 1;
    pendingImport.current = false;
    if (importFrame.current !== null) { cancelAnimationFrame(importFrame.current); importFrame.current = null; }
    setPicker(false); setImporting(false);
    setReview(null); setError(''); setBusy(false); busyRef.current = false;
    setUncertainHash(null); uncertainHashRef.current = null;
    setSelectedId(initialAssetAddress?.toLowerCase() ?? 'native');
    return () => { generation.current += 1; pendingImport.current = false; if (importFrame.current !== null) { cancelAnimationFrame(importFrame.current); importFrame.current = null; } };
  }, [contextKey, initialAssetAddress]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (busyRef.current) return true;
      if (review && !uncertainHashRef.current) { setReview(null); return true; }
      return false;
    });
    return () => subscription.remove();
  }, [review]);

  const prepare = async () => {
    if (busyRef.current || uncertainHashRef.current) return;
    Keyboard.dismiss();
    busyRef.current = true; setBusy(true); setError('');
    const revision = generation.current;
    try {
      const target = recipient.trim();
      if (!isAddress(target)) throw new Error(labels.invalidRecipient);
      if (target.toLowerCase() === ZeroAddress) throw new Error(labels.zeroRecipient);
      if (selected.token?.address.toLowerCase() === target.toLowerCase()) throw new Error(labels.toContract);
      const normalizedAmount = amount.trim().replace(',', '.');
      if (!/^(?:\d+\.?\d*|\.\d+)$/.test(normalizedAmount) || Number(normalizedAmount) <= 0) throw new Error(labels.invalidAmount);
      let rawAmount: bigint;
      try { rawAmount = parseUnits(normalizedAmount, selected.decimals); } catch { throw new Error(labels.precision); }
      if (rawAmount <= 0n) throw new Error(labels.invalidAmount);
      if (selected.rawBalance === null || selected.loading) throw new Error(labels.unknownBalance);
      await core.assertNetwork(network.id);
      const signer = core.getSigner(accountIndex, network.id);
      const provider = signer.provider!;
      const from = core.getAccount(accountIndex).address;
      const transaction: TransactionRequest = selected.token
        ? { from, to: selected.token.address, data: transferInterface.encodeFunctionData('transfer', [getAddress(target), rawAmount]) }
        : { from, to: getAddress(target), value: rawAmount };
      const [gasEstimate, fees, nativeBalance, freshAssetBalance] = await Promise.all([
        provider.estimateGas(transaction), provider.getFeeData(), provider.getBalance(from),
        selected.token ? core.getErc20Balance(accountIndex, network.id, selected.token).then((result) => BigInt(result.raw)) : provider.getBalance(from),
      ]);
      if (rawAmount > freshAssetBalance) throw new Error(labels.insufficient);
      const gasLimit = (gasEstimate * 120n + 99n) / 100n;
      const overrides: FeeOverrides = { gasLimit };
      let maxGasPrice: bigint;
      let estimateGasPrice: bigint;
      if (fees.maxFeePerGas !== null && fees.maxPriorityFeePerGas !== null) {
        maxGasPrice = fees.maxFeePerGas;
        estimateGasPrice = fees.gasPrice ?? fees.maxFeePerGas;
        overrides.maxFeePerGas = fees.maxFeePerGas;
        overrides.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
      } else if (fees.gasPrice !== null) {
        maxGasPrice = fees.gasPrice; estimateGasPrice = fees.gasPrice; overrides.gasPrice = fees.gasPrice;
      } else { throw new Error(labels.feeUnavailable); }
      const extraFees = await estimateAdditionalNetworkFees(provider, network.chainId, {
        from, to: transaction.to as string, value: selected.token ? 0n : rawAmount,
        data: selected.token ? transferInterface.encodeFunctionData('transfer', [getAddress(target), rawAmount]) : '0x',
        ...overrides, gasLimit,
      }, gasEstimate);
      const maxFee = gasLimit * maxGasPrice + extraFees.bufferedExtraFee;
      if (nativeBalance < maxFee + (selected.token ? 0n : rawAmount)) throw new Error(labels.insufficientGas);
      if (revision !== generation.current || currentContext.current !== contextKey) return;
      setReview({ key: contextKey, recipient: getAddress(target), amount: normalizedAmount, rawAmount: rawAmount.toString(), asset: selected, from,
        estimatedFee: gasEstimate * estimateGasPrice + extraFees.estimatedExtraFee, maxFee,
        additionalFee: extraFees.estimatedExtraFee, totalIsEstimate: extraFees.totalIsEstimate, overrides });
    } catch (failure) { if (revision === generation.current) setError(errorMessage(failure, labels)); }
    finally { if (revision === generation.current) { busyRef.current = false; setBusy(false); } }
  };

  const submit = async () => {
    if (!review || busyRef.current || uncertainHashRef.current) return;
    if (review.key !== currentContext.current) { setReview(null); setError(labels.reviewExpired); return; }
    busyRef.current = true; setBusy(true); setError('');
    const revision = generation.current;
    let submitted = false;
    try {
      const transaction = review.asset.token
        ? await core.sendErc20(accountIndex, network.id, review.asset.token, review.recipient, review.amount, review.overrides)
        : await core.sendNative(accountIndex, network.id, review.recipient, review.amount, review.overrides);
      submitted = true;
      setReview(null); setAmount('');
      onSubmitted(transaction.hash, submittedTransferRecord(network, review, transaction.hash));
    } catch (failure) {
      if (revision === generation.current) {
        const hash = getUncertainBroadcastHash(failure);
        if (hash) { uncertainHashRef.current = hash; setUncertainHash(hash); setError(''); }
        else setError(errorMessage(failure, labels));
      }
    }
    finally { if (!submitted && revision === generation.current) { busyRef.current = false; setBusy(false); } }
  };

  const checkSubmission = async () => {
    const hash = uncertainHashRef.current;
    if (!hash || busyRef.current) return;
    const revision = generation.current;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const status = await core.getTransactionStatus(network.id, hash);
      if (revision !== generation.current) return;
      if (status.state === 'not-found') setError(labels.transactionNotFound);
      else if (review) onSubmitted(hash, { ...submittedTransferRecord(network, review, hash), state: status.state, blockNumber: status.blockNumber });
    } catch {
      if (revision === generation.current) setError(labels.transactionLookupFailed);
    } finally {
      if (revision === generation.current) { busyRef.current = false; setBusy(false); }
    }
  };

  const back = () => { if (!busyRef.current) { if (review && !uncertainHashRef.current) { setReview(null); setError(''); } else onBack(); } };
  const finishPickerDismiss = () => {
    if (!pendingImport.current) return;
    pendingImport.current = false;
    setImporting(true);
  };
  const importFromPicker = () => {
    if (pendingImport.current || busyRef.current) return;
    pendingImport.current = true;
    setPicker(false);
    // iOS must finish dismissing its page sheet before presenting another one.
    // Android does not reliably emit Modal.onDismiss; defer to the next frame.
    if (Platform.OS !== 'ios') importFrame.current = requestAnimationFrame(() => { importFrame.current = null; finishPickerDismiss(); });
  };

  const pasteRecipient = async () => {
    if (busyRef.current) return;
    const request = ++clipboardRevision.current;
    const revision = generation.current;
    try {
      const value = await Clipboard.getString();
      if (request !== clipboardRevision.current || revision !== generation.current || busyRef.current) return;
      if (!value.trim()) { setError(labels.pasteEmpty); return; }
      setRecipient(recipientFromQrPayload(value)); setError('');
    } catch {
      if (request === clipboardRevision.current && revision === generation.current && !busyRef.current) setError(labels.pasteFailed);
    }
  };

  return <SafeAreaView style={styles.screen}><KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><Header title={review ? labels.review : labels.send} network={network} onBack={back} labels={labels} disabled={busy} /><ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false} contentContainerStyle={styles.content} refreshControl={review ? undefined : <RefreshControl refreshing={loading} enabled={!busy} onRefresh={() => { if (!busyRef.current) void refresh(); }} tintColor={colors.accent} />}>
    {review ? <>
      <View style={styles.reviewHero}><View style={styles.sendIcon}><ArrowUpRight size={28} color={colors.accent} /></View><Text style={styles.caption}>{labels.send}</Text><Text style={styles.reviewAmount}>{review.amount} <Text style={styles.reviewSymbol}>{review.asset.symbol}</Text></Text></View>
      <View style={styles.card}><Detail label={labels.account} value={walletName ?? `${labels.accountNumber} ${accountIndex + 1}`} /><Text selectable style={styles.fullAddress}>{review.from}</Text><View style={styles.divider} /><Detail label={labels.recipient} value={review.recipient} address /><Detail label={labels.network} value={network.name} />{review.asset.token ? <Detail label={labels.contract} value={review.asset.token.address} address /> : null}</View>
      <View style={styles.card}><View style={styles.feeHeading}><Fuel size={19} color={colors.accent} /><Text style={styles.rowTitle}>{labels.gas}</Text></View><Detail label={labels.gas} value={`${formatEther(review.estimatedFee)} ${nativeSymbol}`} /><Detail label={labels.gasLimit} value={review.overrides.gasLimit!.toString()} />{review.totalIsEstimate ? <Detail label={labels.additionalFee} value={`${formatEther(review.additionalFee)} ${nativeSymbol}`} /> : null}<Detail label={review.totalIsEstimate ? labels.feeBudget : labels.maxFee} value={`${formatEther(review.maxFee)} ${nativeSymbol}`} /><View style={styles.divider} /><Detail label={review.totalIsEstimate ? labels.estimatedTotal : labels.total} value={review.asset.token ? `${review.amount} ${review.asset.symbol} + ${formatEther(review.maxFee)} ${nativeSymbol}` : `${formatEther(parseUnits(review.amount, 18) + review.maxFee)} ${nativeSymbol}`} /><Text style={styles.small}>{review.totalIsEstimate ? labels.baseFeeNote : labels.feeNote}</Text></View>
      <View style={styles.notice}><ShieldCheck size={19} color={colors.accent} /><Text style={styles.noticeText}>{labels.reviewHint}</Text></View>
    </> : <>
      <View style={styles.accountBar}><View style={styles.accountMark}><Text style={styles.accountMarkText}>{accountIndex + 1}</Text></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>{walletName ?? `${labels.accountNumber} ${accountIndex + 1}`}</Text><Text selectable style={styles.caption}>{shortAddress(core.getAccount(accountIndex).address)}</Text></View></View>
      <Text style={styles.label}>{labels.asset}</Text><Pressable accessibilityRole="button" accessibilityLabel={labels.selectAsset} disabled={busy} onPress={() => setPicker(true)} style={({ pressed }) => [styles.selector, pressed && styles.pressed]}><AssetIcon network={network} tokenAddress={selected.token?.address} /><View style={styles.rowCopy}><Text style={styles.rowTitle}>{selected.symbol}</Text><Text style={styles.caption}>{selected.token ? selected.name : labels.native}</Text>{selected.token ? <Text style={styles.contractCaption}>{shortAddress(selected.token.address)}</Text> : null}</View><ChevronDown size={21} color={colors.accent} /></Pressable>
      <View style={styles.balanceLine}><Text style={styles.caption}>{labels.available}</Text><Text style={styles.availableBalance}>{selected.loading ? labels.loading : `${displayAssetBalance(selected.balance)} ${selected.symbol}`}</Text></View>
      <Text style={styles.label}>{labels.recipient}</Text><View style={styles.recipientWrap}><TextInput accessibilityLabel={labels.recipient} value={recipient} editable={!busy} onChangeText={(value) => { clipboardRevision.current += 1; setRecipient(value); setError(''); }} placeholder={labels.recipientHint} placeholderTextColor={colors.subtle} autoCapitalize="none" autoCorrect={false} multiline style={[styles.input, styles.addressInput, styles.recipientInput]} /><View style={styles.recipientActions}><Pressable accessibilityRole="button" accessibilityLabel={labels.paste} disabled={busy} onPress={() => { void pasteRecipient(); }} style={({ pressed }) => [styles.recipientAction, busy && styles.disabled, pressed && styles.pressed]}><Copy size={18} color={colors.accent} /><Text style={styles.recipientActionText}>{labels.paste}</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel={labels.scan} disabled={busy} onPress={() => { Keyboard.dismiss(); setScannerVisible(true); }} style={({ pressed }) => [styles.recipientAction, busy && styles.disabled, pressed && styles.pressed]}><QrCode size={18} color={colors.accent} /><Text style={styles.recipientActionText}>{labels.scan}</Text></Pressable></View></View>
      <Text style={styles.label}>{labels.amount}</Text><View style={styles.amountCard}><TextInput accessibilityLabel={labels.amount} editable={!busy} value={amount} onChangeText={(value) => { setAmount(value); setError(''); }} placeholder={labels.amountHint} placeholderTextColor={colors.subtle} keyboardType="decimal-pad" style={styles.amountInput} /><Text numberOfLines={1} ellipsizeMode="tail" style={styles.amountSymbol}>{selected.symbol}</Text></View>
      <View style={styles.notice}><Fuel size={18} color={colors.muted} /><Text style={styles.noticeText}>{labels.feeToken} {nativeSymbol}</Text></View>
      {balanceError ? <View style={styles.errorRow}><Text style={styles.errorFlex}>{balanceError === 'Token list unavailable' ? labels.storageError : labels.balanceError}</Text><Pressable accessibilityRole="button" disabled={busy || loading} onPress={() => { void refresh(); }}><Text style={styles.link}>{labels.retry}</Text></Pressable></View> : null}
    </>}
    {uncertainHash ? <View accessibilityRole="alert" style={styles.card}><Text style={styles.rowTitle}>{labels.submissionUnknown}</Text><Text style={styles.body}>{labels.submissionUnknownHint}</Text><Detail label={labels.transactionHash} value={uncertainHash} address /></View> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </ScrollView><View style={styles.footer}>{uncertainHash ? <Button title={busy ? labels.checkingTransaction : labels.checkTransaction} loading={busy} onPress={() => { void checkSubmission(); }} /> : review ? <View style={styles.footerButtons}><View style={styles.editButton}><Button title={labels.edit} secondary disabled={busy} onPress={back} /></View><View style={styles.flex}><Button title={busy ? labels.sending : labels.sendConfirm} loading={busy} onPress={() => { void submit(); }} /></View></View> : <Button title={busy ? labels.checking : labels.next} loading={busy} disabled={!recipient.trim() || !amount.trim() || selected.loading || selected.rawBalance === null || (selectedId !== 'native' && !selected.token)} onPress={() => { void prepare(); }} />}</View></KeyboardAvoidingView>
    <QrScannerModal visible={scannerVisible} title={labels.scan} hint={labels.scanHint} closeLabel={labels.close} permissionDeniedLabel={labels.cameraDenied} onClose={() => setScannerVisible(false)} onScanned={(value) => { clipboardRevision.current += 1; setScannerVisible(false); setRecipient(recipientFromQrPayload(value)); setError(''); }} />
    <AssetPicker visible={picker} assets={assets} network={network} labels={labels} language={language} valuations={prices.assets} priceLoading={prices.loading} selectedId={selected.id} loading={loading} onRefresh={refreshPicker} onSelect={(asset) => { setSelectedId(asset.id); setAmount(''); setError(''); }} onClose={() => setPicker(false)} onImport={importFromPicker} onDismiss={finishPickerDismiss} />
    <TokenImportModal visible={importing} core={core} network={network} onClose={() => setImporting(false)} onImported={(token) => { setSelectedId(token.address.toLowerCase()); setAmount(''); }} labels={labels} />
  </SafeAreaView>;
}

export interface AssetsManagerScreenProps {
  core: WalletCore;
  accountIndex: number;
  network: NetworkConfig;
  walletName?: string;
  onBack: () => void;
  onSelectAsset: (asset: WalletAssetBalance) => void;
}

export function AssetsManagerScreen({ core, accountIndex, network, walletName, onBack, onSelectAsset }: AssetsManagerScreenProps) {
  const { language } = useI18n();
  const focused = useIsFocused();
  const labels = copy[language];
  const { assets, loading, contextKey, error, refresh } = useWalletAssets(core, accountIndex, network);
  const prices = useAssetPrices(network, assets, contextKey, loading || Boolean(error), focused);
  const refreshPrices = prices.refresh;
  const refreshAll = useCallback((forcePrices = false) => { void refresh(); void refreshPrices(forcePrices); }, [refresh, refreshPrices]);
  useFocusEffect(useCallback(() => { refreshAll(); }, [refreshAll]));
  const [importing, setImporting] = useState(false);
  const remove = (token: StoredToken) => Alert.alert(`${labels.remove} ${token.symbol}`, labels.removeHint, [{ text: labels.cancel, style: 'cancel' }, { text: labels.remove, style: 'destructive', onPress: () => { void removeToken(network.chainId, token.address).catch(() => Alert.alert(labels.failed)); } }]);

  return <SafeAreaView style={styles.screen}><Header title={labels.assets} network={network} onBack={onBack} labels={labels} /><ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading || prices.loading} onRefresh={() => refreshAll(true)} tintColor={colors.accent} />}><View style={styles.accountBar}><View style={styles.accountMark}><Text style={styles.accountMarkText}>{accountIndex + 1}</Text></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>{walletName ?? `${labels.accountNumber} ${accountIndex + 1}`}</Text><Text selectable style={styles.caption}>{shortAddress(core.getAccount(accountIndex).address)}</Text></View></View><View style={styles.listCard}>{assets.map((asset) => <AssetListRow key={asset.id} asset={asset} network={network} labels={labels} language={language} valuation={prices.assets[asset.id]} priceLoading={prices.loading} onPress={() => onSelectAsset(asset)} onRemove={asset.token ? () => remove(asset.token!) : undefined} />)}</View>{assets.length === 1 && !loading && !error ? <View style={styles.empty}><View style={styles.emptyIcon}><Coins size={30} color={colors.accent} /></View><Text style={styles.emptyTitle}>{labels.noTokens}</Text><Text style={styles.emptyDescription}>{labels.noTokensHint}</Text></View> : null}{error ? <View style={styles.errorRow}><Text style={styles.errorFlex}>{error === 'Token list unavailable' ? labels.storageError : labels.balanceError}</Text><Pressable accessibilityRole="button" onPress={() => refreshAll(true)}><Text style={styles.link}>{labels.retry}</Text></Pressable></View> : null}</ScrollView><View style={styles.footer}><Pressable accessibilityRole="button" onPress={() => setImporting(true)} style={({ pressed }) => [styles.button, styles.secondary, pressed && styles.pressed]}><Plus size={19} color={colors.accent} /><Text style={styles.secondaryText}>{labels.import}</Text></Pressable></View><TokenImportModal visible={importing} core={core} network={network} onClose={() => setImporting(false)} labels={labels} /></SafeAreaView>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 }, screen: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 6 },
  headerCopy: { flex: 1, minWidth: 0, alignItems: 'center', gap: 4, paddingHorizontal: 8 }, headerSpacer: { width: 44 },
  title: { fontSize: 20, fontWeight: '700', color: colors.ink, flexShrink: 1, textAlign: 'center' },
  iconButton: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  networkBadge: { maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: 6 }, networkName: { flexShrink: 1, color: colors.muted, fontSize: 13, lineHeight: 19 }, dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.green },
  content: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 22, gap: 10 },
  body: { color: colors.ink, fontSize: 15, lineHeight: 22 }, caption: { color: colors.muted, fontSize: 13, lineHeight: 19 }, small: { color: colors.muted, fontSize: 12, lineHeight: 18 }, contractCaption: { color: colors.subtle, fontSize: 11, lineHeight: 16, fontFamily: 'monospace' }, priceStatus: { color: '#e5be6c', fontSize: 10, lineHeight: 15 },
  label: { color: colors.muted, fontSize: 13, fontWeight: '600', marginTop: 8 },
  accountBar: { flexDirection: 'row', gap: 10, alignItems: 'center', padding: 12, borderRadius: 14, backgroundColor: '#111a30', marginBottom: 10 },
  accountMark: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#2f335e', alignItems: 'center', justifyContent: 'center' }, accountMarkText: { color: colors.accent, fontSize: 15, fontWeight: '700' },
  rowCopy: { flex: 1, minWidth: 0, gap: 3 }, rowTitle: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  assetIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'transparent' },
  bnbIcon: { backgroundColor: '#6d5425' }, assetIconText: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  selector: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 13, backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.line },
  balanceLine: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 6, marginBottom: 8 }, availableBalance: { flexShrink: 1, color: colors.muted, fontSize: 13, lineHeight: 19 },
  input: { minHeight: 56, paddingHorizontal: 14, paddingVertical: 13, borderWidth: 1, borderColor: colors.line, borderRadius: 14, color: colors.ink, backgroundColor: colors.surface, fontSize: 15 },
  addressInput: { minHeight: 80, textAlignVertical: 'top', lineHeight: 22 },
  recipientWrap: { borderWidth: 1, borderColor: colors.line, borderRadius: 18, backgroundColor: colors.surface, overflow: 'hidden' },
  recipientInput: { borderWidth: 0, borderRadius: 0, minHeight: 86, paddingBottom: 10 },
  recipientActions: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, padding: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  recipientAction: { minHeight: 44, minWidth: 76, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7, backgroundColor: '#282244' },
  recipientActionText: { color: colors.accent, fontSize: 12, lineHeight: 18, fontWeight: '700' },
  amountCard: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 14 },
  amountInput: { flex: 1, minWidth: 0, minHeight: 74, fontSize: 30, color: colors.ink, paddingVertical: 13 }, amountSymbol: { maxWidth: '32%', color: colors.accent, fontSize: 17, fontWeight: '600' },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: '#141d34', borderRadius: 12, padding: 11, marginTop: 4 }, noticeText: { flex: 1, color: colors.muted, fontSize: 13, lineHeight: 20 },
  footer: { paddingHorizontal: 18, paddingTop: 10, paddingBottom: 12, backgroundColor: colors.background, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  button: { minHeight: 54, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: colors.purple, borderRadius: 16, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  buttonText: { flexShrink: 1, color: colors.ink, fontSize: 16, lineHeight: 23, textAlign: 'center', fontWeight: '700' }, secondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }, secondaryText: { color: colors.accent, fontWeight: '700', fontSize: 15 },
  pressed: { opacity: 0.72 }, disabled: { opacity: 0.42 },
  error: { color: colors.red, fontSize: 13, lineHeight: 21, paddingVertical: 8 }, errorRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 10 }, errorFlex: { flex: 1, color: colors.red, fontSize: 13, lineHeight: 20 }, link: { color: colors.accent, fontSize: 13, fontWeight: '600', padding: 6 },
  reviewHero: { alignItems: 'center', gap: 6, paddingTop: 0, paddingBottom: 10 }, sendIcon: { width: 56, height: 56, borderRadius: 20, backgroundColor: '#282244', justifyContent: 'center', alignItems: 'center', marginBottom: 5 }, reviewAmount: { color: colors.ink, fontSize: 30, lineHeight: 38, fontWeight: '700', textAlign: 'center' }, reviewSymbol: { color: colors.accent, fontSize: 20 },
  card: { padding: 14, borderRadius: 16, backgroundColor: colors.surface, gap: 13, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  detail: { gap: 6 }, detailValue: { color: colors.ink, fontSize: 15, fontWeight: '600', lineHeight: 22 }, address: { fontFamily: 'monospace', fontSize: 14, lineHeight: 23, fontWeight: '400' }, fullAddress: { fontFamily: 'monospace', fontSize: 12, color: colors.muted, lineHeight: 20 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: 2 }, feeHeading: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 4 },
  footerButtons: { flexDirection: 'row', gap: 12 }, editButton: { width: 96 },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, paddingHorizontal: 18, paddingVertical: 10 },
  networkPill: { maxWidth: '100%', alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 12, backgroundColor: colors.surface, borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }, networkPillText: { flexShrink: 1, color: colors.ink, fontSize: 15, lineHeight: 22 }, explainer: { color: colors.muted, fontSize: 14, lineHeight: 22 }, tokenHeading: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  searchWrap: { marginHorizontal: 22, paddingLeft: 14, paddingRight: 4, minHeight: 52, borderRadius: 15, backgroundColor: colors.surface, flexDirection: 'row', alignItems: 'center', gap: 9 }, searchInput: { flex: 1, minWidth: 0, color: colors.ink, fontSize: 14, paddingVertical: 12 }, clearSearch: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  listCard: { paddingHorizontal: 12, backgroundColor: colors.surface, borderRadius: 16 }, assetRowWrap: { flexDirection: 'row', alignItems: 'center' }, assetRow: { flex: 1, minWidth: 0, flexDirection: 'row', gap: 10, alignItems: 'center', minHeight: 76, paddingVertical: 11 }, balanceCopy: { minWidth: 0, alignItems: 'flex-end', gap: 3, maxWidth: '38%' }, removeButton: { minWidth: 44, minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingBottom: 6 }, empty: { alignItems: 'center', paddingVertical: 48, gap: 12 }, emptyIcon: { width: 74, height: 74, borderRadius: 26, backgroundColor: '#27213e', justifyContent: 'center', alignItems: 'center', marginBottom: 4 }, emptyTitle: { color: colors.ink, fontSize: 19, fontWeight: '600' }, emptyDescription: { color: colors.muted, fontSize: 14, lineHeight: 23, textAlign: 'center', maxWidth: 270 },
});
