import { getAddress, isAddress } from 'ethers';
import * as Keychain from 'react-native-keychain';

const writes = new Map<string, Promise<void>>();

function walletService(walletFirstAddress: string): string {
  if (!isAddress(walletFirstAddress)) throw new Error('Invalid wallet address');
  return `independent-wallet.accounts.${getAddress(walletFirstAddress).toLowerCase()}`;
}

function validateCount(count: unknown): number {
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 1000) {
    throw new Error('Account count must be an integer from 1 through 1000');
  }
  return count;
}

/** Account metadata is isolated by the wallet's first derived address. */
export async function loadAccountCount(walletFirstAddress: string): Promise<number> {
  const credentials = await Keychain.getGenericPassword({ service: walletService(walletFirstAddress) });
  if (!credentials) return 1;
  let saved: unknown;
  try { saved = JSON.parse(credentials.password); }
  catch { throw new Error('Could not read the saved account count'); }
  return validateCount(saved);
}

/** Serialize writes for one wallet so concurrent saves retain their order. */
export function saveAccountCount(walletFirstAddress: string, count: number): Promise<void> {
  const service = walletService(walletFirstAddress);
  const validCount = validateCount(count);
  const pending = (writes.get(service) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const saved = await Keychain.setGenericPassword('accounts', JSON.stringify(validCount), {
      service,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    if (!saved) throw new Error('Could not save the account count');
  });
  writes.set(service, pending);
  void pending.finally(() => { if (writes.get(service) === pending) writes.delete(service); }).catch(() => undefined);
  return pending;
}
