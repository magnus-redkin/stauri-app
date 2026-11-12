<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  let { children } = $props();

  /**
   * Браузерное меню правой кнопки (Back/Reload/Inspect) отключаем глобально.
   *
   * Reload из него перезагружал webview и сбрасывал состояние входа: после
   * перезагрузки пароль уже не принимался («Login timeout: no response from
   * backend»), и вход возможен был только после перезапуска приложения.
   *
   * Перехват в фазе capture, чтобы сработать раньше обработчиков компонентов.
   * Своего контекстного меню в приложении нет; когда появится, оно должно
   * открываться по событию, а не через браузерное меню.
   *
   * Исключение — поля ввода: на Android долгое нажатие в поле открывает меню
   * «Вставить», и без него туда нельзя вставить текст (ключ приглашения,
   * адрес). Блокируем только вне полей и областей редактирования.
   */
  onMount(() => {
    const block = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"], [contenteditable=""]')) {
        return;
      }
      e.preventDefault();
    };
    document.addEventListener("contextmenu", block, true);
    return () => document.removeEventListener("contextmenu", block, true);
  });
</script>

{@render children()}
