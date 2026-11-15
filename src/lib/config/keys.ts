/**
 * Single place that reads key and address configuration.
 *
 * Vite inlines `VITE_*` variables into the bundle at build time, so any key in
 * this file sits inside the bundle and can be extracted from a built AppImage.
 * These are not secrets but quota-bound identifiers, and they have to be
 * protected with provider-side limits rather than by hiding them.
 */

/**
 * Alchemy key, used to build an RPC URL when no public RPC is known for a
 * chain.
 */
export const ALCHEMY_KEY: string | undefined = import.meta.env.VITE_ALCHEMY_KEY;

/**
 * Infura token.
 *
 * Passed to status-go as `infuraToken`: `getMainnetRPCURL`
 * (pkg/backend/defaults.go) derives `VerifyENSURL` from it for ENS name
 * resolution.
 *
 * @remarks Without a token, `getMainnetRPCURL` returns an empty string and ENS
 * verification is skipped silently (internal/protocol/ens/verifier.go).
 */
export const INFURA_KEY: string | undefined = import.meta.env.VITE_INFURA_KEY;

/**
 * Log level for status-go. Unset means logging is off.
 *
 * Set `VITE_STATUS_LOG=debug` in `.env` for local work.
 *
 * @remarks Never enable this in a release build: `status.log` writes full RPC
 * provider URLs including their keys.
 */
export const STATUS_LOG_LEVEL: string | undefined = import.meta.env.VITE_STATUS_LOG;

/** Log file path. Defaults to `${dataDir}/status.log`. */
export const STATUS_LOG_FILE: string | undefined = import.meta.env.VITE_STATUS_LOG_FILE;

/**
 * Public RPCs (publicnode), the primary provider.
 *
 * All five mainnet endpoints answer in 0.12–0.18 s, while Alchemy under the
 * same conditions keeps the connection `ESTAB` but never replies
 * (`retrans ~10k`, backoff at maximum, a 192 KB `Send-Q` that does not drain).
 * Alchemy is therefore only a fallback.
 */
export const PUBLIC_RPC: Record<number, string> = {
  1: 'https://ethereum-rpc.publicnode.com',
  10: 'https://optimism-rpc.publicnode.com',
  56: 'https://bsc-rpc.publicnode.com',
  8453: 'https://base-rpc.publicnode.com',
  42161: 'https://arbitrum-one-rpc.publicnode.com',
  // Test networks. With `test-networks-enabled?` set, status-go treats these as
  // the active networks, and a network without an address here gets no provider
  // at all — no balance ever arrives for it.
  97: 'https://bsc-testnet-rpc.publicnode.com',
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
  11155420: 'https://optimism-sepolia-rpc.publicnode.com',
  84532: 'https://base-sepolia-rpc.publicnode.com',
  421614: 'https://arbitrum-sepolia-rpc.publicnode.com',
  560048: 'https://ethereum-hoodi-rpc.publicnode.com',
};

/** Alchemy network names, used as https://<host>.g.alchemy.com/v2/<key>. */
export const ALCHEMY_HOSTS: Record<number, string> = {
  1: 'eth-mainnet',
  10: 'opt-mainnet',
  8453: 'base-mainnet',
  42161: 'arb-mainnet',
  11155111: 'eth-sepolia',
  11155420: 'opt-sepolia',
  84532: 'base-sepolia',
  421614: 'arb-sepolia',
};

/** Name of the user provider belonging to this app; also used to detect it. */
export const USER_PROVIDER_NAME = 'stauri-rpc';

/**
 * Builds the fallback RPC URL for a chain from Alchemy.
 *
 * @param chainId - The chain id.
 * @returns The URL, or `null` when the chain has no Alchemy host or no key is
 * configured.
 */
export function alchemyUrlForChain(chainId: number): string | null {
  const host = ALCHEMY_HOSTS[chainId];
  if (host && ALCHEMY_KEY) {
    return `https://${host}.g.alchemy.com/v2/${ALCHEMY_KEY}`;
  }
  return null;
}

/**
 * Picks the primary RPC URL for a chain.
 *
 * @param chainId - The chain id.
 * @returns The public RPC when it is known, otherwise the Alchemy fallback,
 * otherwise `null`.
 */
export function rpcUrlForChain(chainId: number): string | null {
  return PUBLIC_RPC[chainId] ?? alchemyUrlForChain(chainId);
}
