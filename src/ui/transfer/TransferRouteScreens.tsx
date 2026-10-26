import React, { useEffect, useState } from "react";
import { Linking, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { formatUnits } from "ethers";
import { useI18n } from "../../i18n.js";
import { TransactionDetailScreen } from "../screens.js";
import { ReceiveScreen } from "../ReceiveScreen.js";
import { SendFlowScreen } from "../TransferScreens.js";
import { LoadingScreen } from "../AppSimpleScreens.js";
import { styles } from "../appStyles.js";
import { PrimaryButton } from "../AuthPrimitives.js";
import { useWalletContext } from "../../context/WalletContext.js";
import { saveTransaction } from "../../native/transaction-storage.js";
import type { TransactionStatus } from "../../core/types.js";
import type { ScreenProps } from "../../navigation/types.js";

/** Route adapter for the stateful transfer flow. Keeps navigation concerns out of the form UI. */
export function SendScreen({ route, navigation }: ScreenProps<"Send">) {
  const { core, selectedAccountIndex, selectedNetworkId, manager } =
    useWalletContext();
  const { t } = useI18n();
  if (!core) return <LoadingScreen />;
  if (core.isWatchOnly()) {
    return (
      <SafeAreaView style={[styles.safe, styles.center]}>
        <Text style={styles.heroText}>{t("watchOnly")}</Text>
        <PrimaryButton title={t("back")} onPress={() => navigation.goBack()} />
      </SafeAreaView>
    );
  }
  const networkId = route.params?.networkId ?? selectedNetworkId;
  const accountIndex = route.params?.accountIndex ?? selectedAccountIndex;
  const network = core.getNetwork(networkId);
  return (
    <SendFlowScreen
      core={core}
      accountIndex={accountIndex}
      network={network}
      walletName={manager.getSelected()?.label}
      initialAssetAddress={route.params?.assetAddress}
      onBack={() => navigation.goBack()}
      onSubmitted={(hash, record) =>
        navigation.replace("Transaction", { hash, networkId, accountIndex, record })
      }
    />
  );
}

/** Route adapter that refreshes a submitted transaction until it reaches a terminal state. */
export function TransactionRouteScreen({
  route,
  navigation,
}: ScreenProps<"Transaction">) {
  const { core, selectedAccountIndex, selectedNetworkId } = useWalletContext();
  const record = route.params.record;
  // A history row carries the chain id with its record. Prefer the route's
  // network when it still belongs to that chain, otherwise resolve the
  // network from the record before falling back to the currently selected
  // network. This prevents opening an old history item after a network switch
  // from querying the same hash on the wrong chain.
  const availableNetworks = core && typeof core.listNetworks === "function"
    ? core.listNetworks()
    : [];
  const requestedNetwork = route.params.networkId
    ? availableNetworks.find((entry) => entry.id === route.params.networkId)
    : undefined;
  const recordNetwork = record
    ? availableNetworks.find((entry) => entry.chainId === record.chainId)
    : undefined;
  const network = requestedNetwork && (!record || requestedNetwork.chainId === record.chainId)
    ? requestedNetwork
    : recordNetwork ?? core?.getNetwork(selectedNetworkId);
  const networkId = network?.id ?? route.params.networkId ?? selectedNetworkId;
  const accountIndex = route.params.accountIndex ?? selectedAccountIndex;
  const [status, setStatus] = useState<TransactionStatus>({
    hash: route.params.hash,
    state: record?.state ?? "pending",
    blockNumber: record?.blockNumber,
  });

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let terminal = record?.state === "confirmed" || record?.state === "failed";
    let timer: ReturnType<typeof setInterval> | undefined;
    const refresh = async () => {
      if (!core || inFlight) return;
      inFlight = true;
      try {
        const next = await core.getTransactionStatus(networkId, route.params.hash);
        if (
          active &&
          // Indexers can show a mined transaction before a public RPC node has
          // caught up (or when that node has a pruned history). Keep a terminal
          // state already supplied by the history record instead of replacing
          // it with a misleading transient `not-found` result.
          !((record?.state === "confirmed" || record?.state === "failed") && (next.state === "pending" || next.state === "not-found"))
        ) {
          setStatus({ ...next, blockNumber: next.blockNumber ?? record?.blockNumber });
          if (next.state === "confirmed" || next.state === "failed") {
            terminal = true;
            if (timer !== undefined) clearInterval(timer);
            // Only the opened transaction is checked. Persist its local status
            // so the history subscription can update without another RPC read.
            if (record?.source === "local" && record.hash.toLowerCase() === next.hash.toLowerCase() && record.chainId === network?.chainId) {
              void saveTransaction({ ...record, state: next.state, blockNumber: next.blockNumber ?? record.blockNumber }).catch(() => undefined);
            }
          }
        }
      } catch {
        // Retain the last known state while the node is unavailable. History
        // indexers can still provide a terminal state even when the selected
        // RPC cannot answer a detail lookup.
        if (active && (record?.state === "confirmed" || record?.state === "failed")) {
          setStatus((previous) => ({
            ...previous,
            state: record.state,
            blockNumber: previous.blockNumber ?? record.blockNumber,
          }));
        }
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    if (!terminal) timer = setInterval(() => { void refresh(); }, 8_000);
    return () => {
      active = false;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [core, route.params.hash, networkId, record, network?.chainId]);

  if (!core) return <LoadingScreen />;
  if (!network) return <LoadingScreen />;
  return (
    <TransactionDetailScreen
      network={network}
      status={status}
      from={record?.from ?? core.getAccount(accountIndex).address}
      to={record?.to}
      amount={
        record
          ? `${formatUnits(record.rawValue, record.decimals)} ${record.symbol}`
          : undefined
      }
      onBack={() => navigation.goBack()}
      onOpenExplorer={
        network.explorerUrl
          ? () => {
              void Linking.openURL(
                `${network.explorerUrl!.replace(/\/$/, "")}/tx/${route.params.hash}`,
              ).catch(() => undefined);
            }
          : undefined
      }
    />
  );
}

/** Route adapter for the receive screen, resolving account and network defaults from wallet context. */
export function ReceiveRouteScreen({ navigation, route }: ScreenProps<"Receive">) {
  const { core, selectedAccountIndex, selectedNetworkId, manager } =
    useWalletContext();
  if (!core) return <LoadingScreen />;
  const networkId = route.params?.networkId ?? selectedNetworkId;
  const accountIndex = route.params?.accountIndex ?? selectedAccountIndex;
  return (
    <ReceiveScreen
      account={core.getAccount(accountIndex)}
      network={core.getNetwork(networkId)}
      token={route.params?.token}
      walletName={manager.getSelected()?.label}
      onBack={() => navigation.goBack()}
      onChangeAccount={
        route.params?.accountIndex === undefined
          ? () => navigation.navigate("Accounts")
          : undefined
      }
      onChangeNetwork={
        route.params?.networkId === undefined
          ? () => navigation.navigate("Networks")
          : undefined
      }
    />
  );
}
