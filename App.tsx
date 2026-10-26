import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { colors, styles } from "./src/ui/appStyles.js";
import { DreamKeyLogo } from "./src/ui/DreamKeyLogo.js";
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import { SecureModal as Modal } from './src/ui/SecureModal.js';
import { useFocusEffect } from "@react-navigation/native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  LockKeyhole,
  Star,
  KeyRound,
  Eye,
  EyeOff,
  ShieldCheck,
  FileKey,
  Check,
} from "./src/ui/icons.js";
import {
  PermissionPrompt,
  SignRequestScreen,
  WalletCore,
  WalletManager,
  PermissionManager,
  createWalletProvider,
  evaluateDappUrl,
  type AccountInfo,
  type DappBrowserRef,
  type NetworkConfig,
} from "./src/index.js";
import {
  ReactNativeDappBrowserStorage,
  ReactNativeKeychainBiometricAuthenticator,
  ReactNativeKeychainVaultStorage,
  ReactNativeLanguageStorage,
  ReactNativeWalletPasswordVerifier,
  ReactNativeWalletManagerStorage,
} from "./src/native/keychain.js";
import { I18nProvider, useI18n, type LanguageCode } from "./src/i18n.js";
import type { RequestArguments } from "./src/provider/types.js";
import { getSignaturePreview } from "./src/provider/signing-payload.js";
import type {
  DappNavigationState,
  DappPageMetadata,
  ProviderRequestContext,
} from "./src/dapp/types.js";
import { refreshDappFavicon } from "./src/dapp/favicon-cache.js";
import { DappLandingScreen } from "./src/ui/DappLandingScreen.js";
import {
  loadAccountCount,
  saveAccountCount,
} from "./src/native/account-storage.js";
import { saveTransaction } from "./src/native/transaction-storage.js";
import { DEFAULT_NETWORKS } from "./src/core/networks.js";
import { WalletSessionGuard } from "./src/core/session-guard.js";
import { subscribeAppVisibility } from "./src/native/app-visibility.js";
import { waitForPaint } from "./src/ui/feedback.js";
import {
  AboutRouteScreen as ExtractedAboutRouteScreen,
  LanguageSettingsScreen as ExtractedLanguageSettingsScreen,
  LoadingScreen,
  SettingsRow,
  SettingsScreen as ExtractedSettingsScreen,
} from "./src/ui/AppSimpleScreens.js";
import { WalletManagementScreen } from "./src/ui/screens/WalletManagementScreen.js";
import { NetworkRouteScreen } from "./src/ui/NetworkRouteScreen.js";
import { RpcRouteScreen } from "./src/ui/RpcRouteScreen.js";
import { DappBrowserRouteView } from "./src/ui/dapp/DappBrowserRouteView.js";
import {
  BrandHeader,
  Field,
  PageHeader,
  PrimaryButton,
} from "./src/ui/AuthPrimitives.js";
import { type ScreenProps } from "./src/navigation/types.js";
import { AppNavigator } from "./src/navigation/AppNavigator.js";
import { UpdateProvider } from "./src/updates/UpdateProvider.js";
import { InviteFriendsRouteScreen } from "./src/ui/invite/InviteFriendsRouteScreen.js";
import {
  WalletContext,
  type PendingApproval,
  type WalletContextValue,
  useWalletContext,
} from "./src/context/WalletContext.js";
import {
  SendScreen,
  ReceiveRouteScreen,
  TransactionRouteScreen,
} from "./src/ui/transfer/TransferRouteScreens.js";
import {
  HomeRouteScreen,
  AssetsRouteScreen,
  AssetRouteScreen,
} from "./src/ui/wallet/WalletRouteScreens.js";

/**
 * App shell for the React Native CLI wallet. RPC endpoints are app supplied;
 * replace these values with your own infrastructure before shipping.
 */
export { DEFAULT_NETWORKS };



function shorten(address: string, left = 6, right = 4): string {
  return `${address.slice(0, left)}…${address.slice(-right)}`;
}

function WelcomeScreen({ navigation }: ScreenProps<"Welcome">) {
  const { t, language } = useI18n();
  const { storage, managerStorage, passwordVerifier, biometric, session } =
    useWalletContext();
  const [ready, setReady] = useState(false);
  const [hasExistingWallet, setHasExistingWallet] = useState<boolean | null>(
    null,
  );
  const [error, setError] = useState("");
  const [presenceCheck, setPresenceCheck] = useState(0);
  const [preparingFor, setPreparingFor] = useState<"Create" | "Import" | null>(null);
  const preparing = useRef(false);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setReady(false);
      setHasExistingWallet(null);
      setError("");
      void Promise.all([storage.hasWallet(), managerStorage.hasWallet()])
        .then(([vault, collection]) => {
          if (!active) return;
          const existing = Boolean(vault || collection);
          setHasExistingWallet(existing);
          if (existing) navigation.replace("Unlock");
          else setReady(true);
        })
        .catch(() => {
          if (active) {
            setHasExistingWallet(false);
            setError(t("unableToUnlock"));
          }
        });
      return () => {
        active = false;
      };
    }, [managerStorage, navigation, presenceCheck, storage, t]),
  );
  const begin = async (next: "Create" | "Import") => {
    if (!ready || preparing.current) return;
    preparing.current = true;
    setPreparingFor(next);
    setError("");
    const generation = session.capture();
    try {
      const [configured, enabled, available] = await Promise.all([
        passwordVerifier.isConfigured(),
        passwordVerifier.isBiometricEnabled(),
        biometric.isAvailable(),
      ]);
      session.assertCurrent(generation);
      if (configured || (enabled && available)) navigation.navigate(next);
      else navigation.navigate("WalletSetup", { next });
    } catch {
      setError(t("unableToUnlock"));
    } finally {
      preparing.current = false;
      setPreparingFor(null);
    }
  };
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />
      <ScrollView contentContainerStyle={styles.authContainer} showsVerticalScrollIndicator={false}>
        <BrandHeader title="DreamKey" subtitle={t("brandSubtitle")} />
        <View style={styles.heroIcon}>
          <ShieldCheck size={60} color={colors.accentBright} />
        </View>
        <Text style={styles.heroTitle}>{t("simpleSecureWallet")}</Text>
        <Text style={styles.heroText}>{t("welcomeDescription")}</Text>
        <View style={styles.authSpacer} />
        {error ? <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text> : null}
        {!ready && error ? <PrimaryButton
          title={language === "zh" ? "重试" : "Try Again"}
          variant="secondary"
          onPress={() => setPresenceCheck((value) => value + 1)}
        /> : null}
        <PrimaryButton
          title={t("createNewWallet")}
          loading={(!ready && !error) || preparingFor === "Create"}
          disabled={!ready || preparingFor !== null}
          onPress={() => {
            void begin("Create");
          }}
        />
        <PrimaryButton
          title={t("importWallet")}
          variant="secondary"
          loading={preparingFor === "Import"}
          disabled={!ready || preparingFor !== null}
          onPress={() => {
            void begin("Import");
          }}
        />
        {hasExistingWallet ? (
          <Pressable
            accessibilityRole="button"
            style={styles.linkButton}
            onPress={() => navigation.navigate("Unlock")}
          >
            <Text style={styles.linkText}>{t("unlockExistingWallet")}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function WalletSetupScreen({ navigation, route }: ScreenProps<"WalletSetup">) {
  const { t } = useI18n();
  const { passwordVerifier, storage, managerStorage, session } = useWalletContext();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !busy });
  }, [busy, navigation]);
  useFocusEffect(
    useCallback(() => {
      const listener = BackHandler.addEventListener(
        "hardwareBackPress",
        () => saving.current,
      );
      return () => listener.remove();
    }, []),
  );
  const save = async () => {
    if (saving.current) return;
    if (password.trim().length < 6) {
      setError(t("passwordMinLength"));
      return;
    }
    if (password !== confirm) {
      setError(t("passwordMismatch"));
      return;
    }
    saving.current = true;
    const generation = session.capture();
    setBusy(true);
    setError("");
    try {
      await waitForPaint();
      session.assertCurrent(generation);
      if ((await storage.hasWallet()) || (await managerStorage.hasWallet())) throw new Error('Wallet already exists');
      session.assertCurrent(generation);
      await passwordVerifier.setPassword(password, () => session.isCurrent(generation));
      session.assertCurrent(generation);
      await passwordVerifier.setPasswordMode(true);
      await passwordVerifier.setBiometricEnabled(false);
      storage.setPasswordMode(true);
      managerStorage.setPasswordMode(true);
      storage.setBiometricEnabled(false);
      managerStorage.setBiometricEnabled(false);
      setPassword("");
      setConfirm("");
      Keyboard.dismiss();
      navigation.replace(route.params.next);
    } catch {
      setError(t("unableToSaveWallet"));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.pageScroll}
        >
          <BrandHeader title="DreamKey" subtitle={t("walletPassword")} />
          <PageHeader
            title={t("walletPassword")}
            disabled={busy}
            onBack={() => {
              if (!saving.current) navigation.goBack();
            }}
          />
          <View style={styles.setupIcon}>
            <LockKeyhole size={34} color={colors.accentBright} />
          </View>
          <Text style={styles.bodyText}>{t("firstPasswordSetup")}</Text>
          <Field
            editable={!busy}
            label={t("walletPassword")}
            value={password}
            onChangeText={(value) => {
              setPassword(value);
              setError("");
            }}
            secureTextEntry
            placeholder={t("passwordPlaceholder")}
          />
          <Field
            editable={!busy}
            label={t("confirmPassword")}
            value={confirm}
            onChangeText={(value) => {
              setConfirm(value);
              setError("");
            }}
            secureTextEntry
            placeholder={t("confirmPasswordPlaceholder")}
            returnKeyType="done"
            onSubmitEditing={() => { if (password && confirm) void save(); }}
          />
          {error ? (
            <Text accessibilityRole="alert" style={styles.errorText}>
              {error}
            </Text>
          ) : null}
          <PrimaryButton
            title={t("continueToWallet")}
            loading={busy}
            disabled={busy || !password || !confirm}
            onPress={() => {
              void save();
            }}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

async function restoreWallet(
  value: string,
  storage: ReactNativeKeychainVaultStorage,
  biometric: ReactNativeKeychainBiometricAuthenticator,
  passwordVerifier: ReactNativeWalletPasswordVerifier,
  session: WalletSessionGuard,
  generation: number,
): Promise<WalletCore> {
  const options = {
    networks: DEFAULT_NETWORKS,
    storage,
    biometric,
    passwordVerifier,
    transactionRecorder: saveTransaction,
  };
  const wallet = WalletCore.fromSerializedVault(value, options);
  if (!wallet.canDeriveAccounts()) return wallet;
  const forget = session.onInvalidate(() => wallet.vault.forget());
  try {
    const accountCount = await loadAccountCount(wallet.getAccount(0).address);
    session.assertCurrent(generation);
    return accountCount === 1
      ? wallet
      : WalletCore.fromVault(wallet.vault, { ...options, accountCount });
  } finally { forget(); }
}

const creationLayoutStyles = StyleSheet.create({
  wordTwoColumns: { width: "48%" },
  wordSingleColumn: { width: "100%" },
  wrapSlots: { flexWrap: "wrap" },
  slotFixedWidth: { flex: 0, paddingVertical: 10 },
  slotWord: { textAlign: "center" },
});

function CreateScreen({ navigation, route: _route }: ScreenProps<"Create">) {
  const { t } = useI18n();
  const { width, fontScale } = useWindowDimensions();
  const [phraseGridWidth, setPhraseGridWidth] = useState<number | null>(null);
  const availableWidth = phraseGridWidth ?? Math.max(0, width - 40);
  // Reserve room for the longest English BIP39 words and the card's padding.
  const minimumWordWidth = 76 * fontScale + 12;
  const wordLayout = availableWidth * 0.31 >= minimumWordWidth
    ? undefined
    : availableWidth * 0.48 >= minimumWordWidth
      ? creationLayoutStyles.wordTwoColumns
      : creationLayoutStyles.wordSingleColumn;
  const { storage, biometric, passwordVerifier, setCreationCore } =
    useWalletContext();
  const [core] = useState(() =>
    WalletCore.create({
      networks: DEFAULT_NETWORKS,
      storage,
      biometric,
      passwordVerifier,
      transactionRecorder: saveTransaction,
    }),
  );
  useFocusEffect(useCallback(() => { setCreationCore(core); }, [core, setCreationCore]));
  const phrase = core.getMnemonic();
  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.authScroll}>
        <BrandHeader title="DreamKey" subtitle={t("secretRecoveryPhrase")} />
        <PageHeader
          title={t("secretRecoveryPhrase")}
          onBack={() => {
            setCreationCore(null);
            core.vault.forget();
            navigation.goBack();
          }}
        />
        <Text style={styles.bodyText}>{t("recoveryPhraseHint")}</Text>
        <Text style={styles.bodyText}>{t("recoveryPhraseWarning")}</Text>
        <View
          style={styles.phraseGrid}
          onLayout={(event) => {
            const measuredWidth = event.nativeEvent.layout.width;
            if (measuredWidth > 0) setPhraseGridWidth(measuredWidth);
          }}
        >
          {phrase.split(" ").map((word, index) => (
            <View key={`${word}-${index}`} style={[styles.word, wordLayout]}>
              <Text style={styles.wordIndex}>{index + 1}</Text>
              <Text style={styles.wordText}>{word}</Text>
            </View>
          ))}
        </View>
        <View style={styles.authSpacer} />
        <PrimaryButton
          title={t("verifyRecoveryPhrase")}
          onPress={() => {
            setCreationCore(core);
            navigation.navigate("CreateVerify");
          }}
        />
        <Pressable
          style={styles.linkButton}
          onPress={() => {
            setCreationCore(null);
            core.vault.forget();
            navigation.goBack();
          }}
        >
          <Text style={styles.linkText}>{t("back")}</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function CreateVerifyScreen({ navigation }: ScreenProps<"CreateVerify">) {
  const { t } = useI18n();
  const { width, fontScale } = useWindowDimensions();
  const [slotGridWidth, setSlotGridWidth] = useState<number | null>(null);
  const [choiceGridWidth, setChoiceGridWidth] = useState<number | null>(null);
  const wordLayoutForWidth = (measuredWidth: number | null) => {
    const availableWidth = measuredWidth ?? Math.max(0, width - 40);
    const minimumWordWidth = 76 * fontScale + 12;
    return availableWidth * 0.31 >= minimumWordWidth
      ? undefined
      : availableWidth * 0.48 >= minimumWordWidth
        ? creationLayoutStyles.wordTwoColumns
        : creationLayoutStyles.wordSingleColumn;
  };
  const slotWordLayout = wordLayoutForWidth(slotGridWidth);
  const choiceWordLayout = wordLayoutForWidth(choiceGridWidth);
  const {
    creationCore,
    setCreationCore,
    setCore,
    setRevision,
    setSelectedAccountIndex,
    manager,
    session,
  } = useWalletContext();
  useEffect(
    () => () => {
      setCreationCore(null);
    },
    [setCreationCore],
  );
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const creating = useRef(false);
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !busy });
  }, [busy, navigation]);
  useFocusEffect(
    useCallback(() => {
      const listener = BackHandler.addEventListener(
        "hardwareBackPress",
        () => creating.current,
      );
      return () => listener.remove();
    }, []),
  );
  const phrase = creationCore?.getMnemonic() ?? "";
  const verificationIndexes = useMemo(() => {
    const words = phrase.split(" ").filter(Boolean);
    const selected = new Set<number>();
    const count = Math.min(3, words.length);
    while (selected.size < count)
      selected.add(Math.floor(Math.random() * words.length));
    return [...selected].sort((left, right) => left - right);
  }, [phrase]);
  const [verification, setVerification] = useState<Record<number, string>>({});
  const [activePosition, setActivePosition] = useState(0);
  const verificationChoices = useMemo(() => {
    const words = phrase.split(" ").filter(Boolean);
    const required = [
      ...new Set(verificationIndexes.map((index) => words[index])),
    ];
    const others = [...new Set(words)].filter(
      (word) => !required.includes(word),
    );
    const shuffle = (items: string[]) => {
      const shuffled = [...items];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(Math.random() * (index + 1));
        [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
      }
      return shuffled;
    };
    return shuffle([
      ...required,
      ...shuffle(others).slice(0, Math.max(0, 6 - required.length)),
    ]);
  }, [phrase, verificationIndexes]);
  const chooseWord = (word: string) => {
    if (creating.current || activePosition < 0) return;
    const index = verificationIndexes[activePosition];
    if (index === undefined) return;
    const next = { ...verification, [index]: word };
    setVerification(next);
    setError("");
    setActivePosition(
      verificationIndexes.findIndex((position) => !next[position]),
    );
  };
  const resetVerification = () => {
    if (creating.current) return;
    setVerification({});
    setActivePosition(0);
    setError("");
  };
  const finish = async () => {
    if (!creationCore || creating.current) return;
    const words = phrase.split(" ");
    const verified = verificationIndexes.every(
      (index) =>
        verification[index]?.trim().toLowerCase() ===
        words[index].toLowerCase(),
    );
    if (!confirmed || !verified) {
      if (confirmed && !verified)
        setError(t("recoveryPhraseVerificationFailed"));
      return;
    }
    creating.current = true;
    const generation = session.capture();
    setBusy(true);
    setError("");
    try {
      await waitForPaint();
      session.assertCurrent(generation);
      const existing = manager
        .list()
        .find(
          (wallet) =>
            wallet.address.toLowerCase() ===
            creationCore.getAccount(0).address.toLowerCase(),
        );
      const record =
        existing ?? (await manager.addCoreAndPersist(creationCore));
      await manager.selectAndPersist(record.id);
      session.assertCurrent(generation);
      await saveAccountCount(
        creationCore.getAccount(0).address,
        creationCore.listAccounts().length,
      );
      await creationCore.vault.persist();
      session.assertCurrent(generation);
      setSelectedAccountIndex(0);
      setCore(creationCore);
      setCreationCore(null);
      setRevision((value) => value + 1);
      navigation.reset({ index: 0, routes: [{ name: "Main" }] });
    } catch {
      setError(t("unableToSaveWallet"));
    } finally {
      creating.current = false;
      setBusy(false);
    }
  };
  if (!creationCore)
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <Text style={styles.heroText}>{t("unableToSaveWallet")}</Text>
          <PrimaryButton
            title={t("back")}
            onPress={() => navigation.goBack()}
          />
        </View>
      </SafeAreaView>
    );
  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.authScroll}
        showsVerticalScrollIndicator={false}
      >
        <BrandHeader title="DreamKey" subtitle={t("verifyRecoveryPhrase")} />
        <PageHeader
          title={t("verifyRecoveryPhrase")}
          disabled={busy}
          onBack={() => {
            if (!creating.current) {
              setCreationCore(null);
              navigation.goBack();
            }
          }}
        />
        <Text style={styles.bodyText}>{t("verifyRecoveryPhraseHint")}</Text>
        <View
          style={[styles.verifySlots, slotWordLayout && creationLayoutStyles.wrapSlots]}
          onLayout={(event) => {
            const measuredWidth = event.nativeEvent.layout.width;
            if (measuredWidth > 0) setSlotGridWidth(measuredWidth);
          }}
        >
          {verificationIndexes.map((index, position) => (
            <Pressable
              key={index}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={t("verifyWord", { number: index + 1 })}
              accessibilityState={{
                selected: activePosition === position,
                disabled: busy,
              }}
              style={[
                styles.verifySlot,
                slotWordLayout && creationLayoutStyles.slotFixedWidth,
                slotWordLayout,
                verification[index] && styles.verifySlotFilled,
                activePosition === position && styles.verifySlotActive,
              ]}
              onPress={() => {
                if (!creating.current) {
                  setActivePosition(position);
                  setError("");
                }
              }}
            >
              <Text style={styles.verifySlotNumber}>
                {t("verifyWord", { number: index + 1 })}
              </Text>
              <Text style={[styles.verifySlotWord, creationLayoutStyles.slotWord]}>
                {verification[index] || "—"}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.verifyToolbar}>
          <Text style={styles.verifyPrompt}>
            {activePosition >= 0
              ? t("selectRecoveryWord", {
                  number: verificationIndexes[activePosition] + 1,
                })
              : t("recoveryWordsSelected")}
          </Text>
          <Pressable
            disabled={busy}
            accessibilityRole="button"
            onPress={resetVerification}
            hitSlop={8}
          >
            <Text style={styles.linkText}>{t("resetRecoverySelection")}</Text>
          </Pressable>
        </View>
        <View
          style={styles.verifyChoices}
          onLayout={(event) => {
            const measuredWidth = event.nativeEvent.layout.width;
            if (measuredWidth > 0) setChoiceGridWidth(measuredWidth);
          }}
        >
          {verificationChoices.map((word) => (
            <Pressable
              key={word}
              disabled={busy || activePosition < 0}
              accessibilityRole="button"
              accessibilityLabel={word}
              accessibilityState={{ disabled: busy || activePosition < 0 }}
              style={({ pressed }) => [
                styles.verifyChoice,
                choiceWordLayout,
                (busy || activePosition < 0) && styles.verifyChoiceDisabled,
                pressed && styles.buttonPressed,
              ]}
              onPress={() => chooseWord(word)}
            >
              <Text style={styles.verifyChoiceText}>{word}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable
          disabled={busy}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: confirmed }}
          style={styles.checkRow}
          onPress={() => setConfirmed((value) => !value)}
        >
          <View style={[styles.checkbox, confirmed && styles.checkboxChecked]}>
            {confirmed ? <Check size={16} color="#fff" /> : null}
          </View>
          <Text style={styles.checkLabel}>{t("savedRecoveryPhrase")}</Text>
        </Pressable>
        {error ? (
          <Text accessibilityRole="alert" style={styles.errorText}>
            {error}
          </Text>
        ) : null}
        <PrimaryButton
          title={busy ? t("loading") : t("continueToWallet")}
          loading={busy}
          disabled={
            !confirmed ||
            busy ||
            !verificationIndexes.every((index) => verification[index]?.trim())
          }
          onPress={() => {
            void finish();
          }}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

function ImportScreen({ navigation, route }: ScreenProps<"Import">) {
  const { t } = useI18n();
  const {
    setCore,
    setCreationCore,
    setRevision,
    setSelectedAccountIndex,
    storage,
    biometric,
    passwordVerifier,
    manager,
    session,
  } = useWalletContext();
  const [method, setMethod] = useState<"mnemonic" | "privateKey">(
    route?.params?.method ?? "mnemonic",
  );
  const [secret, setSecret] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const importing = useRef(false);
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !busy });
  }, [busy, navigation]);
  useFocusEffect(
    useCallback(() => {
      const listener = BackHandler.addEventListener(
        "hardwareBackPress",
        () => importing.current,
      );
      return () => listener.remove();
    }, []),
  );
  const chooseMethod = (next: "mnemonic" | "privateKey") => {
    if (importing.current || next === method) return;
    setSecret("");
    setVisible(false);
    setError("");
    setMethod(next);
  };
  const submit = async () => {
    if (importing.current || !secret.trim()) return;
    importing.current = true;
    const generation = session.capture();
    setBusy(true);
    setError("");
    let imported: WalletCore | undefined;
    let importedVaultReleased = false;
    let keepImportedVault = false;
    const releaseImportedVault = () => {
      if (imported && !keepImportedVault && !importedVaultReleased) {
        imported.vault.forget();
        importedVaultReleased = true;
      }
    };
    const options = {
      networks: DEFAULT_NETWORKS,
      storage,
      biometric,
      passwordVerifier,
      transactionRecorder: saveTransaction,
    };
    try {
      // Let the loading state reach the native UI before local key derivation.
      await waitForPaint();
      session.assertCurrent(generation);
      imported =
        method === "mnemonic"
          ? WalletCore.fromMnemonic(secret, options)
          : WalletCore.fromPrivateKey(secret, options);
      setCreationCore(imported);
    } catch {
      releaseImportedVault();
      setError(
        t(
          method === "mnemonic" ? "invalidRecoveryPhrase" : "invalidPrivateKey",
        ),
      );
      importing.current = false;
      setBusy(false);
      return;
    }
    try {
      const accountCount = imported.canDeriveAccounts()
        ? await loadAccountCount(imported.getAccount(0).address)
        : 1;
      session.assertCurrent(generation);
      const core =
        accountCount === 1
          ? imported
          : WalletCore.fromVault(imported.vault, { ...options, accountCount });
      const address = imported.getAccount(0).address;
      const existing = manager
        .list()
        .find(
          (wallet) => wallet.address.toLowerCase() === address.toLowerCase(),
        );
      if (existing?.watchOnly) {
        releaseImportedVault();
        setError(t("watchWalletAlreadyExists"));
        return;
      }
      const record = existing ?? (await manager.addCoreAndPersist(core));
      // Once the manager accepts a new core, it owns the vault even if a
      // later selection or active-wallet persistence step needs a retry.
      if (!existing) keepImportedVault = true;
      // Reimporting the same address must keep its original backup method.
      // The selected core, collection metadata and persisted vault must agree.
      const selectedCore = existing ? manager.getCore(existing.id) : core;
      if (existing) releaseImportedVault();
      await manager.selectAndPersist(record.id);
      session.assertCurrent(generation);
      await selectedCore.vault.persist();
      session.assertCurrent(generation);
      setSecret("");
      setVisible(false);
      setSelectedAccountIndex(0);
      setCore(selectedCore);
      setRevision((value) => value + 1);
      importing.current = false;
      navigation.reset({ index: 0, routes: [{ name: "Main" }] });
    } catch {
      releaseImportedVault();
      setError(t("unableToSaveWallet"));
    } finally {
      releaseImportedVault();
      setCreationCore(null);
      importing.current = false;
      setBusy(false);
    }
  };
  const isMnemonic = method === "mnemonic";
  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.importContent}
        >
          <PageHeader
            title={t("importWallet")}
            disabled={busy}
            onBack={() => {
              if (!importing.current) navigation.goBack();
            }}
          />
          <View style={styles.importHero}>
            <DreamKeyLogo size={72} style={styles.importHeroLogo} />
            <Text style={styles.importTitle}>{t("restoreYourWallet")}</Text>
            <Text style={styles.importDescription}>
              {t("importMethodsHint")}
            </Text>
          </View>
          <View style={styles.importTabs}>
            {(["mnemonic", "privateKey"] as const).map((option) => (
              <Pressable
                key={option}
                accessibilityRole="tab"
                accessibilityState={{
                  selected: method === option,
                  disabled: busy,
                }}
                disabled={busy}
                onPress={() => chooseMethod(option)}
                style={[
                  styles.importTab,
                  method === option && styles.importTabSelected,
                ]}
              >
                {option === "mnemonic" ? (
                  <FileKey
                    size={19}
                    color={
                      method === option ? colors.accentBright : colors.muted
                    }
                  />
                ) : (
                  <KeyRound
                    size={19}
                    color={
                      method === option ? colors.accentBright : colors.muted
                    }
                  />
                )}
                <Text
                  style={[
                    styles.importTabText,
                    method === option && styles.importTabTextSelected,
                  ]}
                >
                  {t(option === "mnemonic" ? "recoveryPhrase" : "privateKey")}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.secretCard}>
            <View style={styles.secretLabelRow}>
              <Text style={styles.secretLabel}>
                {t(isMnemonic ? "recoveryPhrase" : "privateKey")}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t(visible ? "hideSecret" : "showSecret")}
                accessibilityState={{ expanded: visible }}
                disabled={busy}
                onPress={() => setVisible((value) => !value)}
                style={styles.secretReveal}
              >
                {visible ? (
                  <EyeOff size={21} color={colors.muted} />
                ) : (
                  <Eye size={21} color={colors.muted} />
                )}
              </Pressable>
            </View>
            <TextInput
              key={`${method}-${visible}`}
              testID="wallet-import-secret"
              accessibilityLabel={t(
                isMnemonic ? "recoveryPhrase" : "privateKey",
              )}
              value={secret}
              onChangeText={(value) => {
                setSecret(value);
                setError("");
              }}
              editable={!busy}
              secureTextEntry={!visible}
              multiline={visible && isMnemonic}
              textAlignVertical={visible && isMnemonic ? "top" : "center"}
              style={[
                styles.secretInput,
                visible && isMnemonic && styles.secretMultiline,
              ]}
              placeholder={t(
                isMnemonic ? "mnemonicPlaceholder" : "privateKeyPlaceholder",
              )}
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              textContentType="none"
              keyboardType="default"
              returnKeyType="done"
              onSubmitEditing={() => {
                if (!isMnemonic || !visible) void submit();
              }}
            />
            <Text style={styles.secretHint}>
              {t(isMnemonic ? "importPhraseHint" : "importPrivateKeyHint")}
            </Text>
          </View>
          <View style={styles.importNotice}>
            <ShieldCheck size={21} color={colors.green} />
            <Text style={styles.importNoticeText}>
              {t("importSecurityHint")}
            </Text>
          </View>
          {!isMnemonic ? (
            <Text style={styles.privateKeyScope}>
              {t("privateKeyAccountHint")}
            </Text>
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" style={styles.errorText}>
              {error}
            </Text>
          ) : null}
          <PrimaryButton
            title={busy ? t("importingWallet") : t("importWallet")}
            loading={busy}
            disabled={busy || !secret.trim()}
            onPress={() => {
              void submit();
            }}
          />
          {busy ? (
            <Text accessibilityLiveRegion="polite" style={styles.secretHint}>
              {t("importingWalletHint")}
            </Text>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function UnlockScreen({ navigation }: ScreenProps<"Unlock">) {
  const { t } = useI18n();
  const {
    setCore,
    setRevision,
    setSelectedAccountIndex,
    storage,
    biometric,
    passwordVerifier,
    manager,
    setManager,
    managerStorage,
    session,
  } = useWalletContext();
  const unlocking = useRef(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [passwordMode, setPasswordMode] = useState(false);
  const [passwordConfigured, setPasswordConfigured] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(true);
  useEffect(() => {
    let active = true;
    void Promise.all([
      passwordVerifier.isConfigured(),
      passwordVerifier.isBiometricEnabled().catch(() => false),
      biometric.isAvailable().catch(() => false),
    ])
      .then(([configured, preference, available]) => {
        if (!active) return;
        const bio = Boolean(preference && available);
        setPasswordConfigured(configured);
        setPasswordMode(Boolean(configured && !bio));
        setBiometricEnabled(bio);
        if (!configured && !bio) setError(t("biometricUnavailable"));
        storage.setPasswordMode(configured);
        managerStorage.setPasswordMode(configured);
        storage.setBiometricEnabled(bio);
        managerStorage.setBiometricEnabled(bio);
      })
      .catch(() => {
        if (active) setError(t("unableToUnlock"));
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, [biometric, passwordVerifier, storage, managerStorage, t]);
  const unlock = async (
    method: "password" | "biometric" = passwordMode ? "password" : "biometric",
  ) => {
    if (unlocking.current || !ready) return;
    unlocking.current = true;
    const generation = session.capture();
    let restoredManager: WalletManager | undefined;
    let restoredCore: WalletCore | undefined;
    const forgetRestored = session.onInvalidate(() => {
      restoredManager?.dispose();
      restoredCore?.vault.forget();
    });
    setBusy(true);
    setError("");
    try {
      await waitForPaint();
      const configured = await passwordVerifier.isConfigured();
      const bio = await passwordVerifier.isBiometricEnabled().catch(() => false);
      storage.setPasswordMode(configured);
      managerStorage.setPasswordMode(configured);
      storage.setBiometricEnabled(bio);
      managerStorage.setBiometricEnabled(bio);
      session.assertCurrent(generation);
      if (method === "password") {
        if (!configured || !(await passwordVerifier.verify(password))) {
          setError(t("unableToUnlock"));
          return;
        }
      } else {
        let authenticated = false;
        try {
          authenticated = bio && (await biometric.authenticate(t("unlockWallet")));
        } catch {
          // Cancellation, lockout and native failures all leave the wallet locked.
        }
        session.assertCurrent(generation);
        if (!authenticated) {
          if (configured) {
            setPasswordConfigured(true);
            setPasswordMode(true);
            setPassword("");
            setError(t("biometricFailedUsePassword"));
          } else setError(t("unableToUnlock"));
          return;
        }
      }
      session.assertCurrent(generation);
      const savedManager = await managerStorage.load();
      session.assertCurrent(generation);
      let activeManager = manager;
      if (savedManager) {
        try {
          activeManager = WalletManager.fromSerialized(savedManager, {
            networks: DEFAULT_NETWORKS,
            storage: managerStorage,
            vaultStorage: storage,
            biometric,
            passwordVerifier,
            transactionRecorder: saveTransaction,
          });
          restoredManager = activeManager;
        } catch {
          /* Ignore invalid collection and migrate the legacy wallet below. */
        }
      }
      let selectedCore = activeManager.getSelectedCore();
      if (!selectedCore || !activeManager.list().length) {
        const value = await storage.load();
        session.assertCurrent(generation);
        if (!value) {
          setError(t("noWalletFound"));
          return;
        }
        const core = await restoreWallet(
          value,
          storage,
          biometric,
          passwordVerifier,
          session,
          generation,
        );
        restoredCore = core;
        session.assertCurrent(generation);
        if (!activeManager.list().length) {
          const record = await activeManager.addCoreAndPersist(core);
          await activeManager.selectAndPersist(record.id);
        }
        selectedCore = activeManager.getSelectedCore() ?? core;
      }
      // Re-save legacy entries after successful authentication so subsequent
      // password unlocks do not inherit an older per-item biometric policy.
      await activeManager.persist();
      session.assertCurrent(generation);
      if (!selectedCore.isWatchOnly()) await selectedCore.vault.persist();
      else await storage.clear();
      session.assertCurrent(generation);
      setManager(activeManager);
      setPassword("");
      Keyboard.dismiss();
      setSelectedAccountIndex(0);
      setCore(selectedCore);
      setRevision((value) => value + 1);
      navigation.reset({ index: 0, routes: [{ name: "Main" }] });
    } catch {
      if (!session.isCurrent(generation)) {
        restoredManager?.dispose();
        restoredCore?.vault.forget();
      }
      setError(t("unableToUnlock"));
    } finally {
      forgetRestored();
      unlocking.current = false;
      setBusy(false);
    }
  };
  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={[styles.authContainer, { flexGrow: 1 }]}
        >
          <BrandHeader
            title="DreamKey"
            subtitle={t("authenticateToAccess")}
          />
          <View style={styles.lockIcon}>
            <LockKeyhole size={43} color={colors.accentBright} />
          </View>
          <Text style={styles.heroTitle}>{t("welcomeBack")}</Text>
          <Text style={styles.heroText}>{t("secureEnclave")}</Text>
          <View style={styles.authSpacer} />
          {error ? <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text> : null}
          {passwordMode ? (
            <TextInput
              accessibilityLabel={t("walletPassword")}
              editable={!busy}
              value={password}
              onChangeText={(value) => {
                setPassword(value);
                setError("");
              }}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              autoComplete="off"
              textContentType="none"
              placeholder={t("passwordPlaceholder")}
              placeholderTextColor={colors.muted}
              style={styles.field}
              returnKeyType="done"
              onSubmitEditing={() => {
                if (password) void unlock("password");
              }}
            />
          ) : null}
          <PrimaryButton
            title={
              busy
                ? t("unlocking")
                : passwordMode
                  ? t("unlockWallet")
                  : t("unlockWithBiometrics")
            }
            loading={busy || !ready}
            disabled={busy || !ready || (passwordMode && !password)}
            onPress={() => {
              void unlock();
            }}
          />
          {passwordConfigured && biometricEnabled ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              style={styles.linkButton}
              onPress={() => {
                setError("");
                setPassword("");
                Keyboard.dismiss();
                setPasswordMode((value) => !value);
              }}
            >
              <Text style={styles.linkText}>
                {passwordMode ? t("unlockWithBiometrics") : t("usePassword")}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/* Legacy route wrappers remain below while the wallet route modules are migrated. */
function SettingsScreen({ navigation }: ScreenProps<"Settings">) {
  return (
    <ExtractedSettingsScreen
      onBack={() => navigation.goBack()}
      onLanguage={() => navigation.navigate("LanguageSettings")}
      onSecurity={() => navigation.navigate("SecuritySettings")}
      onInviteFriends={() => navigation.navigate("InviteFriends")}
      onAbout={() => navigation.navigate("About")}
    />
  );
}

function AboutRouteScreen({ navigation }: ScreenProps<"About">) {
  return <ExtractedAboutRouteScreen onBack={() => navigation.goBack()} />;
}

function LanguageSettingsScreen({
  navigation,
}: ScreenProps<"LanguageSettings">) {
  return <ExtractedLanguageSettingsScreen onBack={() => navigation.goBack()} />;
}

function SecuritySettingsScreen({
  navigation,
}: ScreenProps<"SecuritySettings">) {
  const { t } = useI18n();
  const {
    core,
    storage,
    passwordVerifier,
    managerStorage,
    manager,
    biometric,
    session,
  } = useWalletContext();
  const saving = useRef(false);
  const [ready, setReady] = useState(false);
  const [passwordConfigured, setPasswordConfigured] = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(true);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [disablePrompt, setDisablePrompt] = useState(false);
  const [password, setPassword] = useState("");
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !busy });
  }, [busy, navigation]);
  useFocusEffect(
    useCallback(() => {
      const listener = BackHandler.addEventListener("hardwareBackPress", () => saving.current);
      return () => listener.remove();
    }, []),
  );
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setReady(false);
      void Promise.all([
        passwordVerifier.isConfigured(),
        passwordVerifier.isBiometricEnabled(),
        biometric.isAvailable(),
      ])
        .then(([configured, bio, available]) => {
          if (!active) return;
          setPasswordConfigured(Boolean(configured));
          setBiometricEnabled(bio);
          setBiometricAvailable(available);
          storage.setBiometricEnabled(bio);
          managerStorage.setBiometricEnabled(bio);
        })
        .catch(() => {
          if (active) setError(t("unableToUnlock"));
        })
        .finally(() => {
          if (active) setReady(true);
        });
      return () => {
        active = false;
      };
    }, [biometric, managerStorage, passwordVerifier, storage, t]),
  );
  const saveBiometric = async (next: boolean, walletPassword?: string) => {
    if (saving.current) return;
    saving.current = true;
    const generation = session.capture();
    setBusy(true);
    setError("");
    Keyboard.dismiss();
    try {
      await waitForPaint();
      if (next && !(await biometric.isAvailable())) {
        setError(t("biometricUnavailable"));
        return;
      }
      if (walletPassword !== undefined) {
        if (!(await passwordVerifier.verify(walletPassword))) {
          setError(t("incorrectPassword"));
          return;
        }
      } else if (!(await biometric.authenticate(t("securitySettings")))) {
        setError(t("unableToUnlock"));
        return;
      }
      session.assertCurrent(generation);
      if (core && !core.isWatchOnly())
        await storage.save(core.vault.serialize());
      await manager.persist();
      session.assertCurrent(generation);
      await passwordVerifier.setBiometricEnabled(next);
      storage.setBiometricEnabled(next);
      managerStorage.setBiometricEnabled(next);
      setBiometricEnabled(next);
      setDisablePrompt(false);
      setPassword("");
      Keyboard.dismiss();
    } catch {
      setError(t("unableToSaveWallet"));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const toggleBiometric = async (next: boolean) => {
    if (!ready || saving.current) return;
    setError("");
    if (next && !biometricAvailable) {
      setError(t("biometricUnavailable"));
      return;
    }
    if (!next && !passwordConfigured) {
      setError(t("biometricNeedsPassword"));
      return;
    }
    if (!next) {
      setPassword("");
      setDisablePrompt(true);
      return;
    }
    await saveBiometric(true);
  };
  return (
    <SafeAreaView style={styles.safe}>
      <View style={{ paddingHorizontal: 20, paddingTop: 8 }}><PageHeader
          title={t("securitySettings")}
          disabled={busy}
          onBack={() => { if (!saving.current) navigation.goBack(); }}
        /></View>
      <ScrollView contentContainerStyle={styles.pageScroll}>
        <Text style={styles.bodyText}>{t("securityDescription")}</Text>
        <View style={styles.settingsGroup}>
          <View style={[styles.settingsRow, styles.settingsRowBorder]}>
            <View style={styles.settingsRowIcon}>
              <ShieldCheck size={22} color={colors.accentBright} />
            </View>
            <View style={styles.settingsRowCopy}>
              <Text style={styles.settingsRowTitle}>{t("biometric")}</Text>
              <Text style={styles.settingsRowDescription}>
                {biometricAvailable
                  ? t("biometricDescription")
                  : t("biometricUnavailable")}
              </Text>
            </View>
            {busy ? (
              <ActivityIndicator color={colors.accentBright} />
            ) : (
              <Switch
                accessibilityLabel={t("biometric")}
                disabled={!ready || !biometricAvailable}
                value={biometricEnabled && biometricAvailable}
                onValueChange={(value) => {
                  void toggleBiometric(value);
                }}
                trackColor={{ false: colors.line, true: colors.accent }}
                thumbColor="#fff"
              />
            )}
          </View>
          <SettingsRow
            icon={<KeyRound size={22} color={colors.accentBright} />}
            title={t("walletPassword")}
            description={
              passwordConfigured
                ? t("passwordEnabled")
                : t("walletPasswordDescription")
            }
            disabled={busy || !ready}
            onPress={() => { if (ready && !saving.current) navigation.navigate("Password"); }}
            last
          />
        </View>
        {error && !disablePrompt ? (
          <Text accessibilityRole="alert" style={styles.errorText}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
      <Modal
        visible={disablePrompt}
        transparent
        animationType="fade"
        onRequestClose={() => {
          if (!saving.current) {
            setDisablePrompt(false);
            setPassword("");
            setError("");
            Keyboard.dismiss();
          }
        }}
      >
        <KeyboardAvoidingView
          style={styles.authModalBackdrop}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" style={styles.authModalScroll} contentContainerStyle={styles.authModalCard}>
            <Text style={styles.settingsRowTitle}>{t("walletPassword")}</Text>
            <Text style={styles.settingsDescription}>
              {t("confirmBiometricDisable")}
            </Text>
            <Field
              label={t("currentPassword")}
              value={password}
              editable={!busy}
              onChangeText={(value) => {
                setPassword(value);
                setError("");
              }}
              secureTextEntry
              placeholder={t("passwordPlaceholder")}
              returnKeyType="done"
              onSubmitEditing={() => { if (password) void saveBiometric(false, password); }}
            />
            {error ? (
              <Text accessibilityRole="alert" style={styles.errorText}>
                {error}
              </Text>
            ) : null}
            <PrimaryButton
              title={t("confirm")}
              loading={busy}
              disabled={!password || busy}
              onPress={() => {
                void saveBiometric(false, password);
              }}
            />
            <PrimaryButton
              title={t("close")}
              variant="secondary"
              disabled={busy}
              onPress={() => {
                setDisablePrompt(false);
                setPassword("");
                setError("");
                Keyboard.dismiss();
              }}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

function PasswordSettingsScreen({ navigation }: ScreenProps<"Password">) {
  const { t } = useI18n();
  const {
    core,
    storage,
    passwordVerifier,
    managerStorage,
    manager,
    biometric,
    session,
  } = useWalletContext();
  const saving = useRef(false);
  const [ready, setReady] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void passwordVerifier
      .isConfigured()
      .then(setConfigured)
      .catch(() => setError(t("unableToUnlock")))
      .finally(() => setReady(true));
  }, [passwordVerifier, t]);
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !busy });
  }, [busy, navigation]);
  useFocusEffect(
    useCallback(() => {
      const listener = BackHandler.addEventListener(
        "hardwareBackPress",
        () => saving.current,
      );
      return () => listener.remove();
    }, []),
  );
  const save = async () => {
    if (!ready || saving.current) return;
    setError("");
    if (password.length < 6) {
      setError(t("passwordMinLength"));
      return;
    }
    if (password !== confirm) {
      setError(t("passwordMismatch"));
      return;
    }
    saving.current = true;
    const generation = session.capture();
    setBusy(true);
    try {
      await waitForPaint();
      if (configured && !(await passwordVerifier.verify(currentPassword))) {
        setError(t("incorrectPassword"));
        return;
      }
      // Existing biometric-only wallets must prove the current owner's
      // presence before a new password can become an alternative export gate.
      if (!configured && ((await storage.hasWallet()) || (await managerStorage.hasWallet())) &&
          (!(await passwordVerifier.isBiometricEnabled()) || !(await biometric.authenticate(t("walletPassword"))))) {
        setError(t("unableToUnlock"));
        return;
      }
      session.assertCurrent(generation);
      if (core && !core.isWatchOnly())
        await storage.save(core.vault.serialize());
      await manager.persist();
      session.assertCurrent(generation);
      await passwordVerifier.setPassword(password, () => session.isCurrent(generation));
      session.assertCurrent(generation);
      await passwordVerifier.setPasswordMode(true);
      storage.setPasswordMode(true);
      managerStorage.setPasswordMode(true);
      setConfigured(true);
      setPassword("");
      setConfirm("");
      setCurrentPassword("");
      Keyboard.dismiss();
      Alert.alert(t("walletPassword"), t("passwordEnabled"));
      navigation.goBack();
    } catch {
      setError(t("unableToSaveWallet"));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  const clear = async () => {
    if (!ready || saving.current) return;
    saving.current = true;
    const generation = session.capture();
    setError("");
    setBusy(true);
    try {
      await waitForPaint();
      if (
        !(await passwordVerifier.isBiometricEnabled()) ||
        !(await biometric.isAvailable())
      ) {
        setError(t("passwordNeedsBiometrics"));
        return;
      }
      if (!(await passwordVerifier.verify(currentPassword))) {
        setError(t("incorrectPassword"));
        return;
      }
      if (!(await biometric.authenticate(t("walletPassword")))) {
        setError(t("unableToUnlock"));
        return;
      }
      session.assertCurrent(generation);
      if (core && !core.isWatchOnly())
        await storage.save(core.vault.serialize());
      await manager.persist();
      session.assertCurrent(generation);
      await passwordVerifier.clearPassword();
      storage.setPasswordMode(false);
      managerStorage.setPasswordMode(false);
      setConfigured(false);
      setCurrentPassword("");
      Keyboard.dismiss();
      Alert.alert(t("walletPassword"), t("passwordDisabled"));
      navigation.goBack();
    } catch {
      setError(t("unableToSaveWallet"));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.pageScroll}
        >
          <PageHeader
            title={t("walletPassword")}
            disabled={busy}
            onBack={() => {
              if (!saving.current) navigation.goBack();
            }}
          />
          <Text style={styles.bodyText}>{t("walletPasswordDescription")}</Text>
          {configured ? (
            <Field
              editable={!busy && ready}
              label={t("currentPassword")}
              value={currentPassword}
              onChangeText={setCurrentPassword}
              secureTextEntry
              placeholder={t("passwordPlaceholder")}
            />
          ) : null}
          <Field
            editable={!busy && ready}
            label={configured ? t("newPassword") : t("walletPassword")}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder={t("passwordPlaceholder")}
          />
          <Field
            editable={!busy && ready}
            label={t("confirmPassword")}
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            placeholder={t("confirmPasswordPlaceholder")}
            returnKeyType="done"
            onSubmitEditing={() => { if (password && confirm && (!configured || currentPassword)) void save(); }}
          />
          {error ? (
            <Text accessibilityRole="alert" style={styles.errorText}>
              {error}
            </Text>
          ) : null}
          <PrimaryButton
            title={
              busy
                ? t("loading")
                : configured
                  ? t("changePassword")
                  : t("enablePassword")
            }
            loading={busy || !ready}
            disabled={
              busy ||
              !ready ||
              !password ||
              !confirm ||
              (configured && !currentPassword)
            }
            onPress={() => {
              void save();
            }}
          />
          {configured ? (
            <PrimaryButton
              title={t("disablePassword")}
              variant="secondary"
              disabled={busy || !currentPassword}
              onPress={() =>
                Alert.alert(
                  t("disablePassword"),
                  t("disablePasswordConfirmation"),
                  [
                    { text: t("close"), style: "cancel" },
                    {
                      text: t("confirm"),
                      onPress: () => {
                        void clear();
                      },
                    },
                  ],
                )
              }
            />
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function HomeAction({
  icon,
  label,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.homeAction,
        pressed && styles.homePressed,
      ]}
      onPress={onPress}
    >
      {icon}
      <Text style={styles.homeActionLabel}>{label}</Text>
    </Pressable>
  );
}

function AccountsScreen({ navigation }: ScreenProps<"Accounts">) {
  const {
    manager,
    managerStorage,
    setCore,
    setRevision,
    setSelectedAccountIndex,
    storage,
    biometric,
    passwordVerifier,
    session,
  } = useWalletContext();
  const { t } = useI18n();
  const [authenticationMode, setAuthenticationMode] = useState<
    "biometric" | "password" | "both"
  >("biometric");
  const [switchingWallet, setSwitchingWallet] = useState(false);
  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !switchingWallet });
  }, [navigation, switchingWallet]);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void Promise.all([
        passwordVerifier.isConfigured(),
        passwordVerifier.isBiometricEnabled().catch(() => false),
        biometric.isAvailable().catch(() => false),
      ]).then(([configured, enabled, available]) => {
        if (active)
          setAuthenticationMode(
            configured
              ? enabled && available
                ? "both"
                : "password"
              : "biometric",
          );
      }).catch(() => {
        if (active) setAuthenticationMode("biometric");
      });
      return () => {
        active = false;
      };
    }, [biometric, passwordVerifier]),
  );
  const authenticateSensitiveAction = useCallback(
    async (password?: string) => {
      const generation = session.capture();
      let accepted = false;
      if (password !== undefined) {
        accepted = Boolean(
          (await passwordVerifier.isConfigured()) &&
          (await passwordVerifier.verify(password))
        );
      } else if (await passwordVerifier.isBiometricEnabled()) {
        accepted = await biometric.authenticate(t("authenticateToAccess"));
      }
      return accepted && session.isCurrent(generation);
    },
    [biometric, passwordVerifier, session, t],
  );
  return (
    <SafeAreaView style={styles.safe}>
      <WalletManagementScreen
        manager={manager}
        authenticationMode={authenticationMode}
        onAuthenticate={authenticateSensitiveAction}
        onBack={() => navigation.goBack()}
        onChanged={() => {
          const generation = session.capture();
          const selected = manager.getSelectedCore();
          setSelectedAccountIndex(0);
          setCore(selected);
          setRevision((value) => value + 1);
          void (async () => {
            try {
              if (!selected || selected.isWatchOnly()) await storage.clear();
              else await storage.save(selected.vault.serialize());
              session.assertCurrent(generation);
              if (!selected) {
                await managerStorage.clear();
                navigation.reset({ index: 0, routes: [{ name: "Welcome" }] });
              }
            } catch {
              if (session.isCurrent(generation)) Alert.alert(t("accounts"), t("unableToSaveWallet"));
            }
          })();
        }}
        onSelect={async (wallet) => {
          const generation = session.capture();
          setSwitchingWallet(true);
          try {
            await manager.selectAndPersist(wallet.id);
            session.assertCurrent(generation);
            const selectedCore = manager.getCore(wallet.id);
            if (!selectedCore.isWatchOnly())
              await storage.save(selectedCore.vault.serialize());
            else await storage.clear();
            session.assertCurrent(generation);
            setSelectedAccountIndex(0);
            setCore(selectedCore);
            setRevision((value) => value + 1);
            navigation.goBack();
          } finally {
            setSwitchingWallet(false);
          }
        }}
        onCreateMnemonic={() => navigation.navigate("Create")}
        onImportMnemonic={() =>
          navigation.navigate("Import", { method: "mnemonic" })
        }
        onImportPrivateKey={() =>
          navigation.navigate("Import", { method: "privateKey" })
        }
        onExportPrivateKey={(wallet) => manager.exportPrivateKey(wallet.id)}
        onExportMnemonic={(wallet) => manager.exportMnemonic(wallet.id)}
      />
    </SafeAreaView>
  );
}

function BrowserScreen({ route, navigation }: ScreenProps<"Browser">) {
  const {
    core,
    revision,
    selectedNetworkId,
    setSelectedNetworkId,
    setPendingApproval,
  } = useWalletContext();
  const { t, language } = useI18n();
  const browserStorage = useMemo(() => new ReactNativeDappBrowserStorage(), []);
  const initialRouteUrl = route.params?.url;
  const [activeUrl, setActiveUrl] = useState<string | null>(
    initialRouteUrl ?? null,
  );
  const [pageUrl, setPageUrl] = useState(initialRouteUrl ?? "");
  const [pageFaviconUrl, setPageFaviconUrl] = useState<string | undefined>();
  const [urlInput, setUrlInput] = useState(initialRouteUrl ?? "");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const favoritesRef = useRef<string[]>([]);
  const historyRef = useRef<string[]>([]);
  const pageUrlRef = useRef(initialRouteUrl ?? "");
  const storageWrites = useRef(Promise.resolve());
  const approvalInFlight = useRef(false);
  const browserRef = useRef<DappBrowserRef>(null);
  const [browserNavigation, setBrowserNavigation] =
    useState<DappNavigationState>({
      url: initialRouteUrl ?? "",
      title: "",
      loading: Boolean(initialRouteUrl),
      canGoBack: false,
      canGoForward: false,
    });
  const browserNavigationRef = useRef(browserNavigation);
  const editingUrlRef = useRef(false);
  const [editingAddress, setEditingAddress] = useState(false);
  const addressInputRef = useRef<TextInput>(null);
  const permissions = useMemo(
    () =>
      new PermissionManager(
        () => core?.listAccounts().map((account) => account.address) ?? [],
      ),
    [core],
  );

  useEffect(() => {
    let active = true;
    void browserStorage.load().then((saved) => {
      if (!active) return;
      setFavorites(saved.favorites);
      setHistory(saved.history);
      favoritesRef.current = saved.favorites;
      historyRef.current = saved.history;
    });
    return () => {
      active = false;
    };
  }, [browserStorage]);

  const persist = useCallback(
    (nextFavorites: string[], nextHistory: string[]) => {
      storageWrites.current = storageWrites.current
        .catch(() => undefined)
        .then(() =>
          browserStorage.save({
            favorites: nextFavorites,
            history: nextHistory,
          }),
        )
        .catch(() => undefined);
    },
    [browserStorage],
  );

  const recordVisit = useCallback(
    (value: string) => {
      if (historyRef.current[0] === value) return;
      const updated = [
        value,
        ...historyRef.current.filter((item) => item !== value),
      ].slice(0, 30);
      historyRef.current = updated;
      setHistory(updated);
      persist(favoritesRef.current, updated);
    },
    [persist],
  );

  const normalizeUrl = useCallback((value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    try {
      const decision = evaluateDappUrl(candidate);
      return decision.allowed ? (decision.url ?? null) : null;
    } catch {
      return null;
    }
  }, []);

  const openUrl = useCallback(
    (value: string) => {
      const next = normalizeUrl(value);
      if (!next) {
        Alert.alert(t("invalidDappUrl"));
        return;
      }
      editingUrlRef.current = false;
      setEditingAddress(false);
      addressInputRef.current?.blur();
      if (activeUrl) {
        if (pageUrlRef.current === next) browserRef.current?.reload();
        else if (!browserRef.current?.navigate(next)) return;
      } else {
        browserNavigationRef.current = {
          url: next,
          title: "",
          loading: true,
          canGoBack: false,
          canGoForward: false,
        };
        setBrowserNavigation(browserNavigationRef.current);
        setActiveUrl(next);
      }
      setPageUrl(next);
      setPageFaviconUrl(undefined);
      pageUrlRef.current = next;
      setUrlInput(next);
      recordVisit(next);
    },
    [activeUrl, normalizeUrl, recordVisit, t],
  );

  const toggleFavorite = useCallback(
    (value: string) => {
      const normalized = normalizeUrl(value);
      if (!normalized) {
        Alert.alert(t("invalidDappUrl"));
        return;
      }
      const current = favoritesRef.current;
      const updated = current.includes(normalized)
        ? current.filter((item) => item !== normalized)
        : [normalized, ...current].slice(0, 30);
      favoritesRef.current = updated;
      setFavorites(updated);
      persist(updated, historyRef.current);
    },
    [normalizeUrl, persist, t],
  );

  const clearHistory = useCallback(() => {
    historyRef.current = [];
    setHistory([]);
    persist(favoritesRef.current, []);
  }, [persist]);

  const provider = useMemo(
    () =>
      core
        ? createWalletProvider(core, selectedNetworkId, {
            permissions,
            approve: ({ origin, method, params }) =>
              new Promise<boolean>((resolve) => {
                setPendingApproval({
                  kind: "sign",
                  origin,
                  method,
                  params,
                  resolve,
                });
                navigation.navigate("SignRequest");
              }),
            requestAccounts: (origin) =>
              new Promise<string[]>((resolve) => {
                const accounts = core
                  .listAccounts()
                  .map((item) => item.address);
                setPendingApproval({
                  kind: "permission",
                  origin,
                  method: "eth_requestAccounts",
                  params: [],
                  resolve: (approved) => resolve(approved ? accounts : []),
                  resolveAccounts: resolve,
                });
                navigation.navigate("Permission");
              }),
          })
        : null,
    [core, navigation, permissions, setPendingApproval],
  );

  useEffect(() => {
    if (core && provider)
      provider.setAccounts(
        core.listAccounts().map((account) => account.address),
      );
  }, [core, provider, revision]);

  useEffect(() => {
    if (core && provider)
      provider.setChainId(core.getNetwork(selectedNetworkId).chainId);
  }, [core, provider, selectedNetworkId]);

  useEffect(() => {
    if (!core || !provider) return;
    const chainChanged = (chainId: string) => {
      browserRef.current?.emit("chainChanged", chainId);
      const network = core
        .listNetworks()
        .find((item) => item.chainId === Number(chainId));
      if (network) setSelectedNetworkId(network.id);
    };
    const accountsChanged = (accounts: string[], origin?: string) => {
      if (
        origin !==
        new URL(pageUrlRef.current || "https://invalid.invalid").origin
      )
        return;
      browserRef.current?.emit("accountsChanged", accounts);
    };
    const connected = (info: { chainId: string }) =>
      browserRef.current?.emit("connect", info);
    const disconnected = (error: { code: number; message: string }) =>
      browserRef.current?.emit("disconnect", {
        code: error.code,
        message: error.message,
      });
    provider
      .on("chainChanged", chainChanged)
      .on("accountsChanged", accountsChanged)
      .on("connect", connected)
      .on("disconnect", disconnected);
    return () => {
      provider
        .removeListener("chainChanged", chainChanged)
        .removeListener("accountsChanged", accountsChanged)
        .removeListener("connect", connected)
        .removeListener("disconnect", disconnected);
    };
  }, [core, provider, setSelectedNetworkId]);

  const onProviderRequest = useCallback(
    async (request: RequestArguments, context: ProviderRequestContext) => {
      if (!provider)
        throw Object.assign(new Error("Wallet is unavailable"), { code: 4900 });
      const sensitive =
        request.method === "eth_requestAccounts" ||
        request.method.startsWith("wallet_") ||
        request.method === "personal_sign" ||
        request.method.startsWith("eth_sign") ||
        request.method === "eth_sendTransaction";
      if (sensitive && approvalInFlight.current)
        throw Object.assign(new Error("A wallet request is already pending"), {
          code: -32002,
        });
      if (sensitive) approvalInFlight.current = true;
      try {
        return await provider.forOrigin(context.origin).request(request);
      } finally {
        if (sensitive) approvalInFlight.current = false;
      }
    },
    [provider],
  );

  const onPageLoaded = useCallback(
    (loadedUrl: string) => {
      if (!editingUrlRef.current) setUrlInput(loadedUrl);
      if (pageUrlRef.current !== loadedUrl) setPageFaviconUrl(undefined);
      setPageUrl(loadedUrl);
      pageUrlRef.current = loadedUrl;
      const normalized = normalizeUrl(loadedUrl);
      if (normalized) recordVisit(normalized);
    },
    [normalizeUrl, recordVisit],
  );

  const onPageMetadata = useCallback((metadata: DappPageMetadata) => {
    try {
      const current = new URL(pageUrlRef.current);
      const reported = new URL(metadata.url);
      current.hash = "";
      reported.hash = "";
      if (current.toString() !== reported.toString()) return;
      setPageFaviconUrl(metadata.faviconUrl);
      void refreshDappFavicon(metadata.url, metadata.faviconUrl).catch(() => {});
    } catch {
      /* Keep the origin fallback for malformed or stale metadata. */
    }
  }, []);

  const onBrowserNavigation = useCallback((state: DappNavigationState) => {
    browserNavigationRef.current = state;
    setBrowserNavigation(state);
  }, []);

  const closePage = useCallback(() => {
    editingUrlRef.current = false;
    setActiveUrl(null);
    setPageFaviconUrl(undefined);
    browserNavigationRef.current = {
      url: "",
      title: "",
      loading: false,
      canGoBack: false,
      canGoForward: false,
    };
    setBrowserNavigation(browserNavigationRef.current);
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!activeUrl) return;
      const subscription = BackHandler.addEventListener(
        "hardwareBackPress",
        () => {
          if (browserNavigationRef.current.canGoBack)
            browserRef.current?.goBack();
          else closePage();
          return true;
        },
      );
      return () => subscription.remove();
    }, [activeUrl, closePage]),
  );

  if (!core || !provider) return <LoadingScreen />;
  const navigate = () => openUrl(urlInput);
  const editUrl = () => {
    editingUrlRef.current = true;
    setEditingAddress(true);
    addressInputRef.current?.focus();
  };
  let displayedAddress = pageUrl || activeUrl || "";
  try {
    displayedAddress = new URL(displayedAddress).host;
  } catch {
    /* Preserve input until a valid page loads. */
  }

  if (!activeUrl) {
    return (
      <DappLandingScreen
        favorites={favorites}
        history={history}
        urlInput={urlInput}
        onUrlChange={setUrlInput}
        onOpen={openUrl}
        onToggleFavorite={toggleFavorite}
        onClearHistory={clearHistory}
        onBack={() => navigation.goBack()}
        networkName={core.getNetwork(selectedNetworkId).name}
        networkChainId={core.getNetwork(selectedNetworkId).chainId}
      />
    );
  }

  return (
    <DappBrowserRouteView
      browserRef={browserRef}
      activeUrl={activeUrl}
      pageUrl={pageUrl}
      displayedAddress={displayedAddress}
      urlInput={urlInput}
      editingAddress={editingAddress}
      pageFaviconUrl={pageFaviconUrl}
      favorites={favorites}
      language={language}
      browserNavigation={browserNavigation}
      t={t}
      addressInputRef={addressInputRef}
      onUrlChange={setUrlInput}
      onNavigate={navigate}
      onEditUrl={editUrl}
      onBlurUrl={() => {
        editingUrlRef.current = false;
        setEditingAddress(false);
      }}
      onClose={closePage}
      onToggleFavorite={() => toggleFavorite(pageUrl)}
      onProviderRequest={onProviderRequest}
      onPageLoaded={onPageLoaded}
      onPageMetadata={onPageMetadata}
      onNavigationStateChange={onBrowserNavigation}
    />
  );
}
function PermissionRouteScreen({ navigation }: ScreenProps<"Permission">) {
  const { core, pendingApproval, setPendingApproval } = useWalletContext();
  useEffect(
    () =>
      navigation.addListener("beforeRemove", () => {
        pendingApproval?.resolve(false);
        setPendingApproval(null);
      }),
    [navigation, pendingApproval, setPendingApproval],
  );
  if (!core || !pendingApproval) return <LoadingScreen />;
  const finish = (approved: boolean, accounts?: string[]) => {
    const request = pendingApproval;
    setPendingApproval(null);
    if (accounts && request.resolveAccounts)
      request.resolveAccounts(approved ? accounts : []);
    else request.resolve(approved);
    navigation.goBack();
  };
  return (
    <PermissionPrompt
      origin={pendingApproval.origin}
      requestedAccounts={core.listAccounts().map((account) => account.address)}
      onApprove={(accounts) => finish(accounts.length > 0, accounts)}
      onReject={() => finish(false)}
    />
  );
}

function SignRequestRouteScreen({ navigation }: ScreenProps<"SignRequest">) {
  const { t } = useI18n();
  const { core, selectedNetworkId, pendingApproval, setPendingApproval } = useWalletContext();
  const [, retryPreview] = useState(0);
  const decisionMade = useRef(false);
  useEffect(
    () =>
      navigation.addListener("beforeRemove", () => {
        if (decisionMade.current) return;
        decisionMade.current = true;
        pendingApproval?.resolve(false);
        setPendingApproval(null);
      }),
    [navigation, pendingApproval, setPendingApproval],
  );
  // A transient module/runtime failure must not be cached for the lifetime of
  // an approval. Re-read the same request on render, including after a retry.
  let signature: ReturnType<typeof getSignaturePreview>;
  let previewUnavailable = false;
  if (pendingApproval) {
    try {
      signature = getSignaturePreview(
        pendingApproval.method,
        pendingApproval.params,
      );
    } catch (error) {
      previewUnavailable = !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === -32602
      );
    }
  }
  if (!pendingApproval) return <LoadingScreen />;
  const first = pendingApproval.params[0];
  const isTransaction = pendingApproval.method === "eth_sendTransaction";
  const tx =
    isTransaction && first && typeof first === "object"
      ? (first as {
          from?: string;
          to?: string;
          value?: string;
          data?: string;
          gas?: string;
          gasPrice?: string;
          maxPriorityFeePerGas?: string;
          nonce?: string;
          chainId?: string;
          type?: string;
          maxFeePerGas?: string;
        })
      : undefined;
  const watchOnly = Boolean(core?.isWatchOnly());
  const canApprove = !watchOnly && (isTransaction || Boolean(signature));
  const account =
    signature?.account ?? tx?.from ?? core?.getAccount(0).address ?? "";
  const finish = (approved: boolean) => {
    const request = pendingApproval;
    if (decisionMade.current || (approved && !canApprove)) return;
    decisionMade.current = true;
    setPendingApproval(null);
    request.resolve(approved);
    navigation.goBack();
  };
  return (
    <SignRequestScreen
      origin={pendingApproval.origin}
      account={account}
      method={pendingApproval.method}
      signature={signature}
      transaction={tx}
      network={core?.getNetwork(selectedNetworkId)}
      canApprove={canApprove}
      riskNotice={
        watchOnly
          ? t("watchOnly")
          : !canApprove
            ? t(
                previewUnavailable
                  ? "signaturePreviewUnavailable"
                  : "invalidSignatureData",
              )
            : undefined
      }
      onRetryPreview={
        !canApprove ? () => retryPreview((value) => value + 1) : undefined
      }
      onApprove={() => finish(true)}
      onReject={() => finish(false)}
    />
  );
}
export default function App() {
  const [navigationReady, setNavigationReady] = useState(false);
  const [updateRoute, setUpdateRoute] = useState('Welcome');
  const onNavigationReady = useCallback(() => setNavigationReady(true), []);
  const session = useMemo(() => new WalletSessionGuard(), []);
  const storage = useMemo(() => new ReactNativeKeychainVaultStorage(), []);
  const biometric = useMemo(
    () => new ReactNativeKeychainBiometricAuthenticator(),
    [],
  );
  const passwordVerifier = useMemo(
    () => new ReactNativeWalletPasswordVerifier(),
    [],
  );
  const managerStorage = useMemo(
    () => new ReactNativeWalletManagerStorage(),
    [],
  );
  const initialManager = useMemo(
    () =>
      new WalletManager({
        networks: DEFAULT_NETWORKS,
        storage: managerStorage,
        vaultStorage: storage,
        biometric,
        passwordVerifier,
        transactionRecorder: saveTransaction,
      }),
    [biometric, managerStorage, passwordVerifier, storage],
  );
  const [manager, setManager] = useState(initialManager);
  const languageStorage = useMemo(() => new ReactNativeLanguageStorage(), []);
  const [language, setLanguageState] = useState<LanguageCode>("zh");
  const setLanguage = useCallback(
    (next: LanguageCode) => {
      setLanguageState(next);
      void languageStorage.save(next);
    },
    [languageStorage],
  );
  useEffect(() => {
    let active = true;
    void languageStorage.load().then((saved) => {
      if (active && saved) setLanguageState(saved);
    });
    return () => {
      active = false;
    };
  }, [languageStorage]);
  const [core, setCore] = useState<WalletCore | null>(null);
  const [creationCore, setCreationCore] = useState<WalletCore | null>(null);
  const [revision, setRevision] = useState(0);
  const [selectedAccountIndex, setSelectedAccountIndex] = useState(0);
  const [selectedNetworkId, setSelectedNetworkId] = useState(
    DEFAULT_NETWORKS[0].id,
  );
  const [pendingApproval, setPendingApproval] =
    useState<PendingApproval | null>(null);
  const lock = useCallback(async () => {
    session.invalidate();
    pendingApproval?.resolve(false);
    setPendingApproval(null);
    if (core && !core.isWatchOnly()) core.vault.forget();
    if (creationCore && !creationCore.isWatchOnly()) creationCore.vault.forget();
    manager.dispose();
    setCore(null);
    setCreationCore(null);
    setRevision((value) => value + 1);
  }, [core, creationCore, manager, pendingApproval, session]);
  // Leaving the app temporarily (home button, app switcher, screen lock, or a
  // system prompt) must not lock the wallet. The wallet is locked only when
  // the user explicitly presses the lock action. We still pause the session
  // guard while backgrounded so in-flight authentication cannot commit stale
  // results after the app returns.
  useEffect(() => {
    return subscribeAppVisibility((state) => {
      if (state === "background") {
        session.setForeground(false);
      } else if (state === "foreground") session.setForeground(true);
    });
  }, [session]);
  const context = useMemo<WalletContextValue>(
    () => ({
      session,
      core,
      setCore,
      creationCore,
      setCreationCore,
      revision,
      setRevision,
      selectedAccountIndex,
      setSelectedAccountIndex,
      selectedNetworkId,
      setSelectedNetworkId,
      pendingApproval,
      setPendingApproval,
      lock,
      storage,
      biometric,
      passwordVerifier,
      manager,
      setManager,
      managerStorage,
    }),
    [
      biometric,
      core,
      creationCore,
      lock,
      manager,
      managerStorage,
      passwordVerifier,
      pendingApproval,
      setManager,
      revision,
      selectedAccountIndex,
      selectedNetworkId,
      storage,
      session,
    ],
  );
  return (
    <SafeAreaProvider>
      <I18nProvider language={language} setLanguage={setLanguage}>
        <WalletContext.Provider value={context}>
          <UpdateProvider safeToPrompt={!creationCore && !pendingApproval && ['Welcome', 'Unlock', 'Main', 'Settings', 'About'].includes(updateRoute)} navigationReady={navigationReady}>
          <AppNavigator
            initialRouteName="Welcome"
            onReady={onNavigationReady}
            onRouteChange={setUpdateRoute}
            screens={{
              Welcome: WelcomeScreen,
              WalletSetup: WalletSetupScreen,
              Create: CreateScreen,
              CreateVerify: CreateVerifyScreen,
              Import: ImportScreen,
              Unlock: UnlockScreen,
              Main: HomeRouteScreen,
              Accounts: AccountsScreen,
              Networks: NetworkRouteScreen,
              Rpc: RpcRouteScreen,
              Assets: AssetsRouteScreen,
              Asset: AssetRouteScreen,
              Send: SendScreen,
              Receive: ReceiveRouteScreen,
              Transaction: TransactionRouteScreen,
              Browser: BrowserScreen,
              Permission: PermissionRouteScreen,
              SignRequest: SignRequestRouteScreen,
              Settings: SettingsScreen,
              InviteFriends: InviteFriendsRouteScreen,
              LanguageSettings: LanguageSettingsScreen,
              SecuritySettings: SecuritySettingsScreen,
              Password: PasswordSettingsScreen,
              About: AboutRouteScreen,
            }}
          />
          </UpdateProvider>
        </WalletContext.Provider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}
