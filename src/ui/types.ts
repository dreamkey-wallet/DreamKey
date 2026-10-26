import type { NetworkConfig, TransactionStatus, AccountInfo, Erc20Balance, Erc20Token } from '../core/types.js';
import type { Eip1193Provider, ProviderRequestHandler } from '../dapp/types.js';
import type { SignaturePreview } from '../provider/signing-payload.js';

export interface WalletAsset extends Erc20Balance {
  fiatValue?: string;
  iconColor?: string;
}

export interface ActivityItem {
  id: string;
  kind: 'sent' | 'received' | 'contract' | 'swap';
  title: string;
  subtitle?: string;
  amount?: string;
  state?: 'pending' | 'confirmed' | 'failed';
  timestamp?: string;
  hash?: string;
}

export interface WalletHomeScreenProps {
  account: AccountInfo;
  network: NetworkConfig;
  nativeBalance: string;
  nativeFiatValue?: string;
  assets?: WalletAsset[];
  activity?: ActivityItem[];
  loading?: boolean;
  onCopyAddress?: () => void;
  onReceive?: () => void;
  onSend?: () => void;
  onOpenAssets?: () => void;
  onSelectActivity?: (activity: ActivityItem) => void;
  onOpenAccountPicker?: () => void;
  onOpenNetworkPicker?: () => void;
  onOpenBrowser?: () => void;
}

export interface AccountsScreenProps {
  accounts: AccountInfo[];
  selectedIndex: number;
  onSelect: (account: AccountInfo) => void;
  onCreateAccount?: () => void;
  onImportAccount?: () => void;
  onBack?: () => void;
}

export interface NetworksScreenProps {
  networks: NetworkConfig[];
  selectedId: string;
  onSelect: (network: NetworkConfig) => void;
  onAddNetwork?: () => void;
  onBack?: () => void;
}

export interface AssetsScreenProps {
  network: NetworkConfig;
  nativeBalance: string;
  nativeFiatValue?: string;
  assets?: WalletAsset[];
  onSelectAsset?: (asset: WalletAsset | 'native') => void;
  onAddToken?: () => void;
  onBack?: () => void;
}

export interface SendScreenProps {
  network: NetworkConfig;
  nativeSymbol: string;
  maxBalance?: string;
  token?: Erc20Token;
  onSubmit: (input: { to: string; amount: string; token?: Erc20Token }) => Promise<void> | void;
  onBack?: () => void;
}

export interface SignRequestScreenProps {
  origin: string;
  account: string;
  method: 'personal_sign' | 'eth_sign' | 'eth_signTypedData' | 'eth_sendTransaction' | string;
  message?: string;
  signature?: SignaturePreview;
  transaction?: { to?: string; value?: string; data?: string; gas?: string; gasPrice?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string; nonce?: string; chainId?: string; type?: string };
  network?: NetworkConfig;
  riskNotice?: string;
  canApprove?: boolean;
  onRetryPreview?: () => void;
  loading?: boolean;
  onApprove: () => Promise<void> | void;
  onReject: () => Promise<void> | void;
}

export interface TransactionDetailScreenProps {
  network: NetworkConfig;
  status: TransactionStatus;
  title?: string;
  from?: string;
  to?: string;
  amount?: string;
  onOpenExplorer?: () => void;
  onBack?: () => void;
}

export interface PermissionPromptProps {
  origin: string;
  requestedAccounts: string[];
  existingAccounts?: string[];
  onApprove: (accounts: string[]) => Promise<void> | void;
  onReject: () => Promise<void> | void;
}

export interface DappBrowserScreenProps {
  initialUrl: string;
  provider?: Eip1193Provider;
  onProviderRequest?: ProviderRequestHandler;
  allowedHosts?: readonly (string | RegExp)[];
  onBack?: () => void;
}
