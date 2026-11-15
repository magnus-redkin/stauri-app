/**
 * Facade over the backend connection modules.
 *
 * Keeps a single import path for the connection API so callers do not depend on
 * the internal split: RPC provider setup lives in `rpcConfig`, the `/signals`
 * socket in `ws`, and connection state with the login flows in
 * `connection.svelte`. New code should import from those modules directly.
 */

export { configureWalletRpc } from './rpcConfig';
export type { ConfigureResult } from './rpcConfig';

export { isWsOpen, openWs, closeWs } from './ws';

export {
  connectionState,
  connect,
  changeNetwork,
  login,
  createAccount,
  disconnect,
} from './connection.svelte';
