import React, { useMemo, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import { DappBrowser } from '../dapp/DappBrowser.js';
import type { DappBrowserRef, DappNavigationState } from '../dapp/types.js';
import { DappBrowserCloseButton, DappBrowserToolbar } from './DappBrowserToolbar.js';
import { useI18n } from '../i18n.js';
import { waitForPaint } from './feedback.js';
import { Interface, MaxUint256, formatEther, formatUnits, isAddress } from 'ethers';
import type { TransactionStatus } from '../core/types.js';
import {
  AssetRow,
  Card,
  Chip,
  IconBadge,
  PageHeader,
  PrimaryButton,
  RowButton,
  Screen,
  SecondaryButton,
  Field,
  primitiveStyles,
} from './primitives.js';
import { walletColors, walletRadii, walletSpacing, walletTypography } from './theme.js';
import { ArrowDownLeft, ArrowUpRight, Check, ChevronDown, Copy, Globe, NetworkMark, UserRound } from './icons.js';
import type {
  AccountsScreenProps,
  ActivityItem,
  AssetsScreenProps,
  DappBrowserScreenProps,
  NetworksScreenProps,
  PermissionPromptProps,
  SendScreenProps,
  SignRequestScreenProps,
  TransactionDetailScreenProps,
  WalletHomeScreenProps,
} from './types.js';

function shortAddress(address: string, chars = 5): string {
  return address.length > chars * 2 + 3 ? `${address.slice(0, chars + 2)}…${address.slice(-chars)}` : address;
}

function activityIcon(kind: ActivityItem['kind']): string {
  if (kind === 'received') return '↓';
  if (kind === 'sent') return '↑';
  if (kind === 'swap') return '⇄';
  return '⌁';
}

export function WalletHomeScreen({
  account,
  network,
  nativeBalance,
  nativeFiatValue,
  assets = [],
  activity = [],
  loading,
  onCopyAddress,
  onReceive,
  onSend,
  onOpenAssets,
  onSelectActivity,
  onOpenAccountPicker,
  onOpenNetworkPicker,
  onOpenBrowser,
}: WalletHomeScreenProps) {
  return (
    <Screen style={styles.homeScreen}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        <View style={styles.homeHeader}>
          <Pressable accessibilityRole="button" onPress={onOpenAccountPicker} style={styles.identityButton}>
            <IconBadge label={account.address} icon={<UserRound size={20} color={walletColors.white} />} color={walletColors.primary} size={36} />
            <View><Text style={styles.identityName}>Account {account.index + 1}</Text><Text style={styles.identityAddress}>{shortAddress(account.address)}</Text></View>
            <ChevronDown size={18} color={walletColors.textSecondary} />
          </Pressable>
          <Pressable accessibilityRole="button" onPress={onOpenNetworkPicker} style={styles.networkPill}><NetworkMark chainId={network.chainId} size={18} style={{ marginRight: walletSpacing.sm }} /><Text style={styles.networkPillText}>{network.name}</Text><ChevronDown size={16} color={walletColors.textSecondary} /></Pressable>
        </View>

        <Card style={styles.balanceCard}>
          <Text style={styles.balanceCaption}>Total Balance</Text>
          {loading ? <Text style={styles.balanceValue}>Loading…</Text> : <Text style={styles.balanceValue}>{nativeBalance} {network.nativeSymbol ?? 'ETH'}</Text>}
          {nativeFiatValue ? <Text style={styles.balanceFiat}>{nativeFiatValue}</Text> : null}
          <Pressable accessibilityRole="button" onPress={onCopyAddress} style={styles.addressPill}><Text style={styles.addressText}>{shortAddress(account.address, 8)}</Text><Copy size={16} color={walletColors.white} style={{ marginLeft: walletSpacing.sm }} /></Pressable>
        </Card>

        <View style={styles.actionGrid}>
          <Pressable accessibilityRole="button" onPress={onSend} style={styles.actionButton}><IconBadge label="↑" icon={<ArrowUpRight size={23} color={walletColors.white} />} color={walletColors.primary} size={38} /><Text style={styles.actionLabel}>Send</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={onReceive} style={styles.actionButton}><IconBadge label="↓" icon={<ArrowDownLeft size={23} color={walletColors.white} />} color={walletColors.success} size={38} /><Text style={styles.actionLabel}>Receive</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={onOpenBrowser} style={styles.actionButton}><IconBadge label="◎" icon={<Globe size={23} color={walletColors.white} />} color="#2E70C9" size={38} /><Text style={styles.actionLabel}>DApp</Text></Pressable>
        </View>

        <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>Assets</Text><Pressable accessibilityRole="button" onPress={onOpenAssets}><Text style={styles.sectionLink}>View All</Text></Pressable></View>
        <Card style={styles.listCard}>
          <AssetRow chainId={network.chainId} native symbol={network.nativeSymbol ?? 'ETH'} name={network.name} amount={nativeBalance} fiat={nativeFiatValue} iconColor="#627EEA" />
          {assets.slice(0, 3).map((asset) => <AssetRow key={asset.token.address} chainId={network.chainId} address={asset.token.address} symbol={asset.token.symbol ?? 'TOKEN'} name={asset.token.name} amount={asset.formatted} fiat={asset.fiatValue} iconColor={asset.iconColor} onPress={() => onOpenAssets?.()} />)}
          {!assets.length ? <Text style={styles.emptyText}>Add an ERC-20 token to track it here.</Text> : null}
        </Card>

        <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>Activity</Text><Text style={styles.sectionLink}>{activity.length ? `${activity.length} recent` : ''}</Text></View>
        <Card style={styles.listCard}>
          {activity.slice(0, 5).map((item) => <Pressable key={item.id} accessibilityRole="button" onPress={() => onSelectActivity?.(item)} style={styles.activityRow}><IconBadge label={activityIcon(item.kind)} color={item.state === 'failed' ? walletColors.danger : item.state === 'pending' ? walletColors.warning : walletColors.primary} size={38} /><View style={styles.activityCopy}><Text style={styles.activityTitle}>{item.title}</Text><Text style={styles.activitySub}>{item.subtitle ?? item.timestamp ?? item.state ?? 'Activity'}</Text></View><View style={styles.activityAmount}><Text style={[styles.activityValue, item.state === 'failed' && { color: walletColors.danger }]}>{item.amount ?? '—'}</Text><Text style={styles.activitySub}>{item.state ?? ''}</Text></View></Pressable>)}
          {!activity.length ? <Text style={styles.emptyText}>Transactions and signing activity will appear here.</Text> : null}
        </Card>
      </ScrollView>
    </Screen>
  );
}

export function AccountsScreen({ accounts, selectedIndex, onSelect, onCreateAccount, onImportAccount, onBack }: AccountsScreenProps) {
  return <Screen><PageHeader title="Accounts" subtitle="Choose an account" onBack={onBack} /><ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.pageContent}><Card style={styles.listCard}>{accounts.map((account) => <Pressable key={account.index} accessibilityRole="radio" accessibilityState={{ selected: account.index === selectedIndex }} onPress={() => onSelect(account)} style={styles.accountRow}><IconBadge label={account.address} icon={<UserRound size={22} color={walletColors.white} />} color={account.index === selectedIndex ? walletColors.primary : '#8D98AD'} size={42} /><View style={styles.rowCopy}><Text style={styles.rowTitle}>Account {account.index + 1}</Text><Text style={styles.rowDescription}>{shortAddress(account.address, 8)}</Text></View><View style={[styles.radio, account.index === selectedIndex && styles.radioSelected]}>{account.index === selectedIndex ? <View style={styles.radioDot} /> : null}</View></Pressable>)}</Card><PrimaryButton title="Create New Account" onPress={onCreateAccount} style={styles.fullButton} /><SecondaryButton title="Import Account" onPress={onImportAccount} style={styles.fullButton} /></ScrollView></Screen>;
}

export function NetworksScreen({ networks, selectedId, onSelect, onAddNetwork, onBack }: NetworksScreenProps) {
  return <Screen><PageHeader title="Networks" subtitle="Select a network" onBack={onBack} right={<Pressable accessibilityRole="button" onPress={onAddNetwork}><Text style={styles.sectionLink}>＋ Add</Text></Pressable>} /><ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.pageContent}><Card style={styles.listCard}>{networks.map((network) => <Pressable key={network.id} accessibilityRole="radio" accessibilityState={{ selected: network.id === selectedId }} onPress={() => onSelect(network)} style={styles.accountRow}><IconBadge label={network.name} icon={<NetworkMark chainId={network.chainId} size={24} />} color={network.id === selectedId ? walletColors.primary : '#8D98AD'} size={42} /><View style={styles.rowCopy}><Text style={styles.rowTitle}>{network.name}</Text><Text style={styles.rowDescription}>Chain {network.chainId} · {network.nativeSymbol ?? 'ETH'}</Text></View><View style={[styles.radio, network.id === selectedId && styles.radioSelected]}>{network.id === selectedId ? <View style={styles.radioDot} /> : null}</View></Pressable>)}</Card></ScrollView></Screen>;
}

export function AssetsScreen({ network, nativeBalance, nativeFiatValue, assets = [], onSelectAsset, onAddToken, onBack }: AssetsScreenProps) {
  return <Screen><PageHeader title="Assets" subtitle={network.name} onBack={onBack} right={<Pressable accessibilityRole="button" onPress={onAddToken}><Text style={styles.sectionLink}>＋ Add Token</Text></Pressable>} /><ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.pageContent}><Card style={styles.listCard}><AssetRow chainId={network.chainId} native symbol={network.nativeSymbol ?? 'ETH'} name={network.name} amount={nativeBalance} fiat={nativeFiatValue} iconColor="#627EEA" onPress={() => onSelectAsset?.('native')} />{assets.map((asset) => <AssetRow key={asset.token.address} chainId={network.chainId} address={asset.token.address} symbol={asset.token.symbol ?? 'TOKEN'} name={asset.token.name} amount={asset.formatted} fiat={asset.fiatValue} iconColor={asset.iconColor} onPress={() => onSelectAsset?.(asset)} />)}{!assets.length ? <Text style={styles.emptyText}>No ERC-20 tokens have been added for this network.</Text> : null}</Card><Text style={styles.helperText}>Token balances are fetched from the RPC endpoint configured by the host app.</Text></ScrollView></Screen>;
}

export function SendScreen({ network, nativeSymbol, maxBalance, token, onSubmit, onBack }: SendScreenProps) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const symbol = token?.symbol ?? nativeSymbol;
  const valid = useMemo(() => Boolean(to && amount && Number(amount) > 0 && isAddress(to)), [to, amount]);
  const submit = async () => {
    if (!valid) { setError('Enter a valid recipient address and amount.'); return; }
    setError(undefined); setSubmitting(true);
    try { await onSubmit({ to, amount, token }); } catch (e) { setError(e instanceof Error ? e.message : 'Transaction could not be sent.'); } finally { setSubmitting(false); }
  };
  return <Screen><PageHeader title={`Send ${symbol}`} subtitle={network.name} onBack={onBack} /><ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.pageContent}><Card><Field label="Recipient Address" value={to} onChangeText={(value) => { setTo(value); setError(undefined); }} placeholder="0x…" keyboardType="default" /><Field label={`Amount (${symbol})`} value={amount} onChangeText={(value) => { setAmount(value); setError(undefined); }} placeholder="0.00" keyboardType="numeric" /><View style={styles.amountMeta}><Text style={styles.helperText}>{maxBalance ? `Available ${maxBalance} ${symbol}` : `Network fee will be estimated on ${network.name}`}</Text>{maxBalance ? <Pressable accessibilityRole="button" onPress={() => setAmount(maxBalance)}><Text style={styles.sectionLink}>Max</Text></Pressable> : null}</View>{error ? <Text style={styles.errorText}>{error}</Text> : null}<PrimaryButton title="Review Transaction" onPress={submit} loading={submitting} disabled={!to || !amount} style={styles.fullButton} /></Card><View style={styles.warningBox}><Text style={styles.warningTitle}>Check the Recipient</Text><Text style={styles.warningText}>Blockchain transfers are irreversible. Verify the address and network before confirming.</Text></View></ScrollView></Screen>;
}

function formatSignatureData(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => typeof entry === 'bigint' ? entry.toString() : entry, 2) ?? '';
}

const reviewTokenInterface = new Interface([
  'function approve(address spender, uint256 amount)',
  'function transfer(address to, uint256 amount)',
  'function setApprovalForAll(address operator, bool approved)',
]);

function reviewCall(data: string, zh: boolean): string {
  try {
    const call = reviewTokenInterface.parseTransaction({ data });
    if (call?.name === 'approve') return `${zh ? '授权额度' : 'Allowance'} · approve\n${zh ? '授权给' : 'Spender'}: ${call.args[0]}\n${zh ? '原始额度' : 'Raw Amount'}: ${call.args[1] === MaxUint256 ? (zh ? '无限授权' : 'Unlimited') : call.args[1].toString()}`;
    if (call?.name === 'transfer') return `${zh ? '代币转账' : 'Token Transfer'} · transfer\n${zh ? '接收地址' : 'Recipient'}: ${call.args[0]}\n${zh ? '原始数量（未换算精度）' : 'Raw Amount (Before Decimals)'}: ${call.args[1]}`;
    if (call?.name === 'setApprovalForAll') return `${zh ? '所有资产操作权限' : 'Operator Approval'} · setApprovalForAll\n${zh ? '操作地址' : 'Operator'}: ${call.args[0]}\n${zh ? '授予权限' : 'Approved'}: ${String(call.args[1])}`;
  } catch { /* Unknown and malformed calls keep the raw bytes visible. */ }
  return zh ? '未知合约调用。请核对完整调用数据，无法仅凭金额判断操作风险。' : 'Unknown contract call. Review the complete calldata; the value alone does not describe this operation.';
}

export function SignRequestScreen({ origin, account, method, message, signature, transaction, network, riskNotice, canApprove = true, onRetryPreview, loading, onApprove, onReject }: SignRequestScreenProps) {
  const { t, language } = useI18n();
  const zh = language === 'zh';
  const quantity = (value: string | undefined, unit?: 'native' | 'gwei') => {
    if (value === undefined) return t('estimated');
    try { return unit === 'native' ? `${formatEther(value)} ${network?.nativeSymbol ?? 'ETH'}` : unit === 'gwei' ? `${formatUnits(value, 'gwei')} Gwei` : BigInt(value).toString(); }
    catch { return value; }
  };
  const [busy, setBusy] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [showTypes, setShowTypes] = useState(false);
  const [actionError, setActionError] = useState('');
  const submitting = useRef(false);
  const run = async (action: () => Promise<void> | void, approve = false) => {
    if (submitting.current || loading || (approve && !canApprove)) return;
    submitting.current = true;
    setBusy(true);
    setActionError('');
    try {
      if (approve) await waitForPaint();
      await action();
    } catch { setActionError(t('approvalFailed')); }
    finally { submitting.current = false; setBusy(false); }
  };
  const isTransaction = method === 'eth_sendTransaction';
  const typedData = signature?.kind === 'typedData' ? signature.typedData : undefined;
  const displayMessage = signature?.message ?? message;
  const signatureType = method === 'personal_sign' ? 'signaturePersonalType'
    : method.startsWith('eth_signTypedData') ? 'signatureTypedType' : 'signatureRawType';
  return (
    <Screen style={styles.modalScreen}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.promptContent}>
        <IconBadge label={origin} icon={<Globe size={32} color={walletColors.white} />} color={walletColors.primary} size={56} />
        <Text style={styles.promptTitle}>{t(isTransaction ? 'confirmTransaction' : 'signRequest')}</Text>
        <Text selectable style={styles.promptOrigin}>{origin}</Text>
        <Card style={styles.promptCard}>
          <Text style={styles.promptLabel}>{t(isTransaction ? 'dappTransactionRequest' : 'dappSignatureRequest')}</Text>
          {!isTransaction ? (
            <View>
              <View style={styles.signatureMethod}>
                <Text style={styles.signatureType}>{t(signatureType)}</Text>
                <Text selectable accessibilityLabel={t('signatureMethod')} style={styles.signatureMethodValue}>{method}</Text>
              </View>
              {typedData ? (
                <View>
                  {typedData.primaryType ? <View style={styles.signatureSection}><Text style={styles.signatureLabel}>{t('signaturePrimaryType')}</Text><Text selectable style={styles.messageBox}>{typedData.primaryType}</Text></View> : null}
                  <View style={styles.signatureSection}>
                    <Text style={styles.signatureLabel}>{t('signatureDomain')}</Text>
                    <Text selectable style={styles.messageBox}>{formatSignatureData(typedData.domain)}</Text>
                  </View>
                  <View style={styles.signatureSection}>
                    <Text style={styles.signatureLabel}>{t('signatureMessage')}</Text>
                    <Text selectable style={styles.messageBox}>{formatSignatureData(typedData.message)}</Text>
                  </View>
                  <Pressable accessibilityRole="button" accessibilityState={{ expanded: showTypes }} onPress={() => setShowTypes((visible) => !visible)} style={styles.signatureDisclosure}>
                    <Text style={styles.sectionLink}>{t(showTypes ? 'signatureHideTypes' : 'signatureShowTypes')}</Text>
                    <ChevronDown size={18} color={walletColors.primary} style={showTypes ? styles.disclosureExpanded : undefined} />
                  </Pressable>
                  {showTypes ? <Text selectable style={styles.messageBox}>{formatSignatureData(typedData.types)}</Text> : null}
                </View>
              ) : signature?.kind === 'binary' ? (
                <View style={styles.signatureSection}>
                  <Text style={styles.signatureLabel}>{t('signatureMessage')}</Text>
                  <Text style={styles.signatureHint}>{t('signatureBinaryMessage')}</Text>
                  <Text selectable style={styles.messageBox}>{signature.rawMessage ?? displayMessage ?? ''}</Text>
                </View>
              ) : signature || message !== undefined ? (
                <View style={styles.signatureSection}>
                  <Text style={styles.signatureLabel}>{t('signatureMessage')}</Text>
                  <Text selectable style={styles.messageBox}>{displayMessage || t('signatureEmptyMessage')}</Text>
                  {signature?.rawMessage ? (
                    <View>
                      <Pressable accessibilityRole="button" accessibilityState={{ expanded: showRaw }} onPress={() => setShowRaw((visible) => !visible)} style={styles.signatureDisclosure}>
                        <Text style={styles.sectionLink}>{t(showRaw ? 'signatureHideRaw' : 'signatureShowRaw')}</Text>
                        <ChevronDown size={18} color={walletColors.primary} style={showRaw ? styles.disclosureExpanded : undefined} />
                      </Pressable>
                      {showRaw ? <Text selectable style={styles.messageBox}>{signature.rawMessage}</Text> : null}
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
          ) : message ? <Text selectable style={styles.messageBox}>{message}</Text> : null}
          {transaction ? (
            <View style={styles.detailList}>
              {[
                [zh ? '网络' : 'Network', network ? `${network.name} · Chain ${network.chainId}` : quantity(transaction.chainId)],
                [t('transactionTo'), transaction.to ?? (zh ? '部署新合约' : 'Deploy a contract')],
                [t('transactionValue'), quantity(transaction.value ?? '0x0', 'native')],
                [t('gasLimit'), quantity(transaction.gas)],
                ...(transaction.gasPrice !== undefined ? [[zh ? 'Gas 单价' : 'Gas Price', quantity(transaction.gasPrice, 'gwei')]] : []),
                [t('maxFee'), quantity(transaction.maxFeePerGas, 'gwei')],
                ...(transaction.maxPriorityFeePerGas !== undefined ? [[zh ? '优先费' : 'Priority Fee', quantity(transaction.maxPriorityFeePerGas, 'gwei')]] : []),
                ...(transaction.nonce !== undefined ? [['Nonce', quantity(transaction.nonce)]] : []),
                ...(transaction.type !== undefined ? [[zh ? '交易类型' : 'Transaction Type', quantity(transaction.type)]] : []),
              ].map(([label, value]) => (
                <View key={label} style={styles.detailRow}>
                  <Text style={styles.detailLabel}>{label}</Text>
                  <Text selectable style={styles.detailValue}>{value}</Text>
                </View>
              ))}
            </View>
          ) : null}
          {transaction ? <View style={styles.signatureSection}>
            <Text style={styles.signatureLabel}>{zh ? '合约调用数据' : 'Contract Call Data'}</Text>
            {transaction.data && transaction.data !== '0x' ? <>
              <Text selectable style={styles.warningText}>{reviewCall(transaction.data, zh)}</Text>
              <Text style={styles.helperText}>{zh ? '方法识别仅根据选择器，不代表合约已核验或安全。' : 'Method labels use the selector only; the contract is not verified.'}</Text>
            </> : null}
            <Text selectable style={styles.messageBox}>{transaction.data ?? '0x'}</Text>
          </View> : null}
          <View style={styles.signatureAccount}>
            <Text style={styles.detailLabel}>{t('account')}</Text>
            <Text selectable style={styles.signatureAccountValue}>{signature?.account ?? account}</Text>
          </View>
        </Card>
        {riskNotice ? <View style={styles.warningBox}><Text style={styles.warningTitle}>{t('reviewCarefully')}</Text><Text style={styles.warningText}>{riskNotice}</Text>{!canApprove && onRetryPreview ? <SecondaryButton title={t('signatureRetryPreview')} onPress={onRetryPreview} disabled={busy || loading} /> : null}</View> : null}
        {actionError ? <Text accessibilityRole="alert" style={styles.errorText}>{actionError}</Text> : null}
        {busy || loading ? <Text accessibilityLiveRegion="polite" style={styles.processingHint}>{t(isTransaction ? 'transactionProcessingHint' : 'signatureProcessingHint')}</Text> : null}
      </ScrollView>
      <View style={styles.promptFooter}>
        <SecondaryButton title={t('reject')} onPress={() => run(onReject)} disabled={busy || loading} style={styles.flexButton} />
        <PrimaryButton title={t(busy || loading ? (isTransaction ? 'submitting' : 'signing') : (isTransaction ? 'confirm' : 'sign'))} onPress={() => run(onApprove, true)} disabled={busy || loading || !canApprove} loading={busy || loading} style={styles.flexButton} />
      </View>
    </Screen>
  );
}

export function TransactionDetailScreen({ network, status, title, from, to, amount, onOpenExplorer, onBack }: TransactionDetailScreenProps) {
  const { language } = useI18n();
  const zh = language === 'zh';
  const text = zh ? { title: '交易详情', confirmed: '已确认', failed: '失败', notFound: '暂未找到', pending: '确认中', hash: '交易哈希', amount: '数量', from: '发送地址', to: '接收地址', block: '区块', confirmations: '确认数', gas: 'Gas 消耗', gasPrice: '实际 Gas 价格', fee: '网络费用', chainId: '链 ID', copy: '复制', copied: '已复制', explorer: '在区块浏览器查看' } : { title: 'Transaction Details', confirmed: 'Confirmed', failed: 'Failed', notFound: 'Not Found', pending: 'Pending', hash: 'Transaction Hash', amount: 'Amount', from: 'From', to: 'To', block: 'Block', confirmations: 'Confirmations', gas: 'Gas Used', gasPrice: 'Effective Gas Price', fee: 'Network Fee', chainId: 'Chain ID', copy: 'Copy', copied: 'Copied', explorer: 'View on Block Explorer' };
  const [copied, setCopied] = useState<string | null>(null);
  const copyValue = (key: string, value: string) => {
    Clipboard.setString(value);
    setCopied(key);
    setTimeout(() => setCopied((current) => current === key ? null : current), 2200);
  };
  const shortValue = (value: string) => value.length > 30 ? `${value.slice(0, 14)}…${value.slice(-12)}` : value;
  const gasPrice = status.effectiveGasPrice ? (() => { try { return `${formatUnits(status.effectiveGasPrice, 9)} Gwei`; } catch { return status.effectiveGasPrice; } })() : undefined;
  const networkFee = status.gasUsed && status.effectiveGasPrice ? (() => {
    try { return `${formatEther(BigInt(status.gasUsed) * BigInt(status.effectiveGasPrice))} ${network.nativeSymbol ?? 'ETH'}`; } catch { return undefined; }
  })() : undefined;
  const CopyField = ({ field, label, value }: { field: string; label: string; value: string }) => <View style={styles.transactionField}><View style={styles.transactionFieldHeader}><Text style={styles.detailLabel}>{label}</Text><Pressable accessibilityRole="button" accessibilityLabel={`${copied === field ? text.copied : text.copy} ${label}`} onPress={() => copyValue(field, value)} style={({ pressed }) => [styles.copyValueButton, pressed && styles.copyValuePressed]}><Text style={styles.copyValueText}>{copied === field ? text.copied : text.copy}</Text>{copied === field ? <Check size={15} color={walletColors.success} /> : <Copy size={15} color={walletColors.primary} />}</Pressable></View><Text selectable style={styles.transactionAddress}>{shortValue(value)}</Text></View>;
  const stateColor = status.state === 'confirmed' ? walletColors.success : status.state === 'failed' ? walletColors.danger : walletColors.warning;
  const stateLabel = status.state === 'confirmed' ? text.confirmed : status.state === 'failed' ? text.failed : status.state === 'not-found' ? text.notFound : text.pending;
  const stateHint = status.state === 'confirmed'
    ? (zh ? '交易已记录在链上，可在区块浏览器核对详情。' : 'This transaction is recorded on the blockchain. Check the block explorer for details.')
    : status.state === 'failed'
      ? (zh ? '交易执行失败，网络费用仍可能产生，请查看链上回执。' : 'The transaction failed. Network fees may still apply. Check the transaction receipt.')
      : status.state === 'not-found'
        ? (zh ? '当前节点暂未查到这笔交易，可能仍在传播，请稍后再次查看。' : 'The current node has not found this transaction yet. It may still be propagating. Check again shortly.')
        : (zh ? '正在等待链上确认，请勿重复发送这笔交易。' : 'Waiting for confirmation. Do not send this transaction again.');
  return <Screen>
    <PageHeader title={title ?? text.title} subtitle={network.name} onBack={onBack} />
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.pageContent}>
      <View style={styles.statusHero}>
        <IconBadge label={status.state === 'confirmed' ? '✓' : status.state === 'failed' ? '!' : '…'} color={stateColor} size={64} />
        <Text accessibilityLiveRegion="polite" style={[styles.statusTitle, { color: stateColor }]}>{stateLabel}</Text>
        {amount ? <Text selectable style={styles.statusAmount}>{amount}</Text> : null}
        <Text style={styles.statusHint}>{stateHint}</Text>
      </View>
      <Card style={styles.detailCard}>
        <CopyField field="hash" label={text.hash} value={status.hash} />
        {from ? <CopyField field="from" label={text.from} value={from} /> : null}
        {to ? <CopyField field="to" label={text.to} value={to} /> : null}
      </Card>
      <Card style={styles.detailCard}>
        <View style={styles.detailRow}><Text style={styles.detailLabel}>{zh ? '网络' : 'Network'}</Text><Text style={styles.detailValue}>{network.name}</Text></View>
        <View style={styles.detailRow}><Text style={styles.detailLabel}>{text.chainId}</Text><Text selectable style={styles.detailValue}>{network.chainId}</Text></View>
        <View style={styles.detailRow}><Text style={styles.detailLabel}>{text.block}</Text><Text selectable style={styles.detailValue}>{status.blockNumber ?? '—'}</Text></View>
        <View style={styles.detailRow}><Text style={styles.detailLabel}>{text.confirmations}</Text><Text style={styles.detailValue}>{status.confirmations ?? '—'}</Text></View>
        {status.gasUsed ? <View style={styles.detailRow}><Text style={styles.detailLabel}>{text.gas}</Text><Text style={styles.detailValue}>{status.gasUsed}</Text></View> : null}
        {gasPrice ? <View style={styles.detailRow}><Text style={styles.detailLabel}>{text.gasPrice}</Text><Text style={styles.detailValue}>{gasPrice}</Text></View> : null}
        {networkFee ? <View style={styles.detailRow}><Text style={styles.detailLabel}>{text.fee}</Text><Text style={styles.detailValue}>{networkFee}</Text></View> : null}
      </Card>
      {onOpenExplorer ? <SecondaryButton title={text.explorer} onPress={onOpenExplorer} style={styles.fullButton} /> : null}
    </ScrollView>
  </Screen>;
}

export function PermissionPrompt({ origin, requestedAccounts, existingAccounts = [], onApprove, onReject }: PermissionPromptProps) {
  const { t, language } = useI18n();
  const [selected, setSelected] = useState<string[]>(existingAccounts.length ? existingAccounts : requestedAccounts);
  const visibleAccounts = [...new Set(requestedAccounts)];
  const selectedAccounts = visibleAccounts.filter((account) => selected.includes(account));
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const submitting = useRef(false);
  const toggle = (account: string) => { if (!submitting.current) setSelected((value) => value.includes(account) ? value.filter((item) => item !== account) : [...value, account]); };
  const submit = async (action: () => Promise<void> | void) => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setActionError('');
    try { await action(); } catch { setActionError(t('approvalFailed')); }
    finally { submitting.current = false; setBusy(false); }
  };
  return (
    <Screen style={styles.modalScreen}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.promptContent}>
        <IconBadge label={origin} icon={<Globe size={32} color={walletColors.white} />} color="#2E70C9" size={56} />
        <Text style={styles.promptTitle}>{language === 'zh' ? '连接 DApp' : 'Connect DApp'}</Text>
        <Text selectable style={styles.promptOrigin}>{origin}</Text>
        <Card style={styles.promptCard}>
          <Text style={styles.promptLabel}>{t('chooseDappAccounts')}</Text>
          {visibleAccounts.map((account, index) => (
            <Pressable key={account} accessibilityRole="checkbox" accessibilityLabel={`${t('account')} ${index + 1}, ${account}`} accessibilityState={{ checked: selectedAccounts.includes(account), disabled: busy }} disabled={busy} onPress={() => toggle(account)} style={({ pressed }) => [styles.permissionAccount, selectedAccounts.includes(account) && styles.permissionAccountSelected, pressed && styles.permissionPressed]}>
              <IconBadge label={account} color={walletColors.primary} size={36} />
              <View style={styles.rowCopy}>
                <Text style={styles.rowTitle}>{t('account')} {index + 1}</Text>
                <Text style={styles.permissionAddress}>{account}</Text>
              </View>
              <View style={[styles.checkbox, selectedAccounts.includes(account) && styles.checkboxSelected]}>{selectedAccounts.includes(account) ? <Check size={17} color={walletColors.white} /> : null}</View>
            </Pressable>
          ))}
        </Card>
        <View style={styles.warningBox}>
          <Text style={styles.warningTitle}>{t('permissionScope')}</Text>
          <Text style={styles.warningText}>{t('dappPermissionDescription')}</Text>
        </View>
        {actionError ? <Text accessibilityRole="alert" style={styles.errorText}>{actionError}</Text> : null}
      </ScrollView>
      <View style={styles.promptFooter}>
        <SecondaryButton title={t('reject')} onPress={() => submit(onReject)} disabled={busy} style={styles.flexButton} />
        <PrimaryButton title={t('connectAccounts', { count: selectedAccounts.length })} onPress={() => { if (selectedAccounts.length) void submit(() => onApprove(selectedAccounts)); }} disabled={busy || selectedAccounts.length === 0} loading={busy} style={styles.flexButton} />
      </View>
    </Screen>
  );
}

export function DappBrowserScreen({ initialUrl, provider, onProviderRequest, allowedHosts, onBack }: DappBrowserScreenProps) {
  const { t, language } = useI18n();
  const browserRef = useRef<DappBrowserRef>(null);
  const [navigation, setNavigation] = useState<DappNavigationState>({ url: initialUrl, title: '', loading: true, canGoBack: false, canGoForward: false });
  const pageUrl = navigation.url || initialUrl;
  return <Screen style={styles.browserScreen}><View style={styles.browserHeading}>{onBack ? <DappBrowserCloseButton onClose={onBack} /> : null}<View style={styles.browserAddress}><Globe size={15} color={walletColors.textSecondary} /><Text numberOfLines={1} style={styles.browserUrl}>{pageUrl}</Text></View></View><View style={styles.browserFrame}><DappBrowser ref={browserRef} initialUrl={initialUrl} language={language} onBack={onBack} provider={provider} onProviderRequest={onProviderRequest} allowedHosts={allowedHosts} onNavigationStateChange={setNavigation} onNavigationBlocked={() => Alert.alert(t('navigationBlocked'), t('invalidDappUrl'))} /></View><DappBrowserToolbar navigation={navigation} onGoBack={() => browserRef.current?.goBack()} onGoForward={() => browserRef.current?.goForward()} onReload={() => browserRef.current?.reload()} /></Screen>;
}

export type { TransactionStatus };

const styles = StyleSheet.create({
  homeScreen: { paddingHorizontal: 0 },
  scrollContent: { paddingHorizontal: walletSpacing.lg, paddingBottom: walletSpacing.xxl },
  homeHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: walletSpacing.lg },
  identityButton: { flexDirection: 'row', alignItems: 'center', gap: walletSpacing.sm, flexShrink: 1 },
  identityName: { ...walletTypography.bodyMedium, color: walletColors.ink },
  identityAddress: { ...walletTypography.caption, color: walletColors.textSecondary, marginTop: 1 },
  downChevron: { color: walletColors.textSecondary, fontSize: 17, marginLeft: 3 },
  networkPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: walletColors.surface, borderRadius: walletRadii.pill, paddingHorizontal: walletSpacing.md, paddingVertical: walletSpacing.sm, borderWidth: 1, borderColor: walletColors.border, maxWidth: 150 },
  networkDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: walletColors.success, marginRight: walletSpacing.sm },
  networkPillText: { ...walletTypography.caption, color: walletColors.ink, flexShrink: 1 },
  balanceCard: { backgroundColor: walletColors.primary, borderColor: walletColors.primary, marginBottom: walletSpacing.lg },
  balanceCaption: { ...walletTypography.caption, color: 'rgba(255,255,255,0.76)' },
  balanceValue: { color: walletColors.white, fontSize: 30, lineHeight: 38, fontWeight: '700', marginTop: walletSpacing.xs },
  balanceFiat: { color: 'rgba(255,255,255,0.78)', ...walletTypography.body, marginTop: 2 },
  addressPill: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.16)', borderRadius: walletRadii.pill, paddingHorizontal: walletSpacing.md, paddingVertical: walletSpacing.sm, marginTop: walletSpacing.lg },
  addressText: { color: walletColors.white, ...walletTypography.mono },
  copyIcon: { color: walletColors.white, marginLeft: walletSpacing.sm },
  actionGrid: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: walletSpacing.xl },
  actionButton: { alignItems: 'center', gap: walletSpacing.xs, padding: walletSpacing.sm },
  actionLabel: { ...walletTypography.caption, color: walletColors.ink },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: walletSpacing.sm, marginTop: walletSpacing.md },
  sectionTitle: { ...walletTypography.bodyMedium, color: walletColors.ink },
  sectionLink: { ...walletTypography.caption, color: walletColors.primary, fontWeight: '700' },
  listCard: { paddingVertical: walletSpacing.sm },
  emptyText: { ...walletTypography.body, color: walletColors.textSecondary, textAlign: 'center', paddingVertical: walletSpacing.lg },
  activityRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: walletSpacing.sm, paddingVertical: walletSpacing.md, gap: walletSpacing.md },
  activityCopy: { flex: 1 },
  activityTitle: { ...walletTypography.bodyMedium, color: walletColors.ink },
  activitySub: { ...walletTypography.caption, color: walletColors.textSecondary, marginTop: 2 },
  activityAmount: { alignItems: 'flex-end' },
  activityValue: { ...walletTypography.bodyMedium, color: walletColors.ink },
  pageContent: { paddingBottom: walletSpacing.xxl },
  fullButton: { marginTop: walletSpacing.md },
  accountRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: walletSpacing.md, gap: walletSpacing.md },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: walletColors.border, alignItems: 'center', justifyContent: 'center' },
  radioSelected: { borderColor: walletColors.primary },
  radioDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: walletColors.primary },
  helperText: { ...walletTypography.caption, color: walletColors.textSecondary },
  amountMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: -walletSpacing.sm, marginBottom: walletSpacing.md },
  errorText: { ...walletTypography.caption, color: walletColors.danger, marginBottom: walletSpacing.sm },
  warningBox: { backgroundColor: walletColors.warningSoft, borderRadius: walletRadii.md, padding: walletSpacing.md, marginTop: walletSpacing.lg },
  warningTitle: { ...walletTypography.bodyMedium, color: walletColors.warning, marginBottom: walletSpacing.xs },
  warningText: { ...walletTypography.caption, color: walletColors.warning, lineHeight: 20 },
  modalScreen: { backgroundColor: walletColors.background },
  promptContent: { flexGrow: 1, alignItems: 'center', paddingTop: walletSpacing.md, paddingBottom: walletSpacing.md },
  promptTitle: { ...walletTypography.title, alignSelf: 'stretch', color: walletColors.ink, textAlign: 'center', marginTop: walletSpacing.lg },
  promptOrigin: { ...walletTypography.body, alignSelf: 'stretch', color: walletColors.textSecondary, textAlign: 'center', marginTop: walletSpacing.sm, marginBottom: walletSpacing.lg },
  promptCard: { width: '100%' },
  promptLabel: { ...walletTypography.bodyMedium, color: walletColors.ink, marginBottom: walletSpacing.md },
  messageBox: { ...walletTypography.mono, color: walletColors.ink, backgroundColor: walletColors.surfaceMuted, borderRadius: walletRadii.sm, padding: walletSpacing.md, marginBottom: walletSpacing.md },
  signatureMethod: { marginBottom: walletSpacing.md, gap: walletSpacing.xs },
  signatureType: { ...walletTypography.caption, color: '#d4cbff', alignSelf: 'flex-start', backgroundColor: walletColors.primarySoft, paddingHorizontal: walletSpacing.sm, paddingVertical: walletSpacing.xs, borderRadius: walletRadii.sm },
  signatureMethodValue: { ...walletTypography.mono, color: walletColors.textSecondary },
  signatureSection: { marginTop: walletSpacing.sm },
  signatureLabel: { ...walletTypography.bodyMedium, color: walletColors.ink, marginBottom: walletSpacing.sm },
  signatureHint: { ...walletTypography.caption, color: walletColors.textSecondary, marginBottom: walletSpacing.sm },
  processingHint: { ...walletTypography.caption, color: walletColors.textSecondary, textAlign: 'center', marginTop: walletSpacing.md },
  signatureDisclosure: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, marginBottom: walletSpacing.sm, gap: walletSpacing.sm },
  disclosureExpanded: { transform: [{ rotate: '180deg' }] },
  signatureAccount: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: walletColors.border, paddingTop: walletSpacing.md, gap: walletSpacing.sm },
  signatureAccountValue: { ...walletTypography.mono, color: walletColors.ink },
  detailList: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: walletColors.border, marginTop: walletSpacing.sm, paddingTop: walletSpacing.sm },
  detailCard: { marginBottom: walletSpacing.lg },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: walletSpacing.sm, gap: walletSpacing.md },
  detailLabel: { ...walletTypography.body, color: walletColors.textSecondary, flexShrink: 1 },
  detailValue: { ...walletTypography.bodyMedium, minWidth: 0, maxWidth: '65%', color: walletColors.ink, textAlign: 'right', flexShrink: 1 },
  promptActions: { flexDirection: 'row', width: '100%', gap: walletSpacing.md, marginTop: walletSpacing.xl },
  promptFooter: { flexDirection: 'row', gap: walletSpacing.md, paddingTop: walletSpacing.md, paddingBottom: walletSpacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: walletColors.border, backgroundColor: walletColors.background },
  flexButton: { flex: 1, minWidth: 0 },
  statusHero: { alignItems: 'center', paddingVertical: walletSpacing.lg },
  statusTitle: { ...walletTypography.heading, marginTop: walletSpacing.md },
  statusAmount: { fontSize: 28, lineHeight: 38, fontWeight: '700', color: walletColors.ink, textAlign: 'center', alignSelf: 'stretch', marginTop: walletSpacing.md },
  statusHint: { ...walletTypography.caption, maxWidth: 360, color: walletColors.textSecondary, textAlign: 'center', lineHeight: 20, marginTop: walletSpacing.sm },
  transactionField: { gap: walletSpacing.sm, paddingVertical: walletSpacing.md },
  transactionFieldHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: walletSpacing.sm },
  copyValueButton: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: walletSpacing.sm, borderRadius: walletRadii.sm, backgroundColor: walletColors.primarySoft },
  copyValuePressed: { opacity: 0.72 },
  copyValueText: { ...walletTypography.caption, color: walletColors.primary, fontWeight: '700' },
  transactionAddress: { ...walletTypography.mono, color: walletColors.ink, lineHeight: 22 },
  permissionAccount: { flexDirection: 'row', alignItems: 'center', padding: walletSpacing.md, gap: walletSpacing.md, borderWidth: 1, borderColor: walletColors.border, borderRadius: walletRadii.md, marginTop: walletSpacing.sm },
  permissionAccountSelected: { borderColor: walletColors.primary, backgroundColor: walletColors.primarySoft },
  permissionAddress: { ...walletTypography.mono, color: walletColors.textSecondary, marginTop: walletSpacing.xs, lineHeight: 19 },
  permissionPressed: { opacity: 0.75 },
  browserScreen: { paddingHorizontal: 0 },
  browserHeading: { flexDirection: 'row', alignItems: 'center', gap: walletSpacing.sm, paddingHorizontal: walletSpacing.md, paddingVertical: walletSpacing.sm, backgroundColor: walletColors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: walletColors.border },
  browserAddress: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: walletSpacing.sm, backgroundColor: walletColors.background, borderRadius: walletRadii.md, paddingHorizontal: walletSpacing.md },
  browserUrl: { flex: 1, ...walletTypography.caption, color: walletColors.ink },
  browserFrame: { flex: 1, overflow: 'hidden', backgroundColor: walletColors.surface },
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 1.5, borderColor: walletColors.border, alignItems: 'center', justifyContent: 'center' },
  checkboxSelected: { borderColor: walletColors.primary, backgroundColor: walletColors.primary },
  checkboxTick: { color: walletColors.white, fontWeight: '700' },
  rowCopy: primitiveStyles.rowCopy,
  rowTitle: primitiveStyles.rowTitle,
  rowDescription: primitiveStyles.rowDescription,
});
