<script lang="ts">
  import { i18n } from '$lib/i18n';
  import { untrack } from 'svelte';
  import { statusState, setSeedSaved } from '$lib/stores/statusStore.svelte';
  import { ensState, loadProfileNames } from '$lib/stores/ensStore.svelte';
  import { User } from 'lucide-svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import CreateSeed from './CreateSeed.svelte';
  import EnsNameBlock from './EnsNameBlock.svelte';

  let { onNavigate }: { onNavigate?: (section: string) => void } = $props();

  let originalDisplayName = $state(statusState.alias || '');
  let displayName = $state(originalDisplayName);
  let userpicOpen = $state(false);
  let showCreateSeed = $state(false);

  let isChanged = $derived(displayName !== originalDisplayName);

  function saveProfile() {
    if (!isChanged) return;
    // TODO: API-вызов для сохранения (отложено)
    statusState.alias = displayName;
    originalDisplayName = displayName;
  }

  function handleSeedSaved() {
    setSeedSaved(true);
    showCreateSeed = false;
  }

  /**
   * Имена профиля читаются при открытии раздела.
   *
   * `untrack` вокруг вызова обязателен: `loadProfileNames` пишет
   * `ensState.profileNames`, и без него эффект, читающий изменяемое им же
   * состояние, перезапускал бы сам себя. Это уже случалось с `loadChats`
   * (см. `routes/+page.svelte`).
   *
   * Читаем здесь, а не при входе в аккаунт, потому что имя в профиле
   * показывается только в профиле: запрос при логине почти всегда некому
   * показать.
   */
  $effect(() => {
    const loggedIn = statusState.isLoggedIn;
    if (!loggedIn) return;
    untrack(() => {
      loadProfileNames();
    });
  });
</script>

{#if showCreateSeed}
  <CreateSeed
    onBack={() => showCreateSeed = false}
    onSave={handleSeedSaved}
  />
{:else}
  <div class="p-8 max-w-2xl mx-auto w-full h-full flex flex-col bg-card">
    <h2 class="text-2xl font-bold text-primary mb-6">{i18n.t('Edit Profile')}</h2>

    <div class="flex flex-col gap-6 max-w-md mx-auto w-full">
      <!-- Аватар -->
      <div class="flex items-center gap-4">
        <div class="w-20 h-20 rounded-full bg-secondary flex items-center justify-center text-muted-foreground">
          <User size={36} />
        </div>
        <button onclick={() => userpicOpen = true} class="text-sm text-primary hover:underline">
          {i18n.t('Upload Userpic')}
        </button>
      </div>

      <!-- Display Name -->
      <div>
        <label class="text-sm font-medium text-foreground">Display Name</label>
        <input
          bind:value={displayName}
          class="w-full h-10 border border-input rounded-md px-3 mt-1 bg-background"
        />
      </div>

      <!-- ENS-имя профиля -->
      <EnsNameBlock />

      <!--
        Имя ENS как подпись под ником.
        Показывается только когда профиль о нём знает (`ens_getEnsUsernames`,
        см. `loadProfileNames`). Полная форма обязательна: сокращённая не
        резолвится ни в одном клиенте, и человек ввёл бы её в поле получателя
        безрезультатно.
      -->
      {#if ensState.profileNames.length > 0}
        <p class="text-xs text-muted-foreground font-mono break-all">
          {ensState.profileNames[0]}
        </p>
      {/if}

      <!-- Блок Seed-фразы -->
        {#if statusState.isSeedSaved}
          <div class="p-3 rounded-lg border bg-green-100 text-green-800 border-green-300">
            ✅ {i18n.t('Seed-фраза сохранена')}
          </div>
        {:else}
          <button
            onclick={() => showCreateSeed = true}
            class="w-full p-3 rounded-lg border bg-red-100 text-red-700 border-red-300 hover:bg-red-200 transition-colors text-left flex items-center justify-between"
            >
            <span>⚠️ {i18n.t('Создать seed-фразу')}</span>
          </button>
        {/if}
        <!-- Кнопка Save -->
          <div class="mt-4">
            <button
              onclick={() => {
              saveProfile(); // сохраняет displayName
              onNavigate?.('home'); // переходит на Home
              }}
              class="w-full py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition"
              >
              {i18n.t('Save')}
            </button>
          </div>
    </div>
  </div>

  <!-- Модалка Userpic -->
  <Dialog.Root bind:open={userpicOpen}>
    <Dialog.Content class="sm:max-w-[425px]">
      <Dialog.Header>
        <Dialog.Title>{i18n.t('Upload Userpic')}</Dialog.Title>
      </Dialog.Header>
      <div class="p-4 border-2 border-dashed border-border rounded-lg text-center">
        <p class="text-sm text-muted-foreground">{i18n.t('Drag and drop image here, or click to select')}</p>
        <input type="file" accept="image/*" class="mt-2" />
      </div>
      <Dialog.Footer>
        <button onclick={() => userpicOpen = false} class="w-full py-2 bg-primary text-primary-foreground rounded-md">
          {i18n.t('Close')}
        </button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{/if}
