<script lang="ts">
  /**
   * Правая панель «пригласить контакт»: QR и ссылка на профиль.
   *
   * Ключ берётся из логина (`compressedKey`, формат `zQ3…`). Полную ссылку
   * `status.app/u/<payload>#<ключ>` строит только известный payload; пока он
   * не подтверждён, показываем сам ключ и QR с ним — это тот же ключ, что в
   * ссылке SIM после `#`, и по нему SIM добавляет контакт.
   */
  import { i18n } from '$lib/i18n';
  import { statusState } from '$lib/stores/statusStore.svelte';
  import QrCode from '$lib/components/QrCode.svelte';

  const key = $derived(statusState.compressedKey);
  let copied = $state(false);

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(key);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Буфер недоступен: ключ всё равно виден на экране.
    }
  }
</script>

<div class="flex-1 flex flex-col items-center justify-center p-6 gap-5 overflow-auto">
  <h2 class="text-lg font-semibold text-foreground">{i18n.t('Invite a contact')}</h2>

  {#if key}
    <QrCode value={key} size={220} />
    <p class="text-xs text-muted-foreground text-center max-w-sm">
      {i18n.t('Scan this code in SIM or send the key to add you as a contact.')}
    </p>
    <div class="w-full max-w-md flex gap-2 items-center">
      <code class="flex-1 min-w-0 truncate text-xs bg-secondary rounded-md px-3 py-2 font-mono">{key}</code>
      <button
 onclick={copyKey}
 class="shrink-0 h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium"
      >
 {copied ? i18n.t('Copied') : i18n.t('Copy')}
      </button>
    </div>
  {:else}
    <p class="text-sm text-muted-foreground">{i18n.t('Profile key is not loaded yet')}</p>
  {/if}
</div>
