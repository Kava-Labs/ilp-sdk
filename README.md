# Interledger SDK

[![NPM Package](https://img.shields.io/npm/v/@kava-labs/switch-api.svg?style=flat-square&logo=npm)](https://npmjs.org/package/@kava-labs/switch-api)
[![CircleCI](https://img.shields.io/circleci/project/github/Kava-Labs/ilp-sdk/master.svg?style=flat-square&logo=circleci)](https://circleci.com/gh/kava-labs/ilp-sdk)
[![Codecov](https://img.shields.io/codecov/c/github/kava-labs/ilp-sdk/master.svg?style=flat-square&logo=codecov)](https://codecov.io/gh/kava-labs/ilp-sdk)
[![Prettier](https://img.shields.io/badge/code_style-prettier-brightgreen.svg?style=flat-square)](https://prettier.io/)
[![License](https://img.shields.io/npm/l/@kava-labs/switch-api.svg?style=flat-square)](https://github.com/Kava-Labs/ilp-sdk/blob/master/LICENSE)

### Streaming cross-chain payments between BTC, ETH, DAI and XRP with Interledger

In ~20 lines of code,

- :money_with_wings: **Configure and deposit funds into layer 2 networks**
- :checkered_flag: **Swap assets in seconds with Interledger**
- :lock: **Retain full asset custody & securely withdraw funds**

_(Try [Switch](https://github.com/kava-labs/switch), a non-custodial Interledger wallet, for an example of an app built with this SDK!)_

## Overview

The SDK is built around the concept of an uplink, which is a relationship with a connector, or money router, using a particular settlement mechanism. Any number of uplinks can be configured, with different private keys/accounts on the base ledger, connected to different connectors.

Create different types of uplinks, based upon the settlement mechanism & asset:

| Uplink Type  | Supported Asset(s) | Settlement Mechanism                                     |
| :----------- | :----------------- | :------------------------------------------------------- |
| `Lnd`        | BTC                | Bitcoin Lightning Network using LND                      |
| `Machinomy`  | ETH, DAI           | Machinomy unidirectional payment channels on Ethereum    |
| `XrpPaychan` | XRP                | Native unidirectional payment channels on the XRP ledger |

By default, the SDK connects to the Kava testnet connector; user-defined connectors will be supported in the near future. However, Kava's [connector configuration](https://github.com/kava-labs/connector-config) is open-source, enabling you to run a local connector for development.

## Install

```bash
npm i @kava-labs/switch-api
```

## Usage

### Connect the SDK

Create an instance of the SDK, which automatically connects to the underlying ledgers.

```js
import { connect, LedgerEnv, SettlementEngineType } from '@kava-labs/switch-api'

// Connect on testnet (default)
const sdk = await connect()

// Connect on mainnet
const sdk = await connect(LedgerEnv.Mainnet)

// Alternatively, run a local connector using Kava's connector-config
const sdk = await connect(LedgerEnv.Local)
```

#### Persistence

The SDK can serialize an object with all the configured uplinks, credentials, and payment channel claims like so:

```js
const config = sdk.serializeConfig()
```

If a persistence layer was implemented on top of the SDK, the consumer could, for example, stringify the config object as JSON and persist it to the filesystem.

To load a config object into the SDK, it may optionally be passed on `connect`. For example:

```js
const sdk = await connect(
  LedgerEnv.Testnet,
  config
)
```

**Funds may be lost if the configuration is not saved.**

#### Configure Machinomy (ETH)

In testnet mode, Machinomy uplinks use the Kovan testnet on Ethereum. Kovan ether can be requested from [this faucet](https://faucet.kovan.network/).

```js
const ethUplink = await sdk.add({
  settlerType: SettlementEngineType.Machinomy,
  privateKey: '36fa71e0c8b177cc170e06e59abe8c83db1db0bae53a5f89624a891fd3c285a7'
})
```

#### Configure Machinomy (DAI)

```js
const ethUplink = await sdk.add({
  settlerType: SettlementEngineType.Machinomy,
  assetType: 'DAI',
  privateKey: '36fa71e0c8b177cc170e06e59abe8c83db1db0bae53a5f89624a891fd3c285a7'
})
```

#### Configure XRP

In testnet mode, XRP uplinks use Ripple's XRP testnet. To generate a new secret on the XRP testnet (with 10,000 test XRP), use [Ripple's faucet](https://developers.ripple.com/xrp-test-net-faucet.html).

```js
const xrpUplink = await sdk.add({
  settlerType: SettlementEngineType.XrpPaychan,
  secret: 'ssPr1eagnXCFdD8xJsGXwTBr29pFF'
})
```

#### Configure Lightning

Lightning uplinks require an LND node connected to the Bitcoin mainnet or testnet (depending upon which environment the SDK is configured for). They also require a base64-encoded macaroon and base64-encoded TLS certificate to connect to the LND node over gRPC. (Optionally, provide a `grpcPort` if the LND node is configured to use a non-default port).

```js
const btcUplink = await sdk.add({
  settlerType: SettlementEngineType.Lnd,
  hostname: 'localhost',
  macaroon:
    'AgEDbG5kArsBAwoQ3/I9f6kgSE6aUPd85lWpOBIBMBoWCgdhZGRyZXNzEgRyZWFkEgV3cml0ZRoTCgRpbmZvEgRyZWFkEgV32ml0ZRoXCghpbnZvaWNlcxIEcmVhZBIFd3JpdGUaFgoHbWVzc2FnZRIEcmVhZBIFd3JpdGUaFwoIb2ZmY2hhaW4SBHJlYWQSBXdyaXRlGhYKB29uY2hhaW4SBHJlYWQSBXdyaXRlGhQKBXBlZXJzEgRyZWFkEgV3cml0ZQAABiAiUTBv3Eh6iDbdjmXCfNxp4HBEcOYNzXhrm+ncLHf5jA==',
  tlsCert:
    'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUNpRENDQWkrZ0F3SUJBZ0lRZG81djBRQlhIbmppNGhSYWVlTWpOREFLQmdncWhrak9QUVFEQWpCSE1SOHcKSFFZRFZRUUtFeFpzYm1RZ1lYVjBiMmRsYm1WeVlYUmxaQ0JqWlhKME1TUXdJZ1lEVlFRREV4dEtkWE4wZFhOegpMVTFoWTBKdmIyc3RVSEp2TFRNdWJHOWpZV3d3SGhjTk1UZ3dPREl6TURVMU9ERXdXaGNOTVRreE1ERTRNRFUxCk9ERXdXakJITVI4d0hRWURWUVFLRXhac2JtUWdZWFYwYjJkbGJtVnlZWFJsWkNCalpYSjBNU1F3SWdZRFZRUUQKRXh0S2RYTjBkWE56TFUxaFkwSnZiMnN0VUhKdkxUTXViRzlqWVd3d1dUQVRCZ2NxaGtqT1BRSUJCZ2dxaGtpTwpQUU1CQndOQ0FBU0ZoUm0rdy9UMTBQb0t0ZzRsbTloQk5KakpENDczZmt6SHdQVUZ3eTkxdlRyUVNmNzU0M2oyCkpyZ0ZvOG1iVFYwVnRwZ3FrZksxSU1WS01MckYyMXhpbzRIOE1JSDVNQTRHQTFVZER3RUIvd1FFQXdJQ3BEQVAKQmdOVkhSTUJBZjhFQlRBREFRSC9NSUhWQmdOVkhSRUVnYzB3Z2NxQ0cwcDFjM1IxYzNNdFRXRmpRbTl2YXkxUQpjbTh0TXk1c2IyTmhiSUlKYkc5allXeG9iM04wZ2dSMWJtbDRnZ3AxYm1sNGNHRmphMlYwaHdSL0FBQUJoeEFBCkFBQUFBQUFBQUFBQUFBQUFBQUFCaHhEK2dBQUFBQUFBQUFBQUFBQUFBQUFCaHhEK2dBQUFBQUFBQUF3bGM5WmMKazdiRGh3VEFxQUVFaHhEK2dBQUFBQUFBQUJpTnAvLytHeFhHaHhEK2dBQUFBQUFBQUtXSjV0bGlET1JqaHdRSwpEd0FDaHhEK2dBQUFBQUFBQUc2V3ovLyszYXRGaHhEOTJ0RFF5djRUQVFBQUFBQUFBQkFBTUFvR0NDcUdTTTQ5CkJBTUNBMGNBTUVRQ0lBOU85eHRhem1keENLajBNZmJGSFZCcTVJN0pNbk9GUHB3UlBKWFFmcllhQWlCZDVOeUoKUUN3bFN4NUVDblBPSDVzUnB2MjZUOGFVY1hibXlueDlDb0R1ZkE9PQotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg=='
})
```

### Deposit

Depositing to an uplink involves moving funds from the base layer to the layer 2 network or payment channel. Funds are still under the client's custody, but can be quickly sent to the connector when streaming between assets.

The behavior is slightly different depending upon the type of settlement.

- **Lightning**: no-operation. (The configured Lightning node must already have connectivity to the greater Lightning network. Although a direct channel or channel closer in proximity to the connector provides a better experience, opening those channels is currently out of the scope of this SDK).
- **Machinomy & XRP**: If no channel is open, funds a new payment channel to the connctor and requests an incoming channel. If there's already an existing outgoing channel, it will deposit additional funds to that channel. The SDK will calculate the precise fee and invoke a callback to approve it before submitting the on-chain transaction.

```js
await sdk.deposit({
  /** Uplink to deposit to */
  uplink: ethUplink,

  /**
   * Amount to deposit, in the unit of exchange
   * (e.g. in this case, ether; not gwei or wei)
   */
  amount: new BigNumber(0.05),

  /**
   * Callback to authorize the fee and amount to be transferred from layer 1, after it's calculated,
   * which must return a Promise
   */
  authorize: async ({ fee }) => {
    console.log('Fee:', fee.amount.toString())

    // Resolve the Promise continue with the deposit...
    return

    // ...or reject the Promise to cancel it:
    throw new Error('Fee too high!')
  }
})
```

### Balances

The SDK is designed to precisely report balances and incoming/outgoing capacity in realtime, including while performing a streaming exchange.

Each uplink exposes several RxJS observables as properties that emit amounts denominated in the unit of exchange (e.g. BTC, ETH, XRP) of that uplink.

##### `balance$`

> `BehaviorSubject<BigNumber>`

Emits the total balance in layer 2 that can be claimed on the base ledger if the client tried to withdraw funds at that moment (the amount in the client's custody).

- **Lightning**: the total balance of all channels on the Lightning node. This is refreshed at a regular interval if Lightning payments are sent/received outside of the SDK. (Note: when streaming payments, although there is a minor latency for Lightning balance updates to be reflected, the trust limits are still strictly enforced internally.)
- **Machinomy & XRP**: the balance is the remaining (unspent) capacity in the outgoing payment channel, plus the total amount received in the incoming payment channel.

```js
ethUplink.balance$.subscribe(amount => {
  console.log('Interledger balance:', amount.toString())
})
```

##### `availableToSend$`

> `BehaviorSubject<BigNumber>`

Emits the total amount immediately available to send over Interledger (outgoing capacity plus the amount prefunded).

##### `availableToReceive$`

> `BehaviorSubject<BigNumber>`

Emits the total amount immediately available to receive over Interledger (incoming capacity minus the amount of credit already extended).

##### `outgoingCapacity$`

> `BehaviorSubject<BigNumber>`

Emits the amount of money in custody in layer 2, immediately available to send to the peer.

- **Lightning**: the total funds available across all open Lightning channels.
- **Machinomy & XRP**: remaining (unspent) capacity in the outgoing payment channel in this uplink's custody.

##### `incomingCapacity$`

> `BehaviorSubject<BigNumber>`

Emits the amount of money the peer has custody over in layer 2, immediately available for the peer to send to this uplink.

- **Lightning**: `Infinity` (since LND doesn't provide a simple mechanism to fetch it)
- **Machinomy & XRP**: remaining (unspent) capacity in the incoming payment channel in the peer's custody.

##### `totalSent$`

> `BehaviorSubject<BigNumber>`

Emits the amount we've sent in layer 2 that is _unavailble_ to receive (money that the peer cannot directly send back to us).

- **Lightning**: `0`
- **Machinomy & XRP**: total amount spent in the outgoing payment channel in the peer's custody.

##### `totalReceived$`

> `BehaviorSubject<BigNumber>`

Emits the amount we've received in layer 2 that is _unavailble_ to send (money that cannot be directly sent back to the peer).

- **Lightning**: `0`
- **Machinomy & XRP**: total amount spent from the incoming payment channel in this uplink's custody.

### Trade (switch!)

At it's core, the SDK enables streaming exchanges between assets with very limited counterparty risk.

#### Non-custodial Trading

When trading between assets, a very small amount of the source/sending asset (the equivalent of \$0.10 USD, by default) is prefunded in advance of the the connector sending the destination/receiving asset. If at any point the connector stops sending or sends too little of the destination asset, the stream is stopped, effectively enabling non-custodial trading, since the counterparty risk can be set arbitrarily low.

#### Exchange Rates

Switch uses a price oracle to fetch exchange rates, and rejects packets if they drop below that rate, minus a configurable slippage margin. (Currently [CoinCap](https://coincap.io/) is used, although more oracles may be supported in the future). The acceptable exchange rate is constantly updated in the background to account for market fluctuations.

#### Performance

Trades using streaming micropayments are _fast_.

Here are some unscientific benchmarks in optimal conditions to send \$2 of the source asset:

| Source | Destination | Time (ms) | Value per second |
| :----- | :---------- | :-------- | :--------------- |
| ETH    | XRP         | 150.1     | 266x trust limit |
| XRP    | ETH         | 196.4     | 203x trust limit |
| XRP    | BTC         | 3119.6    | 13x trust limit  |
| ETH    | BTC         | 3048.0    | 13x trust limit  |
| BTC    | ETH         | 3822.9    | 10x trust limit  |
| BTC    | XRP         | 3962.2    | 10x trust limit  |

- These were taken from [this test in CircleCI](https://circleci.com/gh/Kava-Labs/ilp-sdk/3) (likely hosted in AWS) using Kava's testnet connector (hosted in AWS). Your mileage may vary. However, for peers _very_ close in proximity to one another, the results are remarkable.
- \$0.05 was the amount prefunded/trust limit, so ~40 packets/roundtrips were required for each payment

The key metric is "value per second," or if you only trust your peer for _x_, how much money can you move in one second? In the case of the XRP/ETH pairs, sometimes as high as **200 times** your trust limit can be transferred, _per second_. Under real world conditions, that's likely hard to attain, but with a very low-latency internet connection, a few dozen times the trust limit per second is possible.

The bottom line: the latency of settlements is critical in how long a payment takes. In the case of ETH and XRP, the latency is the time it takes to send a message to the peer. In the case of Lightning, individual settlements take longer so the entire payment takes longer: they involve the latency from the sender, to their LND node (likely remote), over some number of hops in the Lightning network (which can be quite slow), to the peer's LND node, to the peer's connector. If there are intermediary hops in Interledger, it may also take longer, although they likely wouldn't be limited by the speed of settlements, since the service providers in the middle likely have higher trust between one another.

(Note: logging can also significantly slow streaming performance).

#### Example

```js
await sdk.streamMoney({
  /** Amount to send in units of exchange of the source uplink */
  amount: new BigNumber(0.02),

  /** Sending uplink */
  source: ethUplink,

  /** Receiving uplink */
  dest: xrpUplink,

  /** Optionally, specify a maximum slippage margin against the most recently fetched exchange rate */
  slippage: 0.02
})
```

### Withdraw

Withdrawing from an uplink moves all funds from layer 2 back to the base layer. An uplink can no longer be used after funds are withdrawn and should be removed.

```js
await sdk.withdraw({
  /** Uplink to withdraw from */
  uplink: ethUplink,

  /**
   * Callback to authorize the fee and amount to be transferred to layer 1, after it's calculated,
   * which must return a Promise
   */
  authorize: async ({ fee, value }) => {
    console.log('Fee:', fee.amount.toString())

    // Resolve the Promise continue with the withdrawal...
    return

    // ...or reject the Promise to cancel it:
    throw new Error('Fee too high!')
  }
})

await sdk.remove(ethUplink)
```

### Disconnect

Gracefully disconnect the SDK to end the session:

```js
await sdk.disconnect()
```

## Known Issues

- By design, clients do not currently pay for incoming capacity on ETH nor XRP. However, that's not a sustainable solution. In order to scale and prevent liquidity denial of service attacks, clients should pay a fee to "buy" incoming capacity/bandwidth for a period of time. However, this negotiation and accounting adds a great deal of complexity.
- Uplinks don't operate an internal `ilp-connector`, which may introduce some minor security risks. We intend to update this after the internal plugin architecture is refactored.
- Machinomy nor XRP payment channels don't currently support external watchtowers, which can become a security risk if a client is offline for an extended period of time and the connector disputes the channel.
- The speed of Lightning settlements degrades significantly as the number of hops increases, and is currently much slower than XRP or ETH. Functionality to open a direct channel with the peered connector could help improve this.

## Roadmap

- [x] ETH, XRP and Lightning support
- [x] Fast and secure streaming exchanges
- [x] Support for Electron
- [x] Serialize uplink configurations
- [x] Mainnet release
- [x] Support for ERC-20 tokens such as DAI
- [ ] Internal refactoring/improving code quality
- [ ] Support for user-defined connectors
- [ ] Generate invoices/receive payments via internal STREAM server
- [ ] Send peer-to-peer payments using STREAM & SPSP
