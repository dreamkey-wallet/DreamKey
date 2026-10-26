import { providerErrors } from './errors.js';
import type { WalletPermission } from './types.js';

export type PermissionCapability = 'eth_accounts';

/**
 * In-memory EIP-2255 permission store. Persist this store in the wallet's
 * encrypted storage from the host application when persistence is required.
 */
export class PermissionManager {
  private readonly grants = new Map<string, Set<string>>();

  constructor(private readonly availableAccounts: () => string[] = () => []) {}

  private normalizeOrigin(origin: string): string {
    return origin.trim() || 'default';
  }

  private normalizeAccount(account: string): string {
    if (!/^0x[a-fA-F0-9]{40}$/.test(account)) {
      throw providerErrors.invalidParams(`Invalid Ethereum account: ${account}`);
    }
    return account.toLowerCase();
  }

  getAccounts(origin: string): string[] {
    const grant = this.grants.get(this.normalizeOrigin(origin));
    if (!grant) return [];
    // Only expose accounts that still exist in the wallet.
    const available = new Set(this.availableAccounts().map((a) => a.toLowerCase()));
    return [...grant].filter((account) => available.has(account));
  }

  has(origin: string, account?: string): boolean {
    const accounts = this.getAccounts(origin);
    return account ? accounts.includes(this.normalizeAccount(account)) : accounts.length > 0;
  }

  grantAccounts(origin: string, accounts: string[] = this.availableAccounts()): string[] {
    const normalized = accounts.map((a) => this.normalizeAccount(a));
    this.grants.set(this.normalizeOrigin(origin), new Set(normalized));
    return normalized;
  }

  revoke(origin: string, capability: PermissionCapability = 'eth_accounts'): void {
    if (capability !== 'eth_accounts') throw providerErrors.unsupported(`Unsupported permission: ${capability}`);
    this.grants.delete(this.normalizeOrigin(origin));
  }

  clearAccount(account: string): void {
    const normalized = this.normalizeAccount(account);
    for (const [origin, grant] of this.grants) {
      grant.delete(normalized);
      if (grant.size === 0) this.grants.delete(origin);
    }
  }

  getPermissions(origin: string): WalletPermission[] {
    const accounts = this.getAccounts(origin);
    if (!accounts.length) return [];
    return [{
      parentCapability: 'eth_accounts',
      caveats: [{ type: 'restrictReturnedAccounts', value: accounts }],
    }];
  }
}

