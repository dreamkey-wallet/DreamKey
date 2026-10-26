import { Interface, Transaction, getAddress, getBytes } from 'ethers';

const BASE_MAINNET = 8453;
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';
const oracle = new Interface([
  'function getL1Fee(bytes unsignedTransaction) view returns (uint256)',
  'function getL1FeeUpperBound(uint256 unsignedTransactionSize) view returns (uint256)',
  'function getOperatorFee(uint256 gasUsed) view returns (uint256)',
]);

export interface NetworkFeeProvider {
  getTransactionCount(address: string, blockTag: 'pending'): Promise<number>;
  call(transaction: { to: string; data: string }): Promise<string>;
}

/** The same recipient, calldata, value and reviewed gas fields passed to send. */
export interface NetworkFeeTransaction {
  from: string;
  to: string;
  data?: string;
  value?: bigint;
  gasLimit: bigint;
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface AdditionalNetworkFees {
  /** Current L1 data fee plus operator fee for the estimated execution gas. */
  estimatedExtraFee: bigint;
  /** Buffered current estimate, not a protocol-enforced total fee cap. */
  bufferedExtraFee: bigint;
  l1DataFee: bigint;
  operatorFee: bigint;
  /** L1/operator fees can change between review and inclusion. */
  totalIsEstimate: boolean;
}

export class NetworkFeeUnavailableError extends Error {
  readonly code = 'NETWORK_FEE_UNAVAILABLE';

  constructor() {
    super('Additional network fee estimate is unavailable.');
    this.name = 'NetworkFeeUnavailableError';
  }
}

/**
 * Base execution gas excludes Ethereum data publication fees. Use its predeploy
 * instead of reproducing fee formulas, which change across OP Stack upgrades.
 * The current oracle also accounts for Jovian operator fees (currently zero on
 * Base). Arbitrum's estimateGas already includes its L1 publication gas portion.
 *
 * Only public transaction fields are serialized; no signature or broadcast is
 * made here. Oracle/nonce failures reject so the send screen cannot omit fees.
 * Sources: docs.base.org/specifications/transactions/network-fees and
 * ethereum-optimism/optimism packages/contracts-bedrock/src/L2/GasPriceOracle.sol.
 */
export async function estimateAdditionalNetworkFees(
  provider: NetworkFeeProvider,
  chainId: number,
  transaction: NetworkFeeTransaction,
  gasEstimate: bigint,
): Promise<AdditionalNetworkFees> {
  if (chainId !== BASE_MAINNET) {
    return { estimatedExtraFee: 0n, bufferedExtraFee: 0n, l1DataFee: 0n, operatorFee: 0n, totalIsEstimate: false };
  }

  try {
    if (gasEstimate <= 0n || transaction.gasLimit < gasEstimate) throw new Error('Invalid gas estimate');
    const hasDynamicFees = transaction.maxFeePerGas !== undefined && transaction.maxPriorityFeePerGas !== undefined;
    if (hasDynamicFees ? transaction.gasPrice !== undefined : transaction.gasPrice === undefined) throw new Error('Incomplete gas fields');
    if (!hasDynamicFees && (transaction.maxFeePerGas !== undefined || transaction.maxPriorityFeePerGas !== undefined)) throw new Error('Incomplete gas fields');
    if (hasDynamicFees && transaction.maxPriorityFeePerGas! > transaction.maxFeePerGas!) throw new Error('Invalid priority fee');

    const nonce = await provider.getTransactionCount(getAddress(transaction.from), 'pending');
    if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Invalid nonce');
    const unsigned = Transaction.from({
      type: hasDynamicFees ? 2 : 0,
      chainId,
      nonce,
      to: getAddress(transaction.to),
      data: transaction.data ?? '0x',
      value: transaction.value ?? 0n,
      gasLimit: transaction.gasLimit,
      ...(hasDynamicFees
        ? { maxFeePerGas: transaction.maxFeePerGas, maxPriorityFeePerGas: transaction.maxPriorityFeePerGas }
        : { gasPrice: transaction.gasPrice }),
    }).unsignedSerialized;

    const query = async (method: string, argument: bigint | string): Promise<bigint> => {
      const result = await provider.call({ to: GAS_PRICE_ORACLE, data: oracle.encodeFunctionData(method, [argument]) });
      const value: unknown = oracle.decodeFunctionResult(method, result)[0];
      if (typeof value !== 'bigint' || value < 0n) throw new Error('Invalid oracle fee');
      return value;
    };

    // The oracle itself adds 68 signature bytes. Extra space here only reserves
    // nonce/RLP-length growth if another transaction is submitted after review.
    const unsignedSizeBudget = BigInt(getBytes(unsigned).length + 16);
    const [l1DataFee, l1SizeBudget, operatorFee, operatorGasBudget] = await Promise.all([
      query('getL1Fee', unsigned),
      query('getL1FeeUpperBound', unsignedSizeBudget),
      query('getOperatorFee', gasEstimate),
      query('getOperatorFee', transaction.gasLimit),
    ]);
    const currentBudget = (l1SizeBudget > l1DataFee ? l1SizeBudget : l1DataFee)
      + (operatorGasBudget > operatorFee ? operatorGasBudget : operatorFee);
    return {
      estimatedExtraFee: l1DataFee + operatorFee,
      bufferedExtraFee: (currentBudget * 120n + 99n) / 100n,
      l1DataFee,
      operatorFee,
      totalIsEstimate: true,
    };
  } catch {
    throw new NetworkFeeUnavailableError();
  }
}
