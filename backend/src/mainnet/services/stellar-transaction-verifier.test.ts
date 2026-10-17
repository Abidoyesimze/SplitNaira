/**
 * Unit coverage for Stellar transaction-reference verification (Issue #1249).
 *
 * The explorer lookup is injected, so these tests exercise testnet and mainnet
 * behaviour without any network access.
 */
import { describe, expect, it, vi } from "vitest";

import {
  classifyStellarNetwork,
  isValidTransactionHash,
  verifyTransactionReference,
  type ExplorerTransaction,
  type FetchExplorerTransaction,
} from "./stellar-transaction-verifier.js";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

function lookup(
  transaction: ExplorerTransaction | null
): FetchExplorerTransaction {
  return vi.fn().mockResolvedValue(transaction);
}

describe("classifyStellarNetwork", () => {
  it("recognises testnet names and passphrases", () => {
    expect(classifyStellarNetwork("testnet")).toBe("testnet");
    expect(classifyStellarNetwork(TESTNET_PASSPHRASE)).toBe("testnet");
  });

  it("recognises mainnet names and passphrases", () => {
    expect(classifyStellarNetwork("mainnet")).toBe("mainnet");
    expect(classifyStellarNetwork(MAINNET_PASSPHRASE)).toBe("mainnet");
  });

  it("recognises futurenet", () => {
    expect(classifyStellarNetwork("Futurenet")).toBe("futurenet");
  });

  it("returns unknown for empty or unrecognised values", () => {
    expect(classifyStellarNetwork(undefined)).toBe("unknown");
    expect(classifyStellarNetwork("")).toBe("unknown");
    expect(classifyStellarNetwork("standalone")).toBe("unknown");
  });
});

describe("isValidTransactionHash", () => {
  it("accepts a 64-character hexadecimal hash", () => {
    expect(isValidTransactionHash(HASH)).toBe(true);
    expect(isValidTransactionHash(HASH.toUpperCase())).toBe(true);
  });

  it("rejects malformed hashes", () => {
    expect(isValidTransactionHash("abc")).toBe(false);
    expect(isValidTransactionHash("z".repeat(64))).toBe(false);
    expect(isValidTransactionHash(`${"a".repeat(63)}!`)).toBe(false);
  });
});

describe("verifyTransactionReference", () => {
  it("verifies a successful testnet transaction", async () => {
    const fetchTransaction = lookup({
      hash: HASH,
      successful: true,
      ledger: 42,
      network: TESTNET_PASSPHRASE,
    });

    const result = await verifyTransactionReference({
      txHash: HASH,
      expectedNetwork: "testnet",
      fetchTransaction,
    });

    expect(result.verified).toBe(true);
    if (result.verified) {
      expect(result.transaction.hash).toBe(HASH);
    }
    expect(fetchTransaction).toHaveBeenCalledWith(HASH);
  });

  it("verifies a successful mainnet transaction", async () => {
    const result = await verifyTransactionReference({
      txHash: OTHER_HASH,
      expectedNetwork: "mainnet",
      fetchTransaction: lookup({
        hash: OTHER_HASH,
        successful: true,
        network: MAINNET_PASSPHRASE,
      }),
    });

    expect(result.verified).toBe(true);
  });

  it("rejects a malformed hash without performing a lookup", async () => {
    const fetchTransaction = lookup({ hash: "bad", successful: true });

    const result = await verifyTransactionReference({
      txHash: "bad",
      expectedNetwork: "testnet",
      fetchTransaction,
    });

    expect(result).toMatchObject({ verified: false, reason: "invalid_hash" });
    expect(fetchTransaction).not.toHaveBeenCalled();
  });

  it("rejects a cross-network reference before the lookup", async () => {
    const fetchTransaction = lookup({ hash: HASH, successful: true });

    const result = await verifyTransactionReference({
      txHash: HASH,
      expectedNetwork: "mainnet",
      referencedNetwork: TESTNET_PASSPHRASE,
      fetchTransaction,
    });

    expect(result).toMatchObject({ verified: false, reason: "network_mismatch" });
    expect(fetchTransaction).not.toHaveBeenCalled();
  });

  it("rejects when the explorer reports a different network", async () => {
    const result = await verifyTransactionReference({
      txHash: HASH,
      expectedNetwork: "mainnet",
      fetchTransaction: lookup({
        hash: HASH,
        successful: true,
        network: TESTNET_PASSPHRASE,
      }),
    });

    expect(result).toMatchObject({ verified: false, reason: "network_mismatch" });
  });

  it("rejects a transaction that does not exist", async () => {
    const result = await verifyTransactionReference({
      txHash: HASH,
      expectedNetwork: "testnet",
      fetchTransaction: lookup(null),
    });

    expect(result).toMatchObject({
      verified: false,
      reason: "transaction_not_found",
    });
  });

  it("rejects a transaction that did not succeed", async () => {
    const result = await verifyTransactionReference({
      txHash: HASH,
      expectedNetwork: "testnet",
      fetchTransaction: lookup({ hash: HASH, successful: false }),
    });

    expect(result).toMatchObject({
      verified: false,
      reason: "transaction_failed",
    });
  });

  it("reports a lookup error when the network is unreachable", async () => {
    const fetchTransaction: FetchExplorerTransaction = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await verifyTransactionReference({
      txHash: HASH,
      expectedNetwork: "testnet",
      fetchTransaction,
    });

    expect(result).toMatchObject({ verified: false, reason: "lookup_error" });
  });

  it("does not block when the configured network is unknown", async () => {
    const result = await verifyTransactionReference({
      txHash: HASH,
      expectedNetwork: "unknown",
      referencedNetwork: MAINNET_PASSPHRASE,
      fetchTransaction: lookup({ hash: HASH, successful: true }),
    });

    expect(result.verified).toBe(true);
  });
});
