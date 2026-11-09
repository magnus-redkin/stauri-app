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
   */
  onMount(() => {
    const block = (e: Event) => e.preventDefault();
    document.addEventListener("contextmenu", block, true);
    return () => document.removeEventListener("contextmenu", block, true);
  });
</script>

{@render children()}
