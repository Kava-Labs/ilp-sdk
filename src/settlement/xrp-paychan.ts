import { convert, usd, xrp, drop, xrpBase } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import XrpPlugin from 'ilp-plugin-xrp-paychan'
import { deriveAddress, deriveKeypair } from 'ripple-keypairs'
import { RippleAPI } from 'ripple-lib'
import { MemoryStore } from '../utils/store'
import createLogger from '../utils/log'
import { createSubmitter } from 'ilp-plugin-xrp-paychan-shared'
import { SettlementEngine, SettlementEngineType } from '../engine'
import { LedgerEnv, State, SettlementModule } from '..'
import {
  AuthorizeDeposit,
  AuthorizeWithdrawal,
  BaseUplinkConfig,
  BaseUplink,
  distinctBigNum,
  ReadyUplink
} from '../uplink'
import { Observable, BehaviorSubject, Subject, combineLatest } from 'rxjs'
import { Flavor } from 'types/util'
import { map, filter } from 'rxjs/operators'
import { isThatCredentialId } from '../credential'
import { FormattedPaymentChannel } from 'ripple-lib/dist/npm/ledger/parse/payment-channel'

const log = createLogger('switch-api:xrp-paychan')

/**
 * ------------------------------------
 * SETTLEMENT ENGINE
 * ------------------------------------
 */

export interface XrpPaychanSettlementEngine extends SettlementEngine {
  api: RippleAPI
}

const getXrpServerWebsocketUri = (ledgerEnv: LedgerEnv): string =>
  ledgerEnv === 'mainnet'
    ? 'wss://s1.ripple.com'
    : 'wss://s.altnet.rippletest.net:51233'

const setupEngine = async (
  ledgerEnv: LedgerEnv
): Promise<XrpPaychanSettlementEngine> => {
  const api = new RippleAPI({
    server: getXrpServerWebsocketUri(ledgerEnv)
  })
  await api.connect()

  return {
    settlerType: SettlementEngineType.XrpPaychan,
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

export type UnvalidatedXrpSecret = {
  settlerType: SettlementEngineType.XrpPaychan
  secret: string
}

export type ValidatedXrpSecret = Flavor<
  {
    settlerType: SettlementEngineType.XrpPaychan
    secret: string
    address: string
  },
  'ValidatedXrpSecret'
>

const setupCredential = (cred: UnvalidatedXrpSecret) => async (
  state: State
): Promise<ValidatedXrpSecret> => {
  // `deriveKeypair` will throw if the secret is invalid
  const address = deriveAddress(deriveKeypair(cred.secret).publicKey)
  const settler = state.settlers[cred.settlerType]

  // Rejects if the XRP account does not exist
  await settler.api.getAccountInfo(address)

  return {
    ...cred,
    address
  }
}

const uniqueId = (cred: ValidatedXrpSecret): string => cred.address

// TODO Can I eliminate this?
const closeCredential = () => Promise.resolve()

/**
 * ------------------------------------
 * UPLINK
 * ------------------------------------
 */

export interface XrpPaychanUplinkConfig extends BaseUplinkConfig {
  settlerType: SettlementEngineType.XrpPaychan
  credentialId: string
}

export interface XrpPaychanBaseUplink extends BaseUplink {
  settlerType: SettlementEngineType.XrpPaychan
  credentialId: string
  plugin: any // TODO Fix this/remove balance wrapper from here
}

export type ReadyXrpPaychanUplink = XrpPaychanBaseUplink & ReadyUplink

const connectUplink = (credential: ValidatedXrpSecret) => (
  state: State
) => async (config: BaseUplinkConfig): Promise<XrpPaychanBaseUplink> => {
  const server = config.plugin.btp.serverUri
  const store = config.plugin.store

  const { secret } = credential
  const xrpServer = getXrpServerWebsocketUri(state.ledgerEnv)

  const outgoingChannelAmount = convert(
    usd(10),
    xrpBase(),
    state.rateBackend
  ).toString()

  const plugin = new XrpPlugin(
    {
      server,
      currencyScale: 9,
      secret,
      xrpServer,
      // TODO Fix this config (e.g. channelAmount is base units)
      channelAmount: outgoingChannelAmount,
      autoFundChannels: false
    },
    {
      log: createLogger('ilp-plugin-xrp'),
      store: new MemoryStore(store)
    }
  )

  /** Stream of updated properties on the underlying plugin */
  const plugin$ = new Subject<{
    key: any
    val: any
  }>()

  /** Trap all property updates on the plugin to emit them on observable */
  const pluginProxy = new Proxy(plugin, {
    set: (target, key, val) => {
      plugin$.next({
        key,
        val
      })
      return Reflect.set(target, key, val)
    }
  })

  /** Emit updates when the specific property is updated on the plugin */
  const observeProp = <K>(key: K): Observable<any[K]> =>
    plugin$.pipe(
      filter(update => update.key === key),
      map(({ val }) => val)
    )

  // TODO Where should these types be defined?

  interface PaymentChannel extends FormattedPaymentChannel {
    /** Total amount of XRP funded in this channel */
    amount: string
    /** Total amount of XRP delivered by this channel (per docs) */
    balance: string
  }

  interface PaymentChannelClaim {
    /** Value of the claim, in plugin base units */
    amount: string
    /** Valid signature to enforce the claim on-ledger */
    signature: string
  }

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
    outgoingCapacity$,
    incomingCapacity$,
    totalSent$,
    totalReceived$
  }
}

// TODO Can I elimiante this?
const getCredential = (state: State) => (credentialId: string) =>
  state.credentials.filter(
    (c): c is ValidatedXrpSecret =>
      c.settlerType === SettlementEngineType.XrpPaychan &&
      uniqueId(c) === credentialId
  )[0]

const deposit = (uplink: ReadyXrpPaychanUplink) => (state: State) => async ({
  amount,
  authorize
}: {
  amount: BigNumber
  authorize: AuthorizeDeposit
}) => {
  const { api } = state.settlers[uplink.settlerType]
  const { address } = getCredential(state)(uplink.credentialId)

  // TODO Default in xrp-asym-server requires 10 XRP escrowed to create the reciprocal channel
  // (ensure this is compatible with the server plugin)
  if (amount.lt(10)) {
    throw new Error('Amount insufficient')
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
  const requiresNewChannel = !uplink.plugin._outgoingChannel
  requiresNewChannel
    ? await uplink.plugin._createOutgoingChannel(amount.toString())
    : await uplink.plugin._fundOutgoingChannel(amount.toString())
}

const withdraw = (uplink: ReadyXrpPaychanUplink) => (state: State) => async (
  authorize: AuthorizeWithdrawal
) => {
  const { api } = state.settlers[uplink.settlerType]
  const readyCredential = state.credentials.find(
    isThatCredentialId<ValidatedXrpSecret>(
      uplink.credentialId,
      uplink.settlerType
    )
  )
  if (!readyCredential) {
    return
  }
  const { address, secret } = readyCredential

  /*
   * Per https://github.com/interledgerjs/ilp-plugin-xrp-paychan-shared/pull/23,
   * the TxSubmitter is a singleton per XRP address, so it will use an existing one
   */
  const submitter = createSubmitter(api, address, secret)

  // Submit the latest incoming claim as a checkpoint to the ledger
  await uplink.plugin._claimFunds()

  const closeChannel = (channelId: string) =>
    submitter
      .submit('preparePaymentChannelClaim', {
        channel: channelId,
        close: true
      })
      .catch((err: Error) => log.error('Failed to close channel: ', err))

  // Prompt the user to authorize the withdrawal
  const fee = convert(drop(10), xrp())
  const value = uplink.outgoingCapacity$.value.plus(uplink.totalReceived$.value)
  await authorize({ fee, value })

  const outgoingChannelId = uplink.plugin._outgoingChannel
  if (outgoingChannelId) {
    await closeChannel(outgoingChannelId)
  }

  // xrp-paychan-shared occasionally throws an error when it tries to remove a pending
  // transaction from its queue after it got confirmed (something with maxLedgerVersion?)
  // TODO This *possibly* fixes that bug
  await new Promise(r => setTimeout(r, 1000))

  const incomingChannelId = uplink.plugin._incomingChannel
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
    UnvalidatedXrpSecret,
    ValidatedXrpSecret,
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

export const XrpPaychan: XrpPaychanSettlementModule = {
  setupEngine,
  setupCredential,
  uniqueId,
  closeCredential,
  connectUplink,
  deposit,
  withdraw
}
