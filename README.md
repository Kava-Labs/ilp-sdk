# switch-api

### Streaming cross-chain payments between BTC, ETH and XRP with Interledger

---

:rotating_light: **Don't use this with real money, and expect breaking changes while in beta.**

---

In ~20 lines of code,

- :money_with_wings: **Configure and deposit funds into layer 2 networks**
- :checkered_flag: **Swap assets in seconds with Interledger**
- :lock: **Retain full asset custody & securely withdraw funds**

---

- Supports 3 assets: Bitcoin, using the Lightning Network; ether, using Machinomy payment channels; and XRP, using its native payment channels.
- Streaming exchanges between assets, optimized to complete in seconds
- Near zero counterparty risk: enables non-custodial trading. The default trust limit? 10¢.
- Real-time updates of layer 2 balances and channel capacity

While this a library for clients to connect to Interledger, if you want to become a connector/liquidity provider, check out our companion [connector configuration](https://github.com/kava-labs/connector-config).

### Uplinks

The API is built around the concept of an uplink, which is a relationship with a connector using a particular settlement mechanism. Any number of uplinks can be configured, with different private keys/accounts on the base ledger, connected to different connectors.

Create different types of uplinks, based upon the settlement mechanism & asset:

| Settlement Engine | Supported Asset(s)       |                                                         |
| :---------------- | :----------------------- | ------------------------------------------------------- |
| `Lnd`             | Bitcoin                  | Bitcoin Lightning Network using LND                     |
| `Machinomy`       | Ether _(soon, ERC-20s!)_ | Machinomy unidirectional payment channels on Ethereum   |
| `XrpPaychan`      | XRP                      | Native payment channels on the XRP decentralized ledger |

### Configuration

#### Connect the API

Create an instance of the API, which also connects to the underlying ledgers (on testnet by default).

```js
const { state, add } = await connectSwitch()

// state.uplinks => Uplink[]
```

#### Machinomy

```js
const ethUplink = await add({
  settlerType: SettlementEngineType.Machinomy,
  ethereumPrivateKey: 'TODO'
})
```

#### XRP

```js
const xrpUplink = await add({
  settlerType: SettlementEngineType.XrpPaychan,
  xrpSecret: 'TODO'
})
```

#### Lightning

```js
const btcUplink = await add({
  settlerType: SettlementEngineType.Lnd
  // TODO Add examples here! (use lndconnect example)
})
```

### Deposit

Depositing to an uplink involves moving funds from the base layer to the layer 2 network or payment channel. Funds are still under the client's custody, but can be quickly sent to the connector when streaming between assets.

The behavior is slightly different depending upon the type of settlement.

- **Lightning**: no-operation. (The configured Lightning node must already have connectivity to the greater Lightning network. Although a direct channel or channel closer in proximity to the connector provides a better experience, opening those channels is currently out of the scope of this API).
- **Machinomy & XRP**: If no channel is open, funds a new payment channel to the connctor and requests an incoming channel. If there's already an existing outgoing channel, it will deposit additional funds to that channel. The API will calculate the precise fee and invoke a callback to approve it before submitting the on-chain transaction.

```js
await deposit({
  /** Uplink to deposit to */
  uplink: ethUplink,
  /** Amount to deposit, in units of exchange */
  amount: new BigNumber(0.05),
  /** Callback to authorize the fee and amount to be transferred from layer 1, after it's calculated */
  authorize: (params: { fee: BigNumber, value: BigNumber }): Promise<any> => {
    /**
     * Resolve the promise to continue the deposit,
     * or reject the promise to cancel it
     */
  }
})
```

### Balances

The API is designed to precisely report balances and incoming/outgoing capacity in realtime.

Each uplink exposes several RxJS observables as properties that emit amounts denominated in the unit of exchange (e.g. BTC, ETH, XRP) of that uplink.

##### `balance$`

> `BehaviorSubject<BigNumber>`

Emits the total balance in layer 2 that can be claimed on the base ledger if the client tried to withdraw funds at that moment (the amount in the client's custody).

- **Lightning**: the total balance of all channels on the Lightning node. This is refreshed at a regular interval if Lightning payments are sent/received outside of the API. (Note: when streaming payments, although there is a minor latency for Lightning balance updates to be reflected, the trust limits are still strictly enforced internally.)
- **Machinomy & XRP**: the balance is the remaining (unspent) capacity in the outgoing payment channel, plus the total amount received in the incoming payment channel.

### Trade (switch!)

At it's core, the API enables streaming exchanges between assets with very limited counterparty risk.

When trading between assets, a very small amount of the source/sending asset (the equivalent of \$0.05 USD, by default) is prefunded in advance of the the connector sending the destination/receiving asset. If at any point the connector stops sending or sends too little of the destination asset, the stream is stopped, and the total losses are capped at twice the prefund (although the cost of the on-chain transactions to create/close the channels must also be accounted for). This effectively enables non-custodial trading, since the counterparty risk can be set arbitrarily low.

TODO This can be changed so it's capped directly at the prefund, and not twice the prefund!

To determine the exchange rate, the API uses a price oracle (currently CoinCap, although more may be supported in the future), and rejects packets if they drop below that, minus a configurable slippage margin. The acceptable exchange rate is constantly updated in the background to account for market flucuations.

TODO Speeeeeed! (Include benchmarks?)

TODO Example of streaming exchange

### Withdraw

Withdrawing from an uplink moves all funds from layer 2 back to the base layer.

### Known Issues

- Currently, no state is persisted, meaning payment channels claims and credentials are not saved after the session ends. We've architected the API to enable this, and it's a top priority within the next week or two.
- By design, clients do not currently pay for incoming capacity on ETH nor XRP. However, that's not a sustainable solution. In order to scale and prevent liquidity denial of service attacks, clients should pay a fee to "buy" incoming capacity/bandwidth for a period of time. However, this negotiation and accounting adds a great deal of complexity.
- TODO Uplinks don't presently operate an internal `ilp-connector`, which may introduce some security risks. We intend to update this after the internal plugin architecture is refactored.
- The speed of Lightning settlements degrades significantly as the number of hops increases, and even with a direct channel between peers, is currently much slower than XRP or ETH. While we can make some minor optimizations to improve this, it's mostly inherent to Lightning.
- Machinomy payment channels don't currently support watchtowers, which can become a security risk if a client is offline for an extended period of time and the connector disputes the channel. (In XRP, this is less of an issue, since the on-chain fees are low enough that regular checkpoints of the latest claim can be submitted to the ledger).
- Our XRP implementation introduces some minor security issues for servers that will be resolved at a later date; clients are unaffected.

### Roadmap

- [ ] Persistence and encryption of the configuration, so the uplinks and payment channel claims are restored between sessions (very soon)
- [ ] Additional assets, including ERC-20 tokens such as DAI
- [ ] Generate invoices/receive payments via internal STREAM server
- [ ] Send peer-to-peer payments using STREAM & SPSP
