/**
 * Which tab is open in the Wallet section.
 *
 * The tab is changed from two places: the buttons in the right panel and the
 * "Manage accounts" link in the left one. Component-local state is invisible to
 * the left panel, and keeping a copy in both components guarantees drift — the
 * right panel would stay on Assets and the link would look broken again.
 */

export type WalletTab = 'assets' | 'send' | 'receive' | 'buy' | 'swap' | 'accounts';

export const walletView = $state({
  activeTab: 'assets' as WalletTab,
});

export function selectWalletTab(tab: WalletTab): void {
  walletView.activeTab = tab;
}

export function resetWalletView(): void {
  walletView.activeTab = 'assets';
}
