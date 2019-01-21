import {
  convert,
  usd,
  xrp,
  drop,
  xrpBase,
  satoshi,
  btc
} from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import XrpAsymClient, {
  PaymentChannelClaim,
  PaymentChannel
} from 'ilp-plugin-xrp-asym-client'
import { deriveAddress, deriveKeypair } from 'ripple-keypairs'
import { RippleAPI } from 'ripple-lib'
import { SimpleStore, MemoryStore, PluginStore } from 'utils/store'
import createLogger from '../../utils/log'
import { createSubmitter } from 'ilp-plugin-xrp-paychan-shared'
import { PluginWrapper } from '../../utils/middlewares'
import { SettlementEngine, SettlementEngineType } from 'settlement'
import { ApiUtils, LedgerEnv, State, getCredential, getSettler } from 'api'
import { Maybe, Just, Nothing } from 'purify-ts/adts/Maybe'
import {
  NewUplink,
  UplinkConfig,
  getPluginMaxPacketAmount,
  getPluginBalanceConfig,
  getNativeMaxInFlight,
  AuthorizeDeposit,
  AuthorizeWithdrawal,
  interledgerBalance
} from 'uplink'
import { FormattedGetAccountInfoResponse } from 'ripple-lib/dist/npm/ledger/accountinfo'
// import { observe } from 'rxjs-observe'
import { Observable, BehaviorSubject, Subscriber } from 'rxjs'

/**
 * ------------------------------------
 * SETTLEMENT ENGINE
 * ------------------------------------
 */

export interface XrpPaychanSettlementEngine extends SettlementEngine {
  api: RippleAPI
}

const getXrpServer = (ledgerEnv: LedgerEnv): string =>
  ledgerEnv === 'mainnet'
    ? 'wss://s1.ripple.com'
    : 'wss://s.altnet.rippletest.net:51233'

export const startEngine = async (
  utils: ApiUtils
): Promise<XrpPaychanSettlementEngine> => {
  const xrpServer = getXrpServer(utils.ledgerEnv)
  const api = new RippleAPI({
    server: xrpServer
  })
  await api.connect()

  return {
    assetCode: 'XRP',
    assetScale: 9,
    baseUnit: satoshi,
    exchangeUnit: btc,
    // TODO I should create a generic "ILSP name" mapping/enum
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
    },
    api
  }
}

/**
 * ------------------------------------
 * CREDENTIAL
 * ------------------------------------
 */

// TODO Use Ripple API `isValidSecret` and `deriveKeypair` rather than ripple-keypairs! (for types!)

/** Used to ensure XRP credentials can only be validated right here */
type Brand<K, T> = K & { __brand: T }
type ValidatedXrpSecret = Brand<string, 'ValidXrpSecret'>

// TODO Fix this validation (just make sure it's a valid Xrp account)
export const validate = (settler: XrpPaychanSettlementEngine) => async (
  secret: string
): Promise<Maybe<ValidatedXrpSecret>> =>
  /* ripple-lib validates the secret by wrapping deriveKeypair in a try-catch */
  Maybe.encase(() => deriveAddress(deriveKeypair(secret).publicKey))
    .map(async address =>
      Maybe.encase<FormattedGetAccountInfoResponse>(
        await settler.api.getAccountInfo(address)
      )
    )
    .map(() => secret as ValidatedXrpSecret)
    .orDefault(Promise.reject)

export interface ReadyXrpCredential {
  settlerType: SettlementEngineType.XrpPaychan

  secret: string
  address: string
}

export const setupCredential = (
  secret: ValidatedXrpSecret
): ReadyXrpCredential => ({
  secret,
  address: deriveAddress(deriveKeypair(secret).publicKey)
})

/**
 * ------------------------------------
 * UPLINK
 * ------------------------------------
 */

export interface XrpPaychanUplinkConfig {
  settlerType: SettlementEngineType.XrpPaychan

  credentialId: string
}

export interface OnlyXrpPaychan {
  plugin: PluginWrapper
  xrpPlugin: XrpAsymClient
  settlerType: SettlementEngineType.XrpPaychan
}

export type XrpPaychanUplink = OnlyXrpPaychan & NewUplink

/* prettier-ignore */
export type ConnectXrpPaychanUplink =
  (state: State) =>
  (config: UplinkConfig & XrpPaychanUplinkConfig) =>
  OnlyXrpPaychan

// TODO My custom opening channel thing may screw up the entire flow...

export const connectUplink: ConnectXrpPaychanUplink = state => config => {
  const server = config.plugin.btp.serverUri
  const store = new MemoryStore(config.plugin.store)

  const settler = getSettler(state)(config.settlerType) // TODO This is kinda duplicated...
  const { secret } = getCredential(state, settler, config.credentialId) // TODO Lookup by credentialId is important!
  const xrpServer = getXrpServer(utils.ledgerEnv)

  // TODO Is there a way to create a new channel that's *not* for $10?
  const outgoingChannelAmountXRP = convert(
    usd(10),
    xrp(),
    utils.rateBackend
  ).toString()

  const plugin = new XrpAsymClient(
    {
      server,
      currencyScale: 9,
      secret,
      xrpServer,
      outgoingChannelAmountXRP,
      autoFundChannels: false
    },
    {
      log: createLogger('ilp-plugin-xrp-asym-client'),
      store
    }
  )

  // TODO TODO TODO

  /** Use a BehaviorSubject so new subscribers are notified of the most recent value */
  const subject = new BehaviorSubject(new BigNumber(0))

  const observe = <ObservableType, SubjectType>(
    key: keyof XrpAsymClient,
    subject: BehaviorSubject<SubjectType>,
    map: (data: ObservableType) => SubjectType
  ) =>
    Object.defineProperty(plugin, key, {
      writable: true,
      set(val: ObservableType) {
        subject.next(map(val))
        this[key] = val
      }
    })

  const outgoingChannelAmount2 = observe(
    '_channelDetails',
    new BehaviorSubject(new BigNumber(0)),
    ({ amount }) => amount
  )

  const observeChannelAmount = (key: keyof XrpAsymClient) =>
    new Observable<BigNumber>(observer => {
      observer.next(new BigNumber(0))

      Object.defineProperty(plugin, key, {
        writable: true,
        set(channel: PaymentChannel) {
          observer.next(new BigNumber(channel.amount))
          this[key] = channel
        }
      })
    })

  const observeClaimAmount = (key: keyof XrpAsymClient) =>
    new Observable<BigNumber>(observer => {
      observer.next(new BigNumber(0))

      Object.defineProperty(plugin, key, {
        writable: true,
        set(claim: PaymentChannelClaim) {
          const amount = convert(xrpBase(claim.amount), xrp())
          observer.next(amount)
          this[key] = claim
        }
      })
    })

  // TODO Create helper!

  const outgoingChannelAmount = observeChannelAmount('_channelDetails')
  const incomingChannelAmount = observeChannelAmount('_paychan')

  const foo = observeAmount('_paychan')

  const maxInFlight = getNativeMaxInFlight(utils, settler)

  /** Use wrapper middlewares for balance logic and max packet amount */
  const wrapperNamespace = 'ilp-plugin-xrp-asym-client:wrapper'
  const pluginWrapper = new PluginWrapper({
    plugin,
    assetCode: settler.assetCode,
    assetScale: settler.assetScale,
    log: createLogger(wrapperNamespace),
    store: new MemoryStore(config.plugin.store, wrapperNamespace),
    balance: getPluginBalanceConfig(maxInFlight),
    maxPacketAmount: getPluginMaxPacketAmount(maxInFlight)
  })

  // TODO Return/export RX.JS observables

  return {
    settlerType: SettlementEngineType.XrpPaychan,
    plugin: pluginWrapper,
    xrpPlugin: plugin
  }
}

// TODO Fix this, now that I have types!

const outgoingChannelAmount = ({ _channelDetails }: XrpAsymClient) =>
  new BigNumber(_channelDetails ? _channelDetails.amount : 0)

const incomingChannelAmount = ({ _paychan }: XrpAsymClient) =>
  new BigNumber(_paychan ? _paychan.amount : 0)

const outgoingClaimAmount = getValue('_lastClaim')
const incomingClaimAmount = getValue('_bestClaim')

export const totalSent = ({ xrpPlugin }: XrpPaychanUplink) =>
  outgoingClaimAmount(xrpPlugin)

export const totalReceived = ({ xrpPlugin }: XrpPaychanUplink) =>
  incomingClaimAmount(xrpPlugin)

export const availableToSend = ({ xrpPlugin }: XrpPaychanUplink) =>
  outgoingChannelAmount(xrpPlugin).minus(outgoingClaimAmount(xrpPlugin))

export const availableToReceive = ({ xrpPlugin }: XrpPaychanUplink) =>
  incomingChannelAmount(xrpPlugin).minus(incomingClaimAmount(xrpPlugin))

export const availableToDebit = ({ plugin }: XrpPaychanUplink) =>
  convert(xrpBase(plugin.balance), xrp())

export const baseLayerBalance = () => {
  // TODO Implement this! (and make it sufficiently generic)
}

export const deposit = async ({
  authorize,
  api
}: {
  authorize: AuthorizeDeposit
  api: RippleAPI
}) => {
  // TODO Export this as a function to get the balance info of an account (for baseLayerBalance)
  // Confirm that the account has sufficient funds to cover the reserve
  const { ownerCount, xrpBalance } = await api.getAccountInfo(xrpAddress)
  const {
    validatedLedger: { reserveBaseXRP, reserveIncrementXRP }
  } = await api.getServerInfo()
  // TODO What unit is minBalance in? xrp, or drops? Unclear
  const minBalance =
    +reserveBaseXRP +
    +reserveIncrementXRP * ownerCount + // total current reserve
    +reserveIncrementXRP + // reserve for the channel
    +amount + // amount to deposit
    10 // Assume channel creation fee of 10 drops (unclear)
  const currentBalance = +xrpBalance
  if (currentBalance < minBalance) {
    throw new InsufficientFundsError()
  }

  // TODO If the fee is ~0 and the user already entered the amount, do they need to authorize it?
  const shouldContinue = await authorize({
    value: amount /** XRP */,
    fee: convert(drop(10), xrp()) /** XRP */
  })

  // TODO Check whether a new channel needs to be open, or if we're funding an existing channel ...
  //      (based on outgoing capacity)
}

// TODO Streaming credit off connector will need to be performed prior to withdrawals!
// TODO When should the internal plugin be disconnected?
export const withdraw = (state: State) => (uplink: XrpPaychanUplink) => async (
  authorize: AuthorizeWithdrawal
) => {
  const { api } = getSettler<XrpPaychanSettlementEngine>(state)(
    uplink.settlerType
  )
  const { address, secret } = getCredential<ReadyXrpCredential>(state)(uplink)

  /*
   * Per https://github.com/interledgerjs/ilp-plugin-xrp-paychan-shared/pull/23,
   * the TxSubmitter is a singleton per XRP address, so it will use the existing one
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
  const value = interledgerBalance(uplink).minus(fee) // TODO Is this correct?

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
