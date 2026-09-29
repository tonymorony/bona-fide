import {
  hashTypedData,
  hexToBigInt,
  hexToNumber,
  isAddressEqual,
  parseAbi,
  recoverAddress,
  size,
  slice,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

/** The escrow's EIP-712 domain. */
export function escrowDomain(chainId: number, escrow: Address) {
  return { name: "BonaFide", version: "1", chainId, verifyingContract: escrow } as const;
}

export const FORFEIT_TYPES = {
  Forfeit: [
    { name: "key", type: "bytes32" },
    { name: "serial", type: "uint256" },
    { name: "sigDeadline", type: "uint256" },
  ],
} as const;

export function forfeitDigest(
  chainId: number,
  escrow: Address,
  message: { key: Hex; serial: bigint; sigDeadline: bigint },
): Hex {
  return hashTypedData({
    domain: escrowDomain(chainId, escrow),
    types: FORFEIT_TYPES,
    primaryType: "Forfeit",
    message,
  });
}

export const BINDING_TYPES = {
  Binding: [
    { name: "repo", type: "string" },
    { name: "maintainer", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** `repo` is "github:" and the lowercase owner/repo, as hashed into the repoId. */
export function bindingDigest(
  chainId: number,
  escrow: Address,
  message: { repo: string; maintainer: Address; nonce: Hex; deadline: bigint },
): Hex {
  return hashTypedData({
    domain: escrowDomain(chainId, escrow),
    types: BINDING_TYPES,
    primaryType: "Binding",
    message,
  });
}

const ERC1271 = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"]);
const ERC1271_MAGIC = "0x1626ba7e";
const HALF_CURVE_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

/**
 * Checks a signature the way the escrow does (OpenZeppelin's SignatureChecker): an address with
 * code must accept it through ERC-1271; any other address must have made it as a 65-byte ECDSA
 * signature with a low s and v of 27 or 28.
 */
export async function isValidSignatureNow(
  client: PublicClient,
  signer: Address,
  digest: Hex,
  signature: Hex,
): Promise<boolean> {
  const code = await client.getCode({ address: signer });
  if (code === undefined || code === "0x") return isEcdsaSignature(signer, digest, signature);
  try {
    const magic = await client.readContract({
      address: signer,
      abi: ERC1271,
      functionName: "isValidSignature",
      args: [digest, signature],
    });
    return magic === ERC1271_MAGIC;
  } catch {
    return false;
  }
}

async function isEcdsaSignature(signer: Address, digest: Hex, signature: Hex): Promise<boolean> {
  if (size(signature) !== 65) return false;
  const v = hexToNumber(slice(signature, 64, 65));
  if ((v !== 27 && v !== 28) || hexToBigInt(slice(signature, 32, 64)) > HALF_CURVE_ORDER) return false;
  try {
    return isAddressEqual(await recoverAddress({ hash: digest, signature }), signer);
  } catch {
    return false;
  }
}
