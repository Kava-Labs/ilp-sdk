import { convert, usd, xrp, drop, xrpBase } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import XrpAsymClient, {
  PaymentChannelClaim,
  PaymentChannel
} from 'ilp-plugin-xrp-asym-client'
import { deriveAddress, deriveKeypair } from 'ripple-keypairs'
import { RippleAPI } from 'ripple-lib'
import { MemoryStore } from '../../utils/store'
import createLogger from '../../utils/log'
import { createSubmitter } from 'ilp-plugin-xrp-paychan-shared'
import { PluginWrapper } from '../../utils/middlewares'
import { SettlementEngine, SettlementEngineType } from '../'
import { LedgerEnv, State } from '../../api'
import {
  UplinkConfig,
  // getPluginMaxPacketAmount,
  // getPluginBalanceConfig,
  getNativeMaxInFlight,
  AuthorizeDeposit,
  AuthorizeWithdrawal,
  BaseUplinkConfig,
  BaseUplink,
  ReadyUplink,
  distinctBigNum
} from '../../uplink'
import { Observable, BehaviorSubject, Subject } from 'rxjs'
import { Flavor } from 'types/util'
import { map, filter } from 'rxjs/operators'

/**
 * ------------------------------------
 * SETTLEMENT ENGINE
 * ------------------------------------
 */

const getSettler = (state: State) =>
  state.settlers[SettlementEngineType.XrpPaychan]! // TODO Yuck!

export interface XrpPaychanSettlementEngine extends SettlementEngine {
  api: RippleAPI
}

const getXrpServer = (ledgerEnv: LedgerEnv): string =>
  ledgerEnv === 'mainnet'
    ? 'wss://s1.ripple.com'
    : 'wss://s.altnet.rippletest.net:51233'

export const setupEngine = async (
  ledgerEnv: LedgerEnv
): Promise<XrpPaychanSettlementEngine> => {
  const api = new RippleAPI({
    server: getXrpServer(ledgerEnv)
  })
  await api.connect()

  return {
    settlerType: SettlementEngineType.XrpPaychan, // TODO!

    assetCode: 'XRP',
    assetScale: 9,
    baseUnit: xrpBase,
    exchangeUnit: xrp,
    remoteConnectors: {
      local: {
        'Kava Labs': (token: string) => `btp+ws://:${token}@localhost:7443`
      },
      testnet: {
        'Kava Labs': (token: string) =>
          `btp+wss://:${token}@test.ilp.kava.io/xrp`
      },
      mainnet: {
        'Kava Labs': (token: string) => `btp+wss://:${token}@ilp.kava.io/xrp`
      }
    }[ledgerEnv],
    api
  }
}

/**
 * ------------------------------------
 * CREDENTIAL
 * ------------------------------------
 */

// TODO Use Ripple API `isValidSecret` and `deriveKeypair` rather than ripple-keypairs! (for types!)
// (might still require me to add types... because it's bad)

/** Used to ensure XRP credentials can only be validated right here */
export type ValidatedXrpSecret = Flavor<
  {
    settlerType: SettlementEngineType.XrpPaychan
    secret: string // TODO This should be "XrpSecret", the object should be "Credential"
  },
  'ValidatedXrpSecret'
>
export type ValidatedXrpAddress = Flavor<string, 'ValidatedXrpAddress'>

export interface ReadyXrpCredential {
  settlerType: SettlementEngineType.XrpPaychan
  /** TODO Add explantion */
  secret: string
  /** TODO Add explanation */
  address: ValidatedXrpAddress
}

export const setupCredential = (cred: ValidatedXrpSecret) => async (
  state: State
): Promise<ReadyXrpCredential> => {
  /* ripple-lib validates the secret by wrapping deriveKeypair in a try-catch */
  const address = deriveAddress(deriveKeypair(cred.secret).publicKey)
  const settler = getSettler(state)
  await settler.api.getAccountInfo(address)
  return {
    ...cred,
    address
  }
}

export const uniqueId = (cred: ReadyXrpCredential): ValidatedXrpAddress =>
  cred.address

export const closeCredential = () => Promise.resolve()

/**
 * ------------------------------------
 * UPLINK
 * ------------------------------------
 */

export interface XrpPaychanUplinkConfig extends BaseUplinkConfig {
  settlerType: SettlementEngineType.XrpPaychan
  credentialId: ValidatedXrpAddress
}

export interface XrpPaychanBaseUplink extends BaseUplink {
  settlerType: SettlementEngineType.XrpPaychan
  credentialId: ValidatedXrpAddress
  plugin: PluginWrapper
  xrpPlugin: XrpAsymClient
}

export type ReadyXrpPaychanUplink = XrpPaychanBaseUplink & ReadyUplink

export const connectUplink = (state: State) => (
  credential: ReadyXrpCredential
) => async (config: XrpPaychanUplinkConfig): Promise<XrpPaychanBaseUplink> => {
  const server = config.plugin.btp.serverUri
  const store = config.plugin.store

  const settler = getSettler(state)

  const { secret } = credential
  const xrpServer = getXrpServer(state.ledgerEnv)

  // TODO Should there be a way to create a new channel that's *not* for $10?
  // TODO xrp-asym-server default min incoming is 10 XRP, so it'd be good for that to be a floor
  //      (if we're allowing the user to manually enter it, there'd also need to be a floor)
  const outgoingChannelAmountXRP = convert(
    usd(10),
    xrp(),
    state.rateBackend
  ).toString()

  const plugin = new XrpAsymClient(
    {
      server,
      currencyScale: 9,
      secret,
      xrpServer,
      outgoingChannelAmountXRP
      // autoFundChannels: false // TODO !
    },
    {
      log: createLogger('ilp-plugin-xrp-asym-client'),
      store: new MemoryStore(store)
    }
  )

  /** Stream of updated properties on the underlying plugin */
  const plugin$ = new Subject<{
    key: keyof XrpAsymClient
    val: any
  }>()

  /** Trap all property updates on the plugin to emit them on observable */
  const pluginProxy = new Proxy(plugin, {
    set: (target, key: keyof XrpAsymClient, val) => {
      plugin$.next({
        key,
        val
      })
      return Reflect.set(target, key, val)
    }
  })

  /** Emit updates when the specific property is updated on the plugin */
  const observeProp = <K extends keyof XrpAsymClient>(
    key: K
  ): Observable<XrpAsymClient[K]> =>
    plugin$.pipe(
      filter(update => update.key === key),
      map(({ val }) => val)
    )

  /** Operator on observable to extract the amount of the claim/channel */
  const getValue = map<
    PaymentChannel | PaymentChannelClaim | undefined,
    BigNumber
  >(channel => new BigNumber(channel ? channel.amount : 0))

  /** Operator on observable to convert xrp base units to XRP */
  const toXrp = map<BigNumber, BigNumber>(amount =>
    convert(xrpBase(amount), xrp())
  )

  const outgoingCapacity$ = new BehaviorSubject(new BigNumber(0))
  observeProp('_channelDetails')
    .pipe(
      getValue,
      distinctBigNum
    )
    .subscribe(outgoingCapacity$)

  const incomingCapacity$ = new BehaviorSubject(new BigNumber(0))
  observeProp('_paychan')
    .pipe(
      getValue,
      distinctBigNum
    )
    .subscribe(incomingCapacity$)

  const totalSent$ = new BehaviorSubject(new BigNumber(0))
  observeProp('_lastClaim')
    .pipe(
      getValue,
      distinctBigNum,
      toXrp
    )
    .subscribe(totalSent$)

  const totalReceived$ = new BehaviorSubject(new BigNumber(0))
  observeProp('_bestClaim')
    .pipe(
      getValue,
      distinctBigNum,
      toXrp
    )
    .subscribe(totalReceived$)

  const maxInFlight = getNativeMaxInFlight(
    state,
    SettlementEngineType.XrpPaychan
  )

  // Use wrapper middlewares for balance logic and max packet amount
  const wrapperNamespace = 'ilp-plugin-xrp-asym-client:wrapper'
  const pluginWrapper = new PluginWrapper({
    plugin: pluginProxy,
    prefundTo: maxInFlight,
    maxBalance: maxInFlight,
    maxPacketAmount: maxInFlight.times(2),
    assetCode: settler.assetCode,
    assetScale: settler.assetScale,
    log: createLogger(wrapperNamespace),
    store: new MemoryStore(config.plugin.store, wrapperNamespace)
  })

  const availableToDebit$ = new BehaviorSubject(new BigNumber(0))
  pluginWrapper.payableBalance$
    .pipe(
      // Only emit updated values
      distinctBigNum,
      map(amount => amount.negated()),
      map(amount => convert(xrpBase(amount), xrp()))
    )
    .subscribe(availableToDebit$)

  const idleAvailableToDebit = maxInFlight

  const availableToCredit$ = new BehaviorSubject(new BigNumber(0))
  pluginWrapper.receivableBalance$
    .pipe(
      // Only emit updated values
      distinctBigNum,
      map(amount => maxInFlight.minus(amount)),
      map(amount => convert(xrpBase(amount), xrp()))
    )
    .subscribe(availableToCredit$)

  const idleAvailableToCredit = maxInFlight

  return {
    settlerType: SettlementEngineType.XrpPaychan,
    credentialId: uniqueId(credential),
    plugin: pluginWrapper,
    xrpPlugin: pluginProxy,
    outgoingCapacity$,
    incomingCapacity$,
    availableToDebit$,
    idleAvailableToDebit,
    availableToCredit$,
    idleAvailableToCredit,
    totalSent$,
    totalReceived$
  }
}

export const baseLayerBalance = () => {
  // TODO Implement this! (and make it sufficiently generic)
}

// TODO Temporarily comment out both deposit & withdraw

// export const deposit = async ({
//   authorize,
//   api
// }: {
//   authorize: AuthorizeDeposit
//   api: RippleAPI
// }) => {
//   // TODO Export this as a function to get the balance info of an account (for baseLayerBalance)
//   // Confirm that the account has sufficient funds to cover the reserve
//   const { ownerCount, xrpBalance } = await api.getAccountInfo(xrpAddress)
//   const {
//     validatedLedger: { reserveBaseXRP, reserveIncrementXRP }
//   } = await api.getServerInfo()
//   // TODO What unit is minBalance in? xrp, or drops? Unclear
//   const minBalance =
//     +reserveBaseXRP +
//     +reserveIncrementXRP * ownerCount + // total current reserve
//     +reserveIncrementXRP + // reserve for the channel
//     +amount + // amount to deposit
//     10 // Assume channel creation fee of 10 drops (unclear)
//   const currentBalance = +xrpBalance
//   if (currentBalance < minBalance) {
//     throw new InsufficientFundsError()
//   }

//   // TODO If the fee is ~0 and the user already entered the amount, do they need to authorize it?
//   const shouldContinue = await authorize({
//     value: amount /** XRP */,
//     fee: convert(drop(10), xrp()) /** XRP */
//   })

//   // TODO Check whether a new channel needs to be open, or if we're funding an existing channel ...
//   //      (based on outgoing capacity)
// }

// // TODO Streaming credit off connector will need to be performed prior to withdrawals!
// // TODO When should the internal plugin be disconnected?
// export const withdraw = (state: State) => (uplink: XrpPaychanUplink) => async (
//   authorize: AuthorizeWithdrawal
// ) => {
//   const { api } = getSettler(state)
//   const { address, secret } = getCredential<ReadyXrpCredential>(state)(uplink)

//   /*
//    * Per https://github.com/interledgerjs/ilp-plugin-xrp-paychan-shared/pull/23,
//    * the TxSubmitter is a singleton per XRP address, so it will use an existing one
//    */
//   const submitter = createSubmitter(api, address, secret)

//   const closeChannel = (channelId: string) =>
//     submitter
//       .submit('preparePaymentChannelClaim', {
//         channel: channelId,
//         close: true
//       })
//       .catch((err: Error) => {
//         // TODO Log a more useful error?
//         throw new Error(`Failed to close channel: ${err.message}`)
//       })

//   const fee = convert(drop(10), xrp())
//   const value = interledgerBalance(uplink).minus(fee) // TODO Is this correct?
//   // ^ TODO Use the channel value, not this!

//   // Prompt the user to authorize the withdrawal
//   await authorize({ fee, value })

//   const outgoingChannelId = uplink.xrpPlugin._channel
//   if (outgoingChannelId) {
//     await closeChannel(outgoingChannelId)
//   }

//   const incomingChannelId = uplink.xrpPlugin._clientChannel
//   if (incomingChannelId) {
//     await closeChannel(incomingChannelId)
//   }

//   // TODO What will happen to the plugin state/channel balances after this event?
// }
