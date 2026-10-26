import React from "react";
import type { WalletCore, WalletManager } from "../core/index.js";
import type { WalletSessionGuard } from "../core/session-guard.js";
import type {
  ReactNativeKeychainBiometricAuthenticator,
  ReactNativeKeychainVaultStorage,
  ReactNativeWalletManagerStorage,
  ReactNativeWalletPasswordVerifier,
} from "../native/keychain.js";

export interface PendingApproval {
  kind: "permission" | "sign";
  origin: string;
  method: string;
  params: unknown[];
  resolve: (approved: boolean) => void;
  resolveAccounts?: (accounts: string[]) => void;
}

export interface WalletContextValue {
  session: WalletSessionGuard;
  core: WalletCore | null;
  setCore: (core: WalletCore | null) => void;
  creationCore: WalletCore | null;
  setCreationCore: (core: WalletCore | null) => void;
  revision: number;
  setRevision: React.Dispatch<React.SetStateAction<number>>;
  selectedAccountIndex: number;
  setSelectedAccountIndex: (index: number) => void;
  selectedNetworkId: string;
  setSelectedNetworkId: (id: string) => void;
  pendingApproval: PendingApproval | null;
  setPendingApproval: (approval: PendingApproval | null) => void;
  lock: () => Promise<void>;
  storage: ReactNativeKeychainVaultStorage;
  biometric: ReactNativeKeychainBiometricAuthenticator;
  passwordVerifier: ReactNativeWalletPasswordVerifier;
  manager: WalletManager;
  setManager: React.Dispatch<React.SetStateAction<WalletManager>>;
  managerStorage: ReactNativeWalletManagerStorage;
}

export const WalletContext = React.createContext<WalletContextValue | null>(
  null,
);

export function useWalletContext(): WalletContextValue {
  const context = React.useContext(WalletContext);
  if (!context) throw new Error("WalletContext is unavailable");
  return context;
}
