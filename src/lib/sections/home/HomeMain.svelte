<script lang="ts">
  /**
   * Main part of the Home section.
   *
   * With no topic open, only the two main buttons are shown, centred in the
   * panel. With a topic open, its text sits at the top and the buttons stay
   * centred in the space that is left.
   *
   * @remarks
   * External links open in a dApp window (`open_dapp`), like any other external
   * address: the window has its own menu and the host in its title.
   */
  import { i18n } from '$lib/i18n';
  import { invoke } from '@tauri-apps/api/core';
  import { ExternalLink } from 'lucide-svelte';
  import { error } from '$lib/utils/log';
  import { TOPICS, type TopicId } from './homeTopics';

  let {
    topic,
    onNavigate,
  }: { topic: TopicId | null; onNavigate?: (section: string) => void } = $props();

  const current = $derived(TOPICS.find((t) => t.id === topic) ?? null);

  /** Opens a link in a dApp window. */
  async function openLink(url: string): Promise<void> {
    try {
      await invoke<string>('open_dapp', { url });
    } catch (e) {
      error(`[home] cannot open ${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
</script>

<div class="h-full flex flex-col bg-background">
  {#if current}
    <article class="max-h-[60%] overflow-y-auto p-6 border-b border-border bg-card">
      <div class="max-w-2xl mx-auto space-y-4">
        {#if current.id === 'web3im'}
          <h1 class="text-2xl font-bold text-foreground">{i18n.t('What is Web3 IM?')}</h1>
          <p class="text-sm text-muted-foreground leading-relaxed">
            {i18n.t(
              'A messenger where messages travel through a peer-to-peer network instead of a company server: no one holds the whole history, and no one can delete or read it. The wallet lives in the same app, because the identity behind the messages is the same key that holds the funds.'
            )}
          </p>
          <ul class="text-sm space-y-1 list-disc pl-5 text-foreground">
            <li>{i18n.t('No account on a server: the key pair is the account.')}</li>
            <li>{i18n.t('The seed phrase of 12 words is the master key for both the profile and the funds.')}</li>
            <li>{i18n.t('Messages are encrypted end to end; nodes relay them without reading them.')}</li>
          </ul>
        {:else if current.id === 'status-network'}
          <h1 class="text-2xl font-bold text-foreground">{i18n.t('What is the Status network?')}</h1>
          <p class="text-sm text-muted-foreground leading-relaxed">
            {i18n.t(
              'Status is a set of open-source programs — the Status app, the status-go engine and the Waku transport — that form one network. Nodes find each other through a boot list (a "fleet") and exchange sealed messages; the same network carries the messenger and the wallet traffic.'
            )}
          </p>
          <ul class="text-sm space-y-1 list-disc pl-5 text-foreground">
            <li>{i18n.t('Waku is the transport: it stores and forwards sealed envelopes.')}</li>
            <li>{i18n.t('A fleet is the list of starting nodes; Status runs a public one.')}</li>
            <li>{i18n.t('status-go is the engine; Stauri loads it as a library and draws its own interface.')}</li>
          </ul>
        {:else if current.id === 'difference'}
          <h1 class="text-2xl font-bold text-foreground">{i18n.t('Stauri vs Status.im')}</h1>
          <p class="text-sm text-muted-foreground leading-relaxed">
            {i18n.t(
              'Stauri uses the same engine and the same network as Status Desktop. The differences are two: the stack, and the vocabulary.'
            )}
          </p>
          <ol class="text-sm space-y-3 list-decimal pl-5 text-foreground">
            <li>
              <span class="font-medium">{i18n.t('Tauri + Svelte instead of Nix + Nim/QML.')}</span>
              {' '}{i18n.t(
                'The interface is a web front end in Svelte: a short edit cycle, one Rust code base on desktop and Android, and isolated windows for external dApps. Status Desktop is one monolith built with Nix in Nim and QML.'
              )}
            </li>
            <li>
              <span class="font-medium">{i18n.t('No "Community" in the interface; channels are ACC.')}</span>
              {' '}{i18n.t(
                'A Status community is a technical container with one channel. Stauri hides the container and shows channels (ACC) directly as the entity a user recognises.'
              )}
            </li>
          </ol>
        {:else}
          <h1 class="text-2xl font-bold text-foreground">{i18n.t('TODO / DONE')}</h1>
          <p class="text-sm text-muted-foreground leading-relaxed">
            {i18n.t('What works today and what is planned next. The list is short on purpose: only the items that shape the product.')}
          </p>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div class="rounded-lg border border-success/30 bg-success/10 p-4">
              <h2 class="font-semibold text-success mb-2">{i18n.t('DONE')}</h2>
              <ul class="space-y-1 list-disc pl-4 text-foreground">
                <li>{i18n.t('Profile: create, log in, seed phrase.')}</li>
                <li>{i18n.t('Chats, channels, contacts, comments.')}</li>
                <li>{i18n.t('Wallet: assets, send, receive, swap.')}</li>
                <li>{i18n.t('ENS name in the profile.')}</li>
                <li>{i18n.t('Market, external feeds, dApps in separate windows.')}</li>
                <li>{i18n.t('Four themes; four languages.')}</li>
              </ul>
            </div>
            <div class="rounded-lg border border-warning/30 bg-warning/10 p-4">
              <h2 class="font-semibold text-warning mb-2">{i18n.t('TODO')}</h2>
              <ul class="space-y-1 list-disc pl-4 text-foreground">
                <li>{i18n.t('Android build; Windows build.')}</li>
                <li>{i18n.t('Buy crypto for fiat (placeholder now).')}</li>
                <li>{i18n.t('window.ethereum in dApp windows.')}</li>
                <li>{i18n.t('Transaction history, NFTs, bridge.')}</li>
                <li>{i18n.t('Keycard, push notifications.')}</li>
              </ul>
            </div>
          </div>
        {/if}

        {#if current.link}
          <button
            onclick={() => openLink(current.link!.url)}
            class="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline break-all text-left"
          >
            <ExternalLink size={16} class="shrink-0" />
            {current.link.url}
          </button>
        {/if}
      </div>
    </article>
  {/if}

  <div class="flex-1 min-h-0 flex items-center justify-center gap-6 p-6">
    <button
      onclick={() => onNavigate?.('chat')}
      class="min-w-44 px-10 py-5 rounded-xl bg-primary text-primary-foreground text-lg font-semibold shadow-sm hover:opacity-90 transition"
    >
      {i18n.t('Chat')}
    </button>
    <button
      onclick={() => onNavigate?.('wallet')}
      class="min-w-44 px-10 py-5 rounded-xl bg-primary text-primary-foreground text-lg font-semibold shadow-sm hover:opacity-90 transition"
    >
      {i18n.t('Wallet')}
    </button>
  </div>
</div>
