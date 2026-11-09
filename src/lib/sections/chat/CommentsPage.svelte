<script lang="ts">
  import { i18n } from '$lib/i18n';
  import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
  import { sendComment } from '$lib/status/akk';
  import { statusState } from '$lib/stores/statusStore.svelte';
  import { chatsState } from '$lib/stores/chatsStore.svelte';
  import { formatMessageText } from '$lib/utils/user';
  import { formatError } from '$lib/utils/errors';
  import { error } from '$lib/utils/log';

  /**
   * Запись, к которой открыт экран, и её ответы.
   *
   * Ответы приходят уже отфильтрованными родителем: здесь только отображение
   * и отправка.
   */
  let {
    post,
    replies,
    onBack,
    onSent,
    canWrite,
    authorNameOf,
  }: {
    post: any;
    replies: any[];
    onBack: () => void;
    onSent: (sent: any) => void;
    canWrite: boolean;
    authorNameOf: (msg: any) => string;
  } = $props();

  let text = $state('');
  let isSending = $state(false);

  async function send() {
    const chat = chatsState.selected;
    const port = statusState.backendPort;
    if (!text.trim() || !chat || !port || isSending) return;
    isSending = true;
    const body = text;
    try {
      const res = await sendComment(port, chat.id, chat.communityId || '', post.id, body);
      const sent = (res as any)?.result?.messages?.find(
        (m: any) => m.text === body && m.responseTo === post.id
      );
      onSent(sent ?? { text: body, responseTo: post.id, from: statusState.publicKey || 'me', outgoingStatus: 'sending' });
      text = '';
    } catch (e) {
      error('[comments] send failed', e);
      statusState.errorMsg = formatError(e);
    } finally {
      isSending = false;
    }
  }
</script>

<div class="h-full flex flex-col bg-card">
  <div class="p-4 border-b border-border flex items-center gap-3">
    <button onclick={onBack} class="text-sm text-muted-foreground hover:text-foreground" aria-label={i18n.t('Back')}>
      ←
    </button>
    <span class="font-bold text-primary truncate">{chatsState.selected?.name}</span>
  </div>

  <ScrollArea class="flex-1 min-h-0">
    <div class="p-4 space-y-4">
      <!-- Исходная запись: только текст -->
      <div class="text-sm">
        <div class="font-bold">{authorNameOf(post)}</div>
        <div class="whitespace-pre-wrap break-words">{formatMessageText(post.text, chatsState.contacts)}</div>
      </div>

      <div class="space-y-3 border-t border-border pt-3">
        {#if replies.length === 0}
   <p class="text-muted-foreground text-sm italic">{i18n.t('No comments yet')}</p>
        {:else}
   {#each replies as reply (reply.id)}
     <div class="text-sm">
       <div class="font-bold">{authorNameOf(reply)}</div>
       <div class="whitespace-pre-wrap break-words">{formatMessageText(reply.text, chatsState.contacts)}</div>
     </div>
          {/each}
        {/if}
      </div>
    </div>
  </ScrollArea>

  {#if canWrite}
    <div class="p-4 border-t border-border flex gap-2">
      <input
        bind:value={text}
        placeholder={i18n.t('Write a comment...')}
 onkeydown={(e) => { if (e.key === 'Enter') send(); }}
 class="flex-1 px-3 py-2 border border-input rounded-md bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
      <button onclick={send} disabled={isSending} class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium disabled:opacity-50">
 {i18n.t('Send')}
      </button>
    </div>
  {/if}
</div>
