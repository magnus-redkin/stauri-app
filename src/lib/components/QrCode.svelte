<script lang="ts">
  /**
   * Renders a QR code locally, with no network request.
   *
   * A remote image service would learn the wallet address and that its owner
   * uses Stauri every time the Receive tab is opened, and a third-party host is
   * not in the CSP (`svelte.config.js`) anyway, so the image would not load.
   * Widening the security policy to allow such a host would trade a leak for a
   * picture.
   *
   * `qrcode` is a devDependency because it is only needed at build time: Vite
   * bundles its code, so a failure surfaces during `build` rather than at
   * runtime.
   */
  import QRCode from 'qrcode';

  let { value, size = 192 }: { value: string; size?: number } = $props();

  /**
   * The rendered image as a data URI, or the error text.
   *
   * `data:` is allowed by the CSP (`img-src`), so the result is shown as a plain
   * `<img>` with no external request.
   */
  let dataUrl = $state('');
  let failed = $state('');

  /**
   * Re-renders whenever the value changes.
   *
   * The output is `image/png`, not SVG: an SVG string used as `src` still runs
   * as a document, and although there is no user markup here, PNG removes the
   * question. `margin: 0` drops the white border, which the container supplies.
   */
  $effect(() => {
    const text = value;
    if (!text) {
      dataUrl = '';
      failed = '';
      return;
    }

    let cancelled = false;
    QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M',
      margin: 0,
      width: size,
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((url) => {
        if (cancelled) return;
        dataUrl = url;
        failed = '';
      })
      .catch((e) => {
        if (cancelled) return;
        // The address is also shown as copyable text next to the code, so a
        // failed render does not block receiving funds — report it and go on.
        dataUrl = '';
        failed = String(e);
        console.error('[qr] failed to render:', e);
      });

    return () => {
      cancelled = true;
    };
  });
</script>

<div
  class="bg-white rounded-lg border border-border p-3 flex items-center justify-center shrink-0"
  style="width: {size + 24}px; height: {size + 24}px"
>
  {#if dataUrl}
    <img src={dataUrl} width={size} height={size} alt="" aria-label="QR code" />
  {:else if failed}
    <span class="text-xs text-destructive text-center px-2">QR unavailable</span>
  {:else}
    <span class="text-xs text-muted-foreground">…</span>
  {/if}
</div>
