/**
 * dApp section: external data sources.
 *
 * Providers follow `docs/ru/providers_and_dapps.md`: third-party sources that
 * return **data** in a fixed schema. No code comes from them. There are two:
 * `communities` (the community directory from the Directory contract, kept here
 * because it is a provider, not a primary entity) and `feed` (a feed by URL,
 * RSS/Atom or `t.me/s/<name>`).
 *
 * @remarks
 * Invariants from the document: merging is local, so a provider is asked "give me
 * a list", never "what do I have"; provenance is always shown and cannot be
 * turned off; the order is ours, not the provider's; one broken source does not
 * break the rest.
 */

import { invoke } from "@tauri-apps/api/core";
import { warn } from "$lib/utils/log";
import { formatError } from "$lib/utils/errors";

/** Provider kind. The category is a string, as decided in the document. */
export type ProviderKind = "communities" | "feed";

export interface ProviderEntry {
  kind: ProviderKind;
  /** Glyph icon: no external assets. */
  icon: string;
  /** Localization key for the title. */
  title: string;
  /** Localization key for the subtitle. */
  subtitle: string;
  /** Whether it can be removed. Built-in ones (the directory) cannot. */
  removable: boolean;
}

/** Feed item — the same shape `fetch_feed` returns in Rust. */
export interface FeedItem {
  url: string;
  title: string;
  summary: string;
  published_at: number | null;
}

export interface FeedResponse {
  title: string;
  items: FeedItem[];
  /** Whose item this is: `t.me/<name>` or the host. Always shown. */
  source: string;
}

/**
 * An example dApp in the list.
 *
 * The list deliberately mixes three kinds, because to the user they all look the
 * same — a row with a name and an icon. The difference shows only after a click,
 * and that is fine: it lies in where the interface opens.
 *
 * * `builtin` — our own screen inside Stauri (the community directory). It looks
 *   like a dApp, but the data stays with us and we do the connecting;
 * * `external` — a real third-party app: separate window, its own origin, no
 *   access to our data;
 * * `prefill` — not a dApp at all but adding a provider: the click fills the
 *   input field of the matching category.
 */
export type DappExampleKind = "builtin" | "external" | "prefill";

export interface DappExample {
  id: string;
  /** Glyph icon: no external assets. */
  icon: string;
  /** Localization key for the name. */
  title: string;
  /** Localization key for the subtitle. */
  subtitle: string;
  kind: DappExampleKind;
  /** `builtin`: which provider to open. */
  provider?: ProviderKind;
  /** `external`: window address. */
  url?: string;
  /** `prefill`: where to place the address. */
  prefill?: { field: "feedUrl"; value: string };
}

export const dappsState = $state({
  providers: [
    {
      kind: "communities",
      icon: "◇",
      title: "Community directory",
      subtitle: "Browse communities from the Status contract",
      removable: false,
    },
    {
      kind: "feed",
      icon: "📡",
      title: "Channel feed",
      subtitle: "RSS, Atom or a public Telegram channel",
      removable: false,
    },
  ] as ProviderEntry[],

  /** Open provider (`null` when nothing is selected). */
  active: null as ProviderKind | null,

  /**
   * Draft feed address in the input field.
   *
   * The subscriptions themselves live in `feedsStore`: they survive a restart
   * and appear in the chat list, while the draft does not.
   */
  feedUrl: "",

  /** dApp address input field. */
  dappUrl: "",
  /** dApp window open error (usually the address failed validation). */
  dappError: "",
});

/**
 * dApp examples.
 *
 * The order is ours (`docs/ru/providers_and_dapps.md` §9.3): what the user most
 * often wants to open comes first, and adding providers — which are not dApps and
 * must not look like them in the same list — comes last.
 *
 * @remarks
 * The built-in directory is deliberately first: it is the only entry that works
 * without a network or a third-party server, which tells the user such a screen
 * exists at all.
 */
export const dappExamples: DappExample[] = [
  {
    id: "community-directory",
    icon: "◇",
    title: "Community directory",
    subtitle: "Built into Stauri: browse and join communities",
    kind: "builtin",
    provider: "communities",
  },
  {
    id: "remix",
    icon: "⬡",
    title: "Remix IDE",
    subtitle: "External dApp: write and compile Solidity contracts",
    kind: "external",
    url: "https://remix.ethereum.org",
  },
  {
    id: "etherscan",
    icon: "🔍",
    title: "Etherscan",
    subtitle: "External dApp: inspect any contract on mainnet",
    kind: "external",
    url: "https://etherscan.io",
  },
  {
    id: "add-feed",
    icon: "📡",
    title: "Add a feed",
    subtitle:
      "Adds a provider: an RSS/Atom address, or a channel read through an RSS bridge",
    kind: "prefill",
    prefill: { field: "feedUrl", value: "" },
  },
];

export function selectProvider(kind: ProviderKind | null) {
  dappsState.active = kind;
}

/**
 * Returns the section to the start: the examples screen and an empty address line.
 *
 * Used in two situations, both about user expectation: the "back" button in a
 * provider panel, and a second click on the dApps icon in the first column. The
 * latter matters because `activeSection` already equals `dapps`, so without an
 * explicit reset clicking one's own tab would do nothing while the user expects
 * to leave an open directory.
 *
 * @remarks
 * Subscriptions are NOT cleared: they are saved data, not navigation. The user
 * returns to them by selecting the provider again.
 */
export function resetDappsView() {
  dappsState.active = null;
  dappsState.dappError = "";
  dappsState.feedUrl = "";
}

/**
 * Opens an external dApp in a separate window.
 *
 * @param url - Address to open; the input field value when omitted.
 * @remarks
 * The address is validated in Rust (`dapp.rs`), not here: the decision whether
 * this origin may be opened must not depend on what the webview managed to run.
 *
 * There is no link to the main window by design (§12): the user carries back only
 * text — a copied channel address or a string they paste themselves.
 */
export async function openDapp(url?: string): Promise<void> {
  const target = (url ?? dappsState.dappUrl).trim();
  if (!target) {
    dappsState.dappError = "Enter a dApp address";
    return;
  }

  dappsState.dappError = "";
  try {
    await invoke<string>("open_dapp", { url: target });
    if (!url) dappsState.dappUrl = "";
  } catch (e) {
    dappsState.dappError = formatError(e);
    warn("[dapps] failed to open dApp:", e);
  }
}

/**
 * Action for a click on an example.
 *
 * The three kinds behave differently, and that is the whole difference: `builtin`
 * switches to our own screen, `external` opens a window, `prefill` only fills the
 * field — the user still sees the address and clicks "add".
 *
 * @param example - The example that was clicked.
 * @remarks
 * A provider must not appear without explicit confirmation, which is why
 * `prefill` never adds one itself.
 */
export function activateExample(example: DappExample): void {
  switch (example.kind) {
    case "builtin":
      if (example.provider) selectProvider(example.provider);
      break;
    case "external":
      if (example.url) void openDapp(example.url);
      break;
    case "prefill":
      if (example.prefill) {
        dappsState.feedUrl = example.prefill.value;
        selectProvider("feed");
      }
      break;
  }
}

export function removeProvider(kind: ProviderKind) {
  const idx = dappsState.providers.findIndex((p) => p.kind === kind);
  if (idx < 0) return;
  const provider = dappsState.providers[idx];
  if (!provider.removable) return;

  dappsState.providers.splice(idx, 1);
  if (dappsState.active === kind) dappsState.active = null;
}

// Feed loading lives in `feedsStore`: adding an address there creates a
// subscription and an entry in the chat list rather than just a view in the
// provider panel. A second copy of URL normalization here would diverge on the
// first edit.

export function resetDapps() {
  dappsState.active = null;
  dappsState.feedUrl = "";
}
