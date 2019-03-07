import { convert, drop, xrp, xrpBase, usd } from '@kava-labs/crypto-rate-utils'
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
import { LedgerEnv, State } from '..'
import { isThatCredentialId } from '../credential'
import { SettlementEngine, SettlementEngineType } from '../engine'
import {
  AuthorizeDeposit,
  AuthorizeWithdrawal,
  BaseUplink,
  BaseUplinkConfig,
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
  readonly settlerType: SettlementEngineType.XrpPaychan
  readonly api: RippleAPI
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

export const closeXrpPaychanEngine = ({
  api
}: XrpPaychanSettlementEngine): Promise<void> => api.disconnect()

/**
 * ------------------------------------
 * CREDENTIAL
 * ------------------------------------
 */

export type UnvalidatedXrpSecret = {
  readonly settlerType: SettlementEngineType.XrpPaychan
  readonly secret: string
}

export type ValidatedXrpSecret = Flavor<
  {
    readonly settlerType: SettlementEngineType.XrpPaychan
    readonly secret: string
    readonly address: string
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

export const configFromXrpCredential = ({
  address,
  ...cred
}: ValidatedXrpSecret): UnvalidatedXrpSecret => cred

/**
 * ------------------------------------
 * UPLINK
 * ------------------------------------
 */

// Estimate all ripple tx fees as a high fixed value as a temporary solution.
// Problems:
//  - plugins do not allow us to set the fee for txs
//  - plugins do not allow authorization of every tx (so account balance can be spent in the background, making exact balance checks impossible)
// Current solution is to over estimate fees so that in practice the amount spent will always be lower that estimated.
// The default tx fee for ripple api is 12 drops for a normal tx. (base fee of 10 drops x feeCushion of 1.2 (https://developers.ripple.com/rippleapi-reference.html))
const ESTIMATED_XRP_TX_FEE = convert(drop(50), xrp())

export interface XrpPaychanBaseUplink extends BaseUplink {
  readonly settlerType: SettlementEngineType.XrpPaychan
  readonly credentialId: string
  readonly plugin: XrpAsymClient
  readonly incomingChannelAmount$: BehaviorSubject<BigNumber>
  readonly outgoingChannelAmount$: BehaviorSubject<BigNumber>
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
    readonly key: any
    readonly val: any
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

export const baseLayerBalance = async (
  settler: XrpPaychanSettlementEngine,
  credential: ValidatedXrpSecret
) => {
  const response = await settler.api.getAccountInfo(credential.address)
  return new BigNumber(response.xrpBalance)
}

// TODO Can I eliminate this? (Or use the abstracted version?)
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
  readonly amount: BigNumber
  readonly authorize: AuthorizeDeposit
}) => {
  const { api } = state.settlers[uplink.settlerType]
  const { address } = getCredential(state)(uplink.credentialId)

  // TODO Temporarily solve issue with deadlock due to insufficient outgoing
  // (server won't fund incoming, even if more is deposited later)
  if (convert(xrp(amount), usd(), state.rateBackend).isLessThan(0.6)) {
    throw new Error('insufficient deposit amount')
  }

  // Confirm that the account has sufficient funds to cover the reserve
  const { ownerCount, xrpBalance } = await api.getAccountInfo(address) // TODO May throw if the account isn't found
  const {
    validatedLedger: { reserveBaseXRP, reserveIncrementXRP }
  } = await api.getServerInfo()
  const minBalance =
    /* Minimum amount of XRP for every account to keep in reserve */
    +reserveBaseXRP +
    /** Current amount reserved in XRP for each object the account is responsible for */
    +reserveIncrementXRP * ownerCount +
    /** Additional reserve this channel requires, in XRP */
    +reserveIncrementXRP +
    /** Amount to fund the channel, in XRP */
    +amount + // TODO fix this
    /** Allow buffer of tx fees to cover this tx and possible background txs submitted by the xrp plugin */ +ESTIMATED_XRP_TX_FEE
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
    fee: ESTIMATED_XRP_TX_FEE /** XRP */
  })

  // Check if we need to create a new channel or deposit to an existing channel
  // TODO Ensure the amount is rounded down, since there sometimes is more precision than -6 (also make sure the prompt is correct)
  const requiresNewChannel = !uplink.plugin._channel
  requiresNewChannel
    ? await uplink.plugin._createOutgoingChannel(amount.toString())
    : await uplink.plugin._fundOutgoingChannel(amount.toString())

  // TODO Change this to perform the handshake whenever there's no incoming capacity
  if (requiresNewChannel) {
    await uplink.plugin._performConnectHandshake()
  }

  uplink.outgoingChannelAmount$.next(
    await refreshOutgoingChannel(state)(uplink.plugin)
  )

  uplink.incomingChannelAmount$.next(
    await refreshIncomingChannel(state)(uplink.plugin)
  )
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

  // Prompt the user to authorize the withdrawal
  // TODO Add actual fee calculation to the XRP plugins
  const value = uplink.outgoingCapacity$.value.plus(uplink.totalReceived$.value)
  await authorize({ value, fee: ESTIMATED_XRP_TX_FEE })

  // Submit latest claim and close the incoming channel
  await uplink.plugin._autoClaim(true)

  /*
   * Per https://github.com/interledgerjs/ilp-plugin-xrp-paychan-shared/pull/23,
   * the TxSubmitter is a singleton per XRP address, so it will use an existing one
   */
  const submitter = createSubmitter(api, address, secret)

  const outgoingChannelId = uplink.plugin._channel
  if (outgoingChannelId) {
    await submitter
      .submit('preparePaymentChannelClaim', {
        channel: outgoingChannelId,
        close: true
      })
      .catch((err: Error) => log.error('Failed to close channel: ', err))
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

export const XrpPaychan = {
  setupEngine,
  setupCredential,
  uniqueId,
  connectUplink,
  deposit,
  withdraw
}
