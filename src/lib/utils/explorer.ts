/**
 * Explorer URL templates for links to a transaction and to an address.
 *
 * ## Why not Etherscan
 *
 * `etherscan.io` and its testnet hosts (`sepolia.etherscan.io`,
 * `hoodi.etherscan.io`, `optimistic.etherscan.io`) do not open from this
 * network at all — the connection hangs until timeout (`code=000` after 12 s),
 * while `eth.blockscout.com` and `eth-sepolia.blockscout.com` answer in 0.3 s.
 * An Etherscan link shows a blank page even though the transaction was
 * confirmed.
 *
 * Blockscout is therefore the primary source: it opens without a VPN and
 * carries the same information. Optimism has its own explorer
 * (`explorer.optimism.io`; `optimism.blockscout.com` redirects there).
 *
 * ## BNB Chain
 *
 * BSC has no Blockscout of its own (`bsc.blockscout.com` returns 404), so it
 * keeps BscScan. BscScan answers `403` to scripts (Cloudflare protection) but
 * opens in a browser; the link is still valid.
 *
 * ## Unknown networks
 *
 * Return `null` rather than a dead link, so nobody concludes from a blank page
 * that the transaction never went out.
 */

/** Base explorer URL per supported chain. */
const EXPLORERS: Record<number, string> = {
  // mainnet
  1: 'https://eth.blockscout.com',
  10: 'https://explorer.optimism.io',
  56: 'https://bscscan.com',
  8453: 'https://base.blockscout.com',
  42161: 'https://arbitrum.blockscout.com',
  // testnets
  97: 'https://testnet.bscscan.com',
  560048: 'https://eth-hoodi.blockscout.com',
  84532: 'https://base-sepolia.blockscout.com',
  11155111: 'https://eth-sepolia.blockscout.com',
  11155420: 'https://testnet-explorer.optimism.io',
  421614: 'https://arbitrum-sepolia.blockscout.com',
};

/**
 * Builds the explorer link for a transaction.
 *
 * @param chainId - The EIP-155 chain id the transaction was sent on.
 * @param txHash - The transaction hash.
 * @returns The URL, or `null` when the hash is blank or the network has no
 * known explorer.
 * @remarks The hash is trimmed before the emptiness check: a whitespace-only
 * string passes that check but is not a hash, and would produce a dead `/tx/`
 * link.
 */
export function explorerTxUrl(chainId: number, txHash: string): string | null {
  // Trim before testing: a whitespace-only string passes an emptiness check
  // but is not a hash, and the link (`/tx/`) would be dead.
  const hash = txHash.trim();
  if (!hash) return null;
  const base = EXPLORERS[chainId];
  if (!base) return null;
  return `${base}/tx/${hash}`;
}

/**
 * Builds the explorer link for an address.
 *
 * @param chainId - The chain id the address is shown for.
 * @param address - The account address.
 * @returns The URL, or `null` when the address is blank or the network has no
 * known explorer.
 */
export function explorerAddressUrl(chainId: number, address: string): string | null {
  const value = address.trim();
  if (!value) return null;
  const base = EXPLORERS[chainId];
  if (!base) return null;
  return `${base}/address/${value}`;
}
