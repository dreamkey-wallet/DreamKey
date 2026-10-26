import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { AssetTransaction } from "../core/asset-history.js";
import type { StoredToken } from "../native/token-storage.js";

/**
 * Routes exposed by the wallet's root navigator.
 *
 * Keeping this type separate from the app shell lets screens and navigation
 * helpers reference route parameters without importing the component tree.
 */
export type RootStackParamList = {
  Welcome: undefined;
  WalletSetup: { next: "Create" | "Import" };
  Create: undefined;
  CreateVerify: undefined;
  Import: { method?: "mnemonic" | "privateKey" } | undefined;
  Unlock: undefined;
  Main: undefined;
  Accounts: undefined;
  Networks: undefined;
  Rpc: undefined;
  Send:
    | { assetAddress?: string; networkId?: string; accountIndex?: number }
    | undefined;
  Receive:
    | { token?: StoredToken; networkId?: string; accountIndex?: number }
    | undefined;
  Browser: { url?: string } | undefined;
  Assets: undefined;
  Asset: { token?: StoredToken; networkId: string; accountIndex: number };
  Permission: undefined;
  SignRequest: undefined;
  Transaction: {
    hash: string;
    networkId?: string;
    accountIndex?: number;
    record?: AssetTransaction;
  };
  Settings: undefined;
  InviteFriends: undefined;
  LanguageSettings: undefined;
  SecuritySettings: undefined;
  About: undefined;
  Password: undefined;
};

export type ScreenProps<RouteName extends keyof RootStackParamList> =
  NativeStackScreenProps<RootStackParamList, RouteName>;
