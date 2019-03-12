import { convert, drop, xrp } from '@kava-labs/crypto-rate-utils'
import XrpPlugin, {
  ClaimablePaymentChannel,
  PaymentChannel,
  remainingInChannel,
  spentFromChannel,
  XrpAccount
} from '@kava-labs/ilp-plugin-xrp-paychan'
import BigNumber from 'bignumber.js'
import { deriveAddress, deriveKeypair } from 'ripple-keypairs'
import { RippleAPI } from 'ripple-lib'
import { BehaviorSubject, fromEvent } from 'rxjs'
import { first, map, timeout, startWith } from 'rxjs/operators'
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
    assetScale: 6,
    baseUnit: drop,
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

export const getBaseBalance = async (
  settler: XrpPaychanSettlementEngine,
  credential: ValidatedXrpSecret
) => {
  const response = await settler.api.getAccountInfo(credential.address)
  return new BigNumber(response.xrpBalance)
}

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
  readonly plugin: XrpPlugin
  readonly pluginAccount: XrpAccount
}

export type ReadyXrpPaychanUplink = XrpPaychanBaseUplink & ReadyUplink

const connectUplink = (credential: ValidatedXrpSecret) => (
  state: State
) => async (config: BaseUplinkConfig): Promise<XrpPaychanBaseUplink> => {
  const server = config.plugin.btp.serverUri
  const store = config.plugin.store

  const { secret } = credential
  const xrpServer = getXrpServerWebsocketUri(state.ledgerEnv)

  const plugin = new XrpPlugin(
    {
      role: 'client',
      server,
      xrpServer,
      xrpSecret: secret
    },
    {
      log: createLogger('ilp-plugin-xrp'),
      store: new MemoryStore(store)
    }
  )

  const pluginAccount = await plugin._loadAccount('peer')

  const toXrp = map<BigNumber, BigNumber>(amount =>
    convert(drop(amount), xrp())
  )

  const totalSent$ = new BehaviorSubject(new BigNumber(0))
  fromEvent<PaymentChannel | undefined>(pluginAccount.account.outgoing, 'data')
    .pipe(
      startWith(pluginAccount.account.outgoing.state),
      map(spentFromChannel),
      toXrp
    )
    .subscribe(totalSent$)

  const outgoingCapacity$ = new BehaviorSubject(new BigNumber(0))
  fromEvent<PaymentChannel | undefined>(pluginAccount.account.outgoing, 'data')
    .pipe(
      startWith(pluginAccount.account.outgoing.state),
      map(remainingInChannel),
      toXrp
    )
    .subscribe(outgoingCapacity$)

  const totalReceived$ = new BehaviorSubject(new BigNumber(0))
  fromEvent<ClaimablePaymentChannel | undefined>(
    pluginAccount.account.incoming,
    'data'
  )
    .pipe(
      startWith(pluginAccount.account.incoming.state),
      map(spentFromChannel),
      toXrp
    )
    .subscribe(totalReceived$)

  const incomingCapacity$ = new BehaviorSubject(new BigNumber(0))
  fromEvent<ClaimablePaymentChannel | undefined>(
    pluginAccount.account.incoming,
    'data'
  )
    .pipe(
      startWith(pluginAccount.account.incoming.state),
      map(remainingInChannel),
      toXrp
    )
    .subscribe(incomingCapacity$)

  return {
    settlerType: SettlementEngineType.XrpPaychan,
    credentialId: uniqueId(credential),
    plugin,
    pluginAccount,
    outgoingCapacity$,
    incomingCapacity$,
    totalSent$,
    totalReceived$
  }
}

const deposit = (uplink: ReadyXrpPaychanUplink) => (state: State) => async ({
  amount,
  authorize
}: {
  readonly amount: BigNumber
  readonly authorize: AuthorizeDeposit
}) => {
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
  const { address } = readyCredential

  const fundAmountDrops = convert(xrp(amount), drop())
  await uplink.pluginAccount.fundOutgoingChannel(fundAmountDrops, async fee => {
    // TODO Check the base layer balance to confirm there's enough $$$ on chain (with fee)!

    // Confirm that the account has sufficient funds to cover the reserve
    // TODO May throw if the account isn't found
    const { ownerCount, xrpBalance } = await api.getAccountInfo(address)
    const {
      validatedLedger: { reserveBaseXRP, reserveIncrementXRP }
    } = await api.getServerInfo()
    const minBalance =
      /* Minimum amount of XRP for every account to keep in reserve */
      +reserveBaseXRP +
      /** Current amount reserved in XRP for each object the account is responsible for */
      +reserveIncrementXRP * ownerCount +
      /** Additional reserve this channel requires, in units of XRP */
      +reserveIncrementXRP +
      /** Amount to fund the channel, in unit sof XRP */
      +amount +
      /** Assume channel creation fee from plugin, in units of XRP */
      +fee
    const currentBalance = +xrpBalance
    if (currentBalance < minBalance) {
      // TODO Return a specific type of error
      throw new Error('insufficient funds')
    }

    await authorize({
      value: amount,
      fee
    })
  })

  // Wait up to 1 minute for incoming capacity to be created
  await uplink.incomingCapacity$
    .pipe(
      first(amount => amount.isGreaterThan(0)),
      timeout(60000)
    )
    .toPromise()
}

const withdraw = (uplink: ReadyXrpPaychanUplink) => async (
  authorize: AuthorizeWithdrawal
) => {
  const claimChannel = uplink.pluginAccount.claimChannel(
    false,
    async (channel, fee) => {
      await authorize({
        value: uplink.outgoingCapacity$.value.plus(
          convert(drop(channel.spent), xrp())
        ),
        fee
      })
    }
  )

  // TODO This won't reject if the withdraw fails!
  const requestClose = uplink.pluginAccount.requestClose()

  // Simultaneously withdraw and request incoming capacity to be removed
  await Promise.all([claimChannel, requestClose])

  // TODO Confirm the incoming capacity has been closed -- or attempt to dispute it?
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
  withdraw,
  getBaseBalance
}
