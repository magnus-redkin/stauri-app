/**
 * Topics of the About menu on the Home section.
 *
 * Each topic opens in the right panel. A topic may carry one external link; it
 * opens in a dApp window, the same way any external address does.
 */

/** Identifier of one topic; also the key of its title in the locale files. */
export type TopicId = 'web3im' | 'status-network' | 'difference' | 'roadmap';

/** External link of a topic: opened in a dApp window. */
export interface TopicLink {
  url: string;
}

/** Order of the menu, top to bottom. */
export const TOPICS: { id: TopicId; title: string; link?: TopicLink }[] = [
  {
    id: 'web3im',
    title: 'What is Web3 IM?',
    link: { url: 'https://github.com/magnus-redkin/stauri-app/blob/main/docs/ru/web3im.md' },
  },
  {
    id: 'status-network',
    title: 'What is the Status network?',
    link: { url: 'https://status.app/' },
  },
  {
    id: 'difference',
    title: 'Stauri vs Status.im',
    link: { url: 'https://github.com/magnus-redkin/stauri-app/blob/main/docs/ru/comparison.md' },
  },
  { id: 'roadmap', title: 'TODO / DONE' },
];
