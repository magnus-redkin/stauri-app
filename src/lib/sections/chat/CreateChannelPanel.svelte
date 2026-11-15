<script lang="ts">
  /**
   * Right panel for creating a channel.
   *
   * Renders `CreateChannelForm` at panel size, which gives the description field
   * more room. Closing the panel returns to the conversation.
   */
  import { i18n } from '$lib/i18n';
  import CreateChannelForm from './CreateChannelForm.svelte';
  import { setRightPanel } from '$lib/stores/chatsStore.svelte';
</script>

<div class="flex-1 flex flex-col items-center justify-center overflow-auto">
  <h2 class="text-lg font-semibold text-foreground pt-6">{i18n.t('New channel')}</h2>
  <CreateChannelForm panel onDone={() => setRightPanel('chat')} />
</div>
