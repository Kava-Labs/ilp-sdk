import { convert, drop, xrp, xrpBase } from '@kava-labs/crypto-rate-utils'
import XrpAsymClient, {
  PaymentChannelClaim
} from '@kava-labs/ilp-plugin-xrp-asym-client'
import BigNumber from 'bignumber.js'
import { createSubmitter } from 'ilp-plugin-xrp-paychan-shared'
import { deriveAddress, deriveKeypair } from 'ripple-keypairs'
import { FormattedPaymentChannel, RippleAPI } from 'ripple-lib'
import { BehaviorSubject, combineLatest, Observable, Subject } from 'rxjs'
import { filter, map } from 'rxjs/operators'
import { Flavor } from 'types/util'
import { LedgerEnv, SettlementModule, State } from '..'
import { isThatCredentialId } from '../credential'
import { SettlementEngine, SettlementEngineType } from '../engine'
import {
  AuthorizeDeposit,
  AuthorizeWithdrawal,
  BaseUplink,
  BaseUplinkConfig,
  distinctBigNum,
  ReadyUplink
} from '../uplink'
import createLogger from '../utils/log'
import { MemoryStore } from '../utils/store'

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
      mainnet: {}
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
  plugin: XrpAsymClient
  incomingChannelAmount$: BehaviorSubject<BigNumber>
  outgoingChannelAmount$: BehaviorSubject<BigNumber>
}

export type ReadyXrpPaychanUplink = XrpPaychanBaseUplink & ReadyUplink

const connectUplink = (credential: ValidatedXrpSecret) => (
  state: State
) => async (config: BaseUplinkConfig): Promise<XrpPaychanBaseUplink> => {
  const server = config.plugin.btp.serverUri
  const store = config.plugin.store

  const { secret } = credential
  const xrpServer = getXrpServerWebsocketUri(state.ledgerEnv)

  // TODO Presently, the outgoing channel id is requested from the connector
  // and not persisted to the store -- that's bad!

  const plugin = new XrpAsymClient(
    {
      server,
      currencyScale: 9,
      secret,
      xrpServer,
      autoFundChannel: false
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

  /** Operator on observable to extract the amount of the claim/channel */
  const getValue = map<
    FormattedPaymentChannel | PaymentChannelClaim | undefined,
    BigNumber
  >(channel => new BigNumber(channel ? channel.amount : 0))

  /** Operator on observable to convert xrp base units to XRP */
  const toXrp = map<BigNumber, BigNumber>(amount =>
    convert(xrpBase(amount), xrp())
  )

  /** Operator on observable to limit by latest of another observable */

  const outgoingChannelAmount$ = new BehaviorSubject(new BigNumber(0))
  const outgoingClaimAmount$ = new BehaviorSubject(new BigNumber(0))
  observeProp('_lastClaim')
    .pipe(
      getValue,
      distinctBigNum,
      toXrp
    )
    .subscribe(outgoingClaimAmount$)

  const totalSent$ = new BehaviorSubject(new BigNumber(0))
  combineLatest(outgoingChannelAmount$, outgoingClaimAmount$)
    .pipe(
      map(([channelAmount, claimAmount]) =>
        BigNumber.min(channelAmount, claimAmount)
      )
    )
    .subscribe(totalSent$)

  const outgoingCapacity$ = new BehaviorSubject(new BigNumber(0))
  combineLatest(outgoingChannelAmount$, totalSent$)
    .pipe(
      map(([channelAmount, claimAmount]) => channelAmount.minus(claimAmount))
    )
    .subscribe(outgoingCapacity$)

  const incomingChannelAmount$ = new BehaviorSubject(new BigNumber(0))
  const incomingClaimAmount$ = new BehaviorSubject(new BigNumber(0))
  observeProp('_bestClaim')
    .pipe(
      getValue,
      distinctBigNum,
      toXrp
    )
    .subscribe(incomingClaimAmount$)

  const totalReceived$ = new BehaviorSubject(new BigNumber(0))
  combineLatest(incomingChannelAmount$, incomingClaimAmount$)
    .pipe(
      map(([channelAmount, claimAmount]) =>
        BigNumber.min(channelAmount, claimAmount)
      )
    )
    .subscribe(totalReceived$)

  const incomingCapacity$ = new BehaviorSubject(new BigNumber(0))
  combineLatest(incomingChannelAmount$, totalReceived$)
    .pipe(
      map(([channelAmount, claimAmount]) => channelAmount.minus(claimAmount))
    )
    .subscribe(incomingCapacity$)

  // Load the intiial channel state
  plugin.once('connect', async () => {
    incomingChannelAmount$.next(await refreshIncomingChannel(state)(plugin))
    outgoingChannelAmount$.next(await refreshOutgoingChannel(state)(plugin))
  })

  return {
    settlerType: SettlementEngineType.XrpPaychan,
    credentialId: uniqueId(credential),
    plugin: pluginProxy,
    outgoingCapacity$,
    incomingCapacity$,
    totalSent$,
    totalReceived$,
    incomingChannelAmount$,
    outgoingChannelAmount$
  }
}

// TODO Capacity must be periodically refreshed if the CONNECTOR decides to deposit!

const refreshIncomingChannel = (state: State) => async (
  plugin: XrpAsymClient
): Promise<BigNumber> =>
  plugin._clientChannel
    ? fetchChannelCapacity(state)(plugin._clientChannel)
    : new BigNumber(0)

const refreshOutgoingChannel = (state: State) => (plugin: XrpAsymClient) =>
  plugin._channel
    ? fetchChannelCapacity(state)(plugin._channel)
    : new BigNumber(0)

const fetchChannelCapacity = (state: State) => async (
  channelId: string
): Promise<BigNumber> => {
  const { api } = state.settlers[SettlementEngineType.XrpPaychan]

  // TODO Submit PR to ripple-lib to add amount to type!
  const channel = ((await api.getPaymentChannel(channelId).catch(err => {
    if (err.name === 'RippledError' && err.message === 'entryNotFound') {
      return
    }
    log.error('Failed to fetch payment channel capacity: ', err)
  })) as unknown) as (FormattedPaymentChannel | void)
  return new BigNumber(channel ? channel.amount : 0)
}

// TODO Can I elimiante this? (Or use the abstracted version?)
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

  // TODO Check that the total amount deposited > 2 XRP (per connector-config)!

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
    // TODO Return a specific type of error
    throw new Error('insufficient funds')
  }

  // TODO Add accounting for fees from autoClaim and such!

  // TODO If the fee is ~0 and the user already entered the amount, do they need to authorize it?
  // TODO Should the promise reject if unauthorized?
  await authorize({
    value: amount /** XRP */,
    fee /** XRP */
  })

  // Check if we need to create a new channel or deposit to an existing channel
  // TODO Ensure the amount is rounded down, since there sometimes is more precision than -6 (also make sure the prompt is correct)
  const requiresNewChannel = !uplink.plugin._channel
  requiresNewChannel
    ? await uplink.plugin._createOutgoingChannel(amount.toString())
    : await uplink.plugin._fundOutgoingChannel(amount.toString())

  uplink.outgoingChannelAmount$.next(
    await refreshOutgoingChannel(state)(uplink.plugin)
  )

  // TODO Since the channel is now open, perform the rest of the connect handshake

  if (requiresNewChannel) {
    await uplink.plugin._performConnectHandshake()

    uplink.incomingChannelAmount$.next(
      await refreshIncomingChannel(state)(uplink.plugin)
    )
  }
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

  // Submit a claim to the ledger, if it's profitable
  // TODO Combine this and channel close into a single tx?
  await uplink.plugin._autoClaim()

  /*
   * Per https://github.com/interledgerjs/ilp-plugin-xrp-paychan-shared/pull/23,
   * the TxSubmitter is a singleton per XRP address, so it will use an existing one
   */
  const submitter = createSubmitter(api, address, secret)

  // TODO xrp-asym-server uses api and not tx-submitter. Why don't I? (Could resolve issue)
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

  const outgoingChannelId = uplink.plugin._channel
  if (outgoingChannelId) {
    await closeChannel(outgoingChannelId)
  }

  // xrp-paychan-shared occasionally throws an error when it tries to remove a pending
  // transaction from its queue after it got confirmed (something with maxLedgerVersion?)
  // TODO This *possibly* fixes that bug
  await new Promise(r => setTimeout(r, 2000))

  const incomingChannelId = uplink.plugin._clientChannel
  if (incomingChannelId) {
    await closeChannel(incomingChannelId)
  }

  // Ensure that the balances are updated to reflect the closed channels

  uplink.incomingChannelAmount$.next(
    await refreshIncomingChannel(state)(uplink.plugin)
  )

  // TODO This is kinda a hack, because we must wait up to 5 minutes for xrp-asym-server watcher to claim
  uplink.outgoingChannelAmount$.next(new BigNumber(0))
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
