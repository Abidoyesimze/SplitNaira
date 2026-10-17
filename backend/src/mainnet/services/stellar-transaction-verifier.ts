/**
 * Stellar transaction-reference verification for payment processing
 * (Issue #1249).
 *
 * Before a confirmed transaction reference is accepted we must be sure it
 * actually exists on the Stellar network the backend is configured for. This
 * module is deliberately free of direct RPC/network dependencies: the caller
 * injects a `fetchTransaction` lookup, which keeps the verification logic
 * unit-testable and lets callers reuse the same Soroban/Horizon client already
 * used elsewhere in the backend.
 *
 * The verifier enforces, in order:
 *  1. the reference is a well-formed 64-character hexadecimal transaction hash;
 *  2. the reference's claimed network (if any) matches the configured network,
 *     rejecting cross-network references before any lookup is attempted;
 *  3. the transaction exists on the network (`transaction_not_found` otherwise);
 *  4. the explorer-reported network matches the configured network;
 *  5. the transaction completed successfully.
 */

export type StellarNetworkName = "mainnet" | "testnet" | "futurenet" | "unknown";

export interface ExplorerTransaction {
  /** Transaction hash as reported by the explorer/RPC. */
  hash: string;
  /** Whether the transaction reached a successful ledger result. */
  successful: boolean;
  /** Ledger sequence the transaction was included in, when known. */
  ledger?: number;
  /** Network passphrase or network name reported alongside the transaction. */
  network?: string;
}

export type FetchExplorerTransaction = (
  txHash: string
) => Promise<ExplorerTransaction | null>;

export interface VerifyTransactionReferenceInput {
  /** The 64-character hexadecimal transaction hash to verify. */
  txHash: string;
  /** The network the backend is configured to operate on. */
  expectedNetwork: StellarNetworkName;
  /**
   * The network the caller claims the reference belongs to. When provided and
   * it does not match `expectedNetwork`, the reference is rejected immediately.
   */
  referencedNetwork?: string;
  /** Network lookup used to confirm existence/status of the transaction. */
  fetchTransaction: FetchExplorerTransaction;
}

export type TransactionVerificationFailureReason =
  | "invalid_hash"
  | "network_mismatch"
  | "transaction_not_found"
  | "transaction_failed"
  | "lookup_error";

export interface TransactionVerificationFailure {
  verified: false;
  reason: TransactionVerificationFailureReason;
  message: string;
}

export interface TransactionVerificationSuccess {
  verified: true;
  transaction: ExplorerTransaction;
}

export type TransactionVerificationResult =
  | TransactionVerificationSuccess
  | TransactionVerificationFailure;

const TRANSACTION_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * Classifies a network passphrase or name into a canonical network identifier.
 *
 * Accepts either a short name ("mainnet", "testnet") or a full Stellar network
 * passphrase ("Public Global Stellar Network ; September 2015",
 * "Test SDF Network ; September 2015").
 */
export function classifyStellarNetwork(
  value: string | undefined | null
): StellarNetworkName {
  if (!value) {
    return "unknown";
  }

  const normalized = value.toLowerCase();
  if (normalized.includes("future")) {
    return "futurenet";
  }
  if (normalized.includes("test")) {
    return "testnet";
  }
  if (normalized.includes("public") || normalized.includes("mainnet")) {
    return "mainnet";
  }
  return "unknown";
}

export function isValidTransactionHash(txHash: string): boolean {
  return TRANSACTION_HASH_PATTERN.test(txHash);
}

function fail(
  reason: TransactionVerificationFailureReason,
  message: string
): TransactionVerificationFailure {
  return { verified: false, reason, message };
}

export async function verifyTransactionReference(
  input: VerifyTransactionReferenceInput
): Promise<TransactionVerificationResult> {
  const { txHash, expectedNetwork, referencedNetwork, fetchTransaction } = input;

  if (!isValidTransactionHash(txHash)) {
    return fail(
      "invalid_hash",
      "Transaction reference must be a 64-character hexadecimal hash."
    );
  }

  // Reject cross-network references before spending a network round-trip.
  if (
    referencedNetwork &&
    expectedNetwork !== "unknown" &&
    classifyStellarNetwork(referencedNetwork) !== expectedNetwork
  ) {
    return fail(
      "network_mismatch",
      "Transaction reference belongs to a different Stellar network."
    );
  }

  let transaction: ExplorerTransaction | null;
  try {
    transaction = await fetchTransaction(txHash);
  } catch {
    return fail(
      "lookup_error",
      "Unable to reach the Stellar network to verify the transaction."
    );
  }

  if (!transaction) {
    return fail(
      "transaction_not_found",
      "Transaction reference was not found on the configured Stellar network."
    );
  }

  // An explorer may report the network it observed; trust it only as a
  // consistency check so a testnet hash can never settle a mainnet payment.
  if (
    transaction.network &&
    expectedNetwork !== "unknown" &&
    classifyStellarNetwork(transaction.network) !== expectedNetwork
  ) {
    return fail(
      "network_mismatch",
      "Transaction reference belongs to a different Stellar network."
    );
  }

  if (!transaction.successful) {
    return fail(
      "transaction_failed",
      "Transaction reference did not complete successfully."
    );
  }

  return { verified: true, transaction };
}
