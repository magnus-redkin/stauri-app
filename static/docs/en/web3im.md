# In short: what Web3 is, and why a messenger needs a wallet

An explanation for readers who are hearing about Web3, seed phrases and distributed
messengers for the first time. As few terms as possible, each with an everyday analogy.

Next: `comparison.md` (how Stauri differs from Status), `architecture.md`
(how it works inside).

---

## 1. What Web3 is, plainly

An ordinary website is a program running on someone else's server. The server keeps the
data, decides who sees what, and can delete or change everything. You trust it because
there is no alternative.

**Web3** is an approach where what matters is not kept on one company's server but spread
across a network where thousands of independent participants each hold a copy. No one can
rewrite the shared history alone.

An analogy: not a notice board in a company office, but notices posted all over the city.
One copy can be torn down, the rest stay, and everyone can see who wrote what.

## 2. A wallet is not a bank account

In a bank, money is a record in the bank's database: the bank knows you have 1,000 and can
freeze it.

In Web3 there is no money as an object at all. There is a **shared ledger** (a blockchain)
that says: "address 0xabc… holds 30 coins". Everyone can know this; only the holder of the
key can spend it.

Two things that surprise people at first:

- **Address** — like an account number; you can give it to anyone. Public information.
- **Key** — like a signature with which you confirm "send 30 coins there". Never shown to
  anyone.

In Stauri the key never leaves your machine.

## 3. The seed phrase: twelve words instead of a password

A password can be restored through support. Here there is no support — and that is not an
oversight, it is the point.

Your key is not stored on a server: it is **computed** from the twelve words handed to you
when the profile is created. Whoever knows those twelve words owns all your funds and your
name on the network.

The rules are simple and have no exceptions:

- write them on paper, not in a file and not in a screenshot;
- never type them into a website or a "wallet" that asks for them;
- anyone offering to "check your phrase" is stealing it.

The other side: lose the phrase, lose the funds. There is no one to restore them.

**Address, seed phrase and key are the same thing at different levels of access:** they
describe the same property. The address can be shown; the phrase never.

## 4. Messages without a server

Signal and Telegram keep your messages on their servers. Telegram with public chats stores
them unencrypted.

A distributed messenger works differently: the message is encrypted on your device and
carried through a network of **relays** (in the Status ecosystem, Waku). Relays see only
sealed envelopes and know neither what is inside nor who is talking to whom.

An analogy: a note in a sealed envelope passed along a chain of couriers. Each courier sees
the envelope, not the contents or the addressee.

Practical consequences:

- there is no "main server" that can be switched off or ordered to hand over data;
- there is no "restore the conversation" on a new device if the key is lost;
- messages may arrive more slowly than in Telegram.

## 5. A name instead of an address

A wallet address looks like this: `0xb38d22bb977817262787b746913e06baff0aaeb2`.

It is inconvenient to give to a person: one typo and the money goes nowhere.

Hence **names** (ENS — a naming system on top of Ethereum). A name looks like a domain:
`magnus-redkin.stateofus.eth`. It is bound to an address, and a person only has to type the
name.

Two things worth keeping apart:

- `stateofus.eth` — a domain managed by Status. Names under it cost a fixed deposit in SNT
  tokens and are issued for a year.
- `.eth` — the general Ethereum domain, where names have a market price and can be bought
  and sold.

Stauri does the first.

## 6. dApp: other people's programs asking for your wallet

A **dApp** is an application running on top of a blockchain: an exchange, a game, a
contract analyser. Such a site usually asks to "connect a wallet" in order to see your
address and ask you to sign something.

One habit matters here: **read what exactly you are asked to sign**. A signature is
irreversible, and no support will undo it.

In Stauri, dApps open in a separate window that has no access to your messages, your keys
or the Stauri interface itself. A signature is always shown by our own screens, never by a
foreign interface.

## 7. What of this is in Stauri

| Concept | Where in Stauri |
|---|---|
| Wallet address | "Wallet" → "Receive": address and QR |
| Seed phrase | "Profile" → create a seed phrase, shown word by word |
| ENS name | "Profile" → register `name.stateofus.eth` |
| Transfers | "Wallet" → "Send" (ETH and ERC-20 tokens) |
| Token swap | "Wallet" → "Swap" (Ethereum mainnet only) |
| Messages | "Chat", "Contacts", communities |
| External feeds | "dApps" → channel source (RSS, Telegram through a bridge) |
| dApp in a separate window | "dApps" → open an address |
| Market prices | "Market" (through CoinGecko) |

Not there yet: transaction history, NFTs, buying crypto for fiat, a mobile client.

## 8. Three terms you will meet later

- **Mainnet** — the main Ethereum network, where coins are real.
- **Testnet** (Sepolia and others) — a training network. Coins there are toys, obtained
  free from a "faucet". A mistake on a testnet costs nothing, which is why every money
  feature is tried there first.
- **Gas** — the fee for writing an action into the blockchain. Charged in ETH and
  independent of the amount sent. That is why sending a token also needs some ETH on the
  balance, even when you already hold the token.
