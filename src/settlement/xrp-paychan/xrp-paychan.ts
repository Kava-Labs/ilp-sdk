import { convert, usd, xrp, drop, xrpBase } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import XrpAsymClient, {
  PaymentChannelClaim,
  PaymentChannel
} from 'ilp-plugin-xrp-asym-client'
import XrpPlugin from 'ilp-plugin-xrp-paychan'
import { deriveAddress, deriveKeypair } from 'ripple-keypairs'
import { RippleAPI } from 'ripple-lib'
import { MemoryStore } from '../../utils/store'
import createLogger from '../../utils/log'
import { createSubmitter } from 'ilp-plugin-xrp-paychan-shared'
import { PluginWrapper } from '../../utils/middlewares'
import { SettlementEngine, SettlementEngineType } from '../'
import { LedgerEnv, State, SettlementModule, DepositableModule } from '../..'
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
import { Observable, BehaviorSubject, Subject, combineLatest } from 'rxjs'
import { Flavor } from 'types/util'
import { map, filter } from 'rxjs/operators'
import { DepositPreauthLedgerEntry } from 'ripple-lib/dist/npm/common/types/objects'

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

const setupEngine = async (
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

const setupCredential = (cred: ValidatedXrpSecret) => async (
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

const uniqueId = (cred: ReadyXrpCredential): ValidatedXrpAddress => cred.address

const closeCredential = () => Promise.resolve()

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
  xrpPlugin: any // TODO !
}

export type ReadyXrpPaychanUplink = XrpPaychanBaseUplink & ReadyUplink

const connectUplink = (state: State) => (
  credential: ReadyXrpCredential
) => async (config: XrpPaychanUplinkConfig): Promise<XrpPaychanBaseUplink> => {
  const server = config.plugin.btp.serverUri
  const store = config.plugin.store

  const { secret } = credential
  const xrpServer = getXrpServer(state.ledgerEnv)

  // TODO Should there be a way to create a new channel that's *not* for $10?
  // TODO xrp-asym-server default min incoming is 10 XRP, so it'd be good for that to be a floor
  //      (if we're allowing the user to manually enter it, there'd also need to be a floor)
  const outgoingChannelAmountXRP = convert(
    usd(10),
    xrpBase(), // TODO It's not in XRP, rename the var!
    state.rateBackend
  ).toString()

  const plugin = new XrpPlugin(
    {
      server,
      currencyScale: 9,
      secret,
      xrpServer,
      channelAmount: outgoingChannelAmountXRP, // TODO Rename to "channel fund amount"
      // outgoingChannelAmountXRP // TODO !
      autoFundChannels: false // TODO !
    },
    {
      log: createLogger('ilp-plugin-xrp'),
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
  // TODO Replace `any` with `XrpPlugin`
  const observeProp = <K extends keyof any>(key: K): Observable<any[K]> =>
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

  const outgoingChannelAmount$ = new BehaviorSubject(new BigNumber(0))
  observeProp('_outgoingChannelDetails')
    .pipe(
      getValue,
      distinctBigNum
    )
    .subscribe(outgoingChannelAmount$)

  const totalSent$ = new BehaviorSubject(new BigNumber(0))
  observeProp('_outgoingClaim')
    .pipe(
      getValue,
      distinctBigNum,
      toXrp
    )
    .subscribe(totalSent$)

  const outgoingCapacity$ = new BehaviorSubject(new BigNumber(0))
  combineLatest(outgoingChannelAmount$, totalSent$)
    .pipe(
      map(([channelAmount, claimAmount]) => channelAmount.minus(claimAmount))
    )
    .subscribe(outgoingCapacity$)

  const incomingChannelAmount$ = new BehaviorSubject(new BigNumber(0))
  observeProp('_incomingChannelDetails')
    .pipe(
      getValue,
      distinctBigNum
    )
    .subscribe(incomingChannelAmount$)

  const totalReceived$ = new BehaviorSubject(new BigNumber(0))
  observeProp('_incomingClaim')
    .pipe(
      getValue,
      distinctBigNum,
      toXrp
    )
    .subscribe(totalReceived$)

  const incomingCapacity$ = new BehaviorSubject(new BigNumber(0))
  combineLatest(incomingChannelAmount$, totalReceived$)
    .pipe(
      map(([channelAmount, claimAmount]) => channelAmount.minus(claimAmount))
    )
    .subscribe(incomingCapacity$)

  return {
    settlerType: SettlementEngineType.XrpPaychan,
    credentialId: uniqueId(credential),
    plugin: pluginProxy,
    xrpPlugin: pluginProxy,
    outgoingCapacity$,
    incomingCapacity$,
    // availableToDebit$,
    // idleAvailableToDebit,
    // availableToCredit$,
    // idleAvailableToCredit,
    totalSent$,
    totalReceived$
  }
}

// TODO Can I elimiante this?
const getCredential = (state: State) => (credentialId: string) =>
  state.credentials.filter(
    (c): c is ReadyXrpCredential =>
      c.settlerType === SettlementEngineType.XrpPaychan &&
      uniqueId(c) === credentialId
  )[0] // TODO!

const deposit = (uplink: ReadyXrpPaychanUplink) => (state: State) => async ({
  amount,
  authorize
}: {
  amount: BigNumber
  authorize: AuthorizeDeposit
}) => {
  const { api } = getSettler(state)
  const { address } = getCredential(state)(uplink.credentialId) // TODO Implement credential lookup!

  // Default in xrp-asym-server requires 10 XRP escrowed to create the reciprocal channel
  if (amount.lt(10)) {
    throw new Error() // TODO Amount insufficient!
  }

  // Confirm that the account has sufficient funds to cover the reserve
  const { ownerCount, xrpBalance } = await api.getAccountInfo(address) // TODO May throw if the account isn't found
  const {
    validatedLedger: { reserveBaseXRP, reserveIncrementXRP }
  } = await api.getServerInfo()
  const fee = convert(xrpBase(10), xrp()) // TODO Calculate this (plugin should accept fee param?)
  const minBalance =
    /* Minimum amount of XRP for every account to keep in reserve */
    +reserveBaseXRP +
    /** Current amount reserved in XRP for each object the account is responsible for */
    +reserveIncrementXRP * ownerCount +
    /** Additional reserve this channel requires, in XRP */
    +reserveIncrementXRP +
    /** Amount to fund the channel, in XRP */
    +amount +
    /** Assume channel creation fee of 10 drops (unclear) */
    +fee
  const currentBalance = +xrpBalance
  if (currentBalance < minBalance) {
    throw new InsufficientFundsError() // TODO Fix this
  }

  // TODO If the fee is ~0 and the user already entered the amount, do they need to authorize it?
  // TODO Should the promise reject is unauthorized?
  await authorize({
    value: amount /** XRP */,
    fee /** XRP */
  })

  // Check if we need to create a new channel or deposit to an existing channel
  const requiresNewChannel = !uplink.xrpPlugin._outgoingChannel
  requiresNewChannel
    ? await uplink.xrpPlugin._createOutgoingChannel(amount.toString())
    : await uplink.xrpPlugin._fundOutgoingChannel(amount.toString())
}

// // TODO Streaming credit off connector will need to be performed prior to withdrawals!
// // TODO When should the internal plugin be disconnected?
const withdraw = (uplink: ReadyXrpPaychanUplink) => (state: State) => async (
  authorize: AuthorizeWithdrawal
) => {
  const { api } = getSettler(state)
  const { address, secret } = getCredential<ReadyXrpCredential>(state)(uplink)

  /*
   * Per https://github.com/interledgerjs/ilp-plugin-xrp-paychan-shared/pull/23,
   * the TxSubmitter is a singleton per XRP address, so it will use an existing one
   */
  const submitter = createSubmitter(api, address, secret)

  const closeChannel = (channelId: string) =>
    submitter
      .submit('preparePaymentChannelClaim', {
        channel: channelId,
        close: true
      })
      .catch((err: Error) => {
        // TODO Log a more useful error?
        throw new Error(`Failed to close channel: ${err.message}`)
      })

  const fee = convert(drop(10), xrp())
  // TODO Use the outgoing capacity instead!
  const value = interledgerBalance(uplink).minus(fee) // TODO Is this correct?
  // ^ TODO Use the channel value, not this!

  // Prompt the user to authorize the withdrawal
  await authorize({ fee, value })

  const outgoingChannelId = uplink.xrpPlugin._channel
  if (outgoingChannelId) {
    await closeChannel(outgoingChannelId)
  }

  const incomingChannelId = uplink.xrpPlugin._clientChannel
  if (incomingChannelId) {
    await closeChannel(incomingChannelId)
  }

  // TODO What will happen to the plugin state/channel balances after this event?
}

/**
 * ------------------------------------
 * SETTLEMENT MODULE
 * ------------------------------------
 */

export interface XrpPaychanSettlementModule
  extends SettlementModule<
    SettlementEngineType.XrpPaychan,
    XrpPaychanSettlementEngine,
    ValidatedXrpSecret,
    ReadyXrpCredential,
    XrpPaychanBaseUplink,
    ReadyXrpPaychanUplink
  > {
  readonly deposit: (
    uplink: ReadyXrpPaychanUplink
  ) => (
    state: State
  ) => (opts: {
    amount: BigNumber
    authorize: AuthorizeDeposit
  }) => Promise<void>

  readonly withdraw: (
    uplink: ReadyXrpPaychanUplink
  ) => (state: State) => (authorize: AuthorizeWithdrawal) => Promise<void>
}

// TODO Rename this?
export const XrpPaychan: XrpPaychanSettlementModule = {
  settlerType: SettlementEngineType.XrpPaychan,
  setupEngine,
  setupCredential,
  uniqueId,
  closeCredential,
  connectUplink,
  deposit,
  withdraw
}
