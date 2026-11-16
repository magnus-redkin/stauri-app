/**
 * RPC provider setup for status-go.
 *
 * Pure configuration logic: it holds no reactive connection state, no `$state`
 * and no socket.
 */

import { statusState } from './statusStore.svelte';
import { debug } from '$lib/utils/log';
import { formatError } from '$lib/utils/errors';
import {
  getFlatEthereumChains,
  setChainUserRpcProvider,
  startRpcProxy,
  setRpcUpstreams,
  getRpcProxySecret,
} from '$lib/status/api';
import { PUBLIC_RPC, USER_PROVIDER_NAME, rpcUrlForChain } from '$lib/config/keys';

/**
 * Result of a provider setup pass.
 *
 * `wroteProviders` says whether anything had to be written. It is a signal that
 * the RPC client may have been built against the wrong URLs: status-go creates
 * and caches clients on node start, while providers are written afterwards. See
 * `login` in `connection.svelte`.
 */
export type ConfigureResult = { wroteProviders: boolean };

/**
 * Writes a working RPC provider for every active network.
 *
 * The built-in status-go providers are unusable: direct-grove points at
 * eth.rpc.grove.city, which no longer resolves, and direct-infura times out.
 * A direct provider call from status-go also sticks on dead TCP connections
 * from its pool (see `src-tauri/src/rpc_proxy.rs`), so the provider points at a
 * local forwarder instead of the network: `http://127.0.0.1:<port>/<chainId>`.
 *
 * @returns Whether any provider had to be written.
 * @remarks
 * Must be called after login and before the first wallet access: RPC clients
 * are cached by chainID in `internal/rpc/client.go` and are not invalidated
 * when providers change, so a write after the first request has no effect
 * until the node restarts.
 *
 * `networks_setChainUserRpcProviders` only accepts a provider with
 * `type: "user"`; status-go appends it alongside the built-in ones and picks it
 * first. For mainnet status-go ignores this provider and keeps its built-in
 * endpoints.
 */
export async function configureWalletRpc(): Promise<ConfigureResult> {
  if (!statusState.backendRunning) return { wroteProviders: false };

  // 1. Start the forwarder FIRST, without status-go. Its API registers only in
  // initServices, i.e. after node start, so network calls fail before login.
  // The forwarder is a Tauri command available at any time, and its port must be
  // accepted before status-go builds its RPC clients: the provider address is
  // already in the DB from a previous run, so a client can reach it immediately.
  let proxyPort: number;
  let proxySecret: string | null = null;
  try {
    // The table is passed at start: a provider left from the previous run
    // already points at this port, and the first request arrives before a
    // separate set_rpc_upstreams command could run.
    proxyPort = await startRpcProxy(PUBLIC_RPC);
    // The secret is part of the provider path: status-go calls the forwarder
    // and the node cannot send its auth token as a header, so without the
    // secret any process on the machine (and any site in a dApp WebView) would
    // reach the RPC.
    proxySecret = await getRpcProxySecret();
    debug(`[configureWalletRpc] rpc proxy on 127.0.0.1:${proxyPort}`);
  } catch (e: any) {
    // The forwarder port is fixed because providers in the status-go DB already
    // point at it. If the port is taken, there is no "direct" fallback: the node
    // client would still hit the old address and reach another process or be
    // refused. Report the reason instead of degrading silently.
    const reason = formatError(e);
    statusState.errorMsg = reason;
    console.error('[configureWalletRpc] rpc proxy failed:', reason);
    proxyPort = 0;
  }

  // 2. Refine URLs from the active networks in status-go, if the node is up.
  let chains: any[];
  try {
    chains = await getFlatEthereumChains();
  } catch (e) {
    // Before node start the networks service is not registered yet. That is not
    // an error — the forwarder already runs with the static table.
    debug('[configureWalletRpc] networks API not ready yet:', e);
    // No providers were seen and nothing was written, so nothing can be
    // concluded about the RPC client. A node restart is pointless here; the
    // caller simply skips it.
    return { wroteProviders: false };
  }

  const upstreams: Record<number, string> = { ...PUBLIC_RPC };
  for (const chain of chains) {
    const chainId = Number(chain?.chainId);
    if (!chainId || !chain.enabled || !chain.isActive) continue;
    const url = rpcUrlForChain(chainId);
    if (url) upstreams[chainId] = url;
  }

  if (proxyPort) {
    try {
      await setRpcUpstreams(upstreams);
    } catch (e: any) {
      console.warn(
        '[configureWalletRpc] failed to update proxy upstreams:',
        formatError(e)
      );
    }
  }

  let wroteProviders = false;

  for (const chain of chains) {
    const chainId = Number(chain?.chainId);
    // Field names follow params.Network: enabled and isActive, not active.
    if (!chainId || !chain.enabled || !chain.isActive) continue;

    const direct = upstreams[chainId];
    if (!direct) continue;

    // Go through the forwarder when it started, otherwise use the URL directly.
    //
    // The path must contain the secret: the forwarder rejects requests without
    // it (answering 404 so as not to reveal its presence). status-go, not the
    // frontend, calls the forwarder, so the secret lives in the URL rather than
    // a header.
    const url =
      proxyPort && proxySecret
        ? `http://127.0.0.1:${proxyPort}/${proxySecret}/${chainId}`
        : direct;

    if (proxyPort && !proxySecret) {
      // No secret but the forwarder started: an inconsistent state, and going
      // direct is not an option because the node client still targets our port.
      console.error(
        '[configureWalletRpc] rpc proxy started without a secret; providers not updated'
      );
      continue;
    }

    // Compare by URL, not only by name: a provider may be left over from an
    // earlier configuration (for example one pointing at a dead Alchemy host on
    // this machine), and then it must be overwritten.
    const existing = (chain.rpcProviders || []).find(
      (p: any) => p.type === 'user' && p.name === USER_PROVIDER_NAME
    );
    if (existing && existing.url === url) continue;

    try {
      await setChainUserRpcProvider(chainId, USER_PROVIDER_NAME, url);
      wroteProviders = true;
      debug(
        `[configureWalletRpc] chain ${chainId}: provider ` +
          (existing ? 'updated' : 'added')
      );
    } catch (e: any) {
      console.warn(`[configureWalletRpc] chain ${chainId} failed:`, formatError(e));
    }
  }

  return { wroteProviders };
}
