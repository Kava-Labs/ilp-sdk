import { convert, eth, gwei, wei } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import { privateToAddress, toBuffer } from 'ethereumjs-util'
import EthereumPlugin, {
  EthereumAccount,
  remainingInChannel,
  spentFromChannel,
  PaymentChannel,
  ClaimablePaymentChannel
} from 'ilp-plugin-ethereum'
import {
  AuthorizeDeposit,
  AuthorizeWithdrawal,
  ReadyUplink,
  BaseUplinkConfig,
  BaseUplink
} from '../uplink'
import { MemoryStore } from '../utils/store'
import Web3 from 'web3'
import { HttpProvider } from 'web3/providers'
import createLogger from '../utils/log'
import { SettlementEngine, SettlementEngineType } from '../engine'
import { fetchGasPrice } from './shared/eth'
import { LedgerEnv, State } from '..'
import { BehaviorSubject, fromEvent } from 'rxjs'
import { map, timeout, first } from 'rxjs/operators'

/**
 * ------------------------------------
 * SETTLEMENT ENGINE
 * ------------------------------------
 */

export interface MachinomySettlementEngine extends SettlementEngine {
  readonly settlerType: SettlementEngineType.Machinomy
  readonly ethereumProvider: HttpProvider
}

export const setupEngine = async (
  ledgerEnv: LedgerEnv
): Promise<MachinomySettlementEngine> => {
  const network = ledgerEnv === 'mainnet' ? 'mainnet' : 'kovan'
  const ethereumProvider = new Web3.providers.HttpProvider(
    `https://${network}.infura.io/v3/92e263da65ac4703bf99df7828c6beca`
  )

  return {
    settlerType: SettlementEngineType.Machinomy,
    assetCode: 'ETH',
    assetScale: 9,
    baseUnit: gwei,
    exchangeUnit: eth,
    remoteConnectors: {
      local: {
        'Kava Labs': (token: string) => `btp+ws://:${token}@localhost:7442`
      },
      testnet: {
        'Kava Labs': (token: string) =>
          `btp+wss://:${token}@test.ilp.kava.io/eth`
      },
      mainnet: {}
    }[ledgerEnv],
    ethereumProvider
  }
}

/**
 * ------------------------------------
 * CREDENTIAL
 * ------------------------------------
 */

export interface ValidatedEthereumPrivateKey {
  readonly settlerType: SettlementEngineType.Machinomy
  readonly privateKey: string
}

export type ReadyEthereumCredential = {
  readonly settlerType: SettlementEngineType.Machinomy
  readonly privateKey: string
  readonly address: string
}

/**
 * Ensure that the given string is begins with given prefix
 * - Prefix the string if it doesn't already
 */
const prefixWith = (prefix: string, str: string) =>
  str.startsWith(prefix) ? str : prefix + str

const addressFromPrivate = (privateKey: string) =>
  privateToAddress(toBuffer(privateKey)).toString('hex')

// TODO If the private key is invalid, this should return a specific error rather than throwing
export const setupCredential = ({
  privateKey,
  settlerType
}: ValidatedEthereumPrivateKey) => async (): Promise<
  ReadyEthereumCredential
> => ({
  settlerType,
  privateKey: prefixWith('0x', privateKey),
  address: prefixWith('0x', addressFromPrivate(prefixWith('0x', privateKey)))
})

export const uniqueId = (cred: ReadyEthereumCredential) => cred.address

export const configFromEthereumCredential = ({
  address,
  ...config
}: ReadyEthereumCredential): ValidatedEthereumPrivateKey => config

/**
 * ------------------------------------
 * UPLINK
 * ------------------------------------
 */

export interface MachinomyUplinkConfig extends BaseUplinkConfig {
  readonly settlerType: SettlementEngineType.Machinomy
  readonly credential: ValidatedEthereumPrivateKey
}

export interface MachinomyBaseUplink extends BaseUplink {
  readonly plugin: EthereumPlugin
  readonly settlerType: SettlementEngineType.Machinomy
  readonly pluginAccount: EthereumAccount
}

export type ReadyMachinomyUplink = MachinomyBaseUplink & ReadyUplink

export const connectUplink = (credential: ReadyEthereumCredential) => (
  state: State
) => async (config: BaseUplinkConfig): Promise<MachinomyBaseUplink> => {
  const server = config.plugin.btp.serverUri
  const store = config.plugin.store

  const { privateKey: ethereumPrivateKey } = credential

  const settler = state.settlers[credential.settlerType]
  const { ethereumProvider } = settler

  const getGasPrice = () => fetchGasPrice(state)(settler)

  const plugin = new EthereumPlugin(
    {
      role: 'client',
      server,
      ethereumPrivateKey,
      ethereumProvider,
      getGasPrice
    },
    {
      store: new MemoryStore(store),
      log: createLogger('ilp-plugin-ethereum')
    }
  )

  const pluginAccount = await plugin._loadAccount('peer')

  const toEth = map<BigNumber, BigNumber>(amount => convert(wei(amount), eth()))

  const totalSent$ = new BehaviorSubject(new BigNumber(0))
  fromEvent<PaymentChannel | undefined>(pluginAccount.account.outgoing, 'data')
    .pipe(
      map(spentFromChannel),
      toEth
    )
    .subscribe(totalSent$)

  const outgoingCapacity$ = new BehaviorSubject(new BigNumber(0))
  fromEvent<PaymentChannel | undefined>(pluginAccount.account.outgoing, 'data')
    .pipe(
      map(remainingInChannel),
      toEth
    )
    .subscribe(outgoingCapacity$)

  const totalReceived$ = new BehaviorSubject(new BigNumber(0))
  fromEvent<ClaimablePaymentChannel | undefined>(
    pluginAccount.account.incoming,
    'data'
  )
    .pipe(
      map(spentFromChannel),
      toEth
    )
    .subscribe(totalReceived$)

  const incomingCapacity$ = new BehaviorSubject(new BigNumber(0))
  fromEvent<ClaimablePaymentChannel | undefined>(
    pluginAccount.account.incoming,
    'data'
  )
    .pipe(
      map(remainingInChannel),
      toEth
    )
    .subscribe(incomingCapacity$)

  return {
    settlerType: SettlementEngineType.Machinomy,
    credentialId: uniqueId(credential),
    outgoingCapacity$,
    incomingCapacity$,
    totalReceived$,
    totalSent$,
    pluginAccount,
    plugin
  }
}

export const baseLayerBalance = async (
  settler: MachinomySettlementEngine,
  credential: ReadyEthereumCredential
) => {
  const web3 = new Web3(settler.ethereumProvider)
  const balanceWei = new BigNumber(
    (await web3.eth.getBalance(credential.address)).toString()
  )

  return convert(wei(balanceWei), eth())
}

export const deposit = (uplink: ReadyMachinomyUplink) => () => async ({
  amount,
  authorize
}: {
  readonly amount: BigNumber
  readonly authorize: AuthorizeDeposit
}) => {
  const fundAmountWei = convert(eth(amount), wei())
  await uplink.pluginAccount.fundOutgoingChannel(fundAmountWei, async fee => {
    // TODO Check the base layer balance to confirm there's enough $$$ on chain (with fee)!

    await authorize({
      value: amount,
      fee: convert(wei(fee), eth())
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

const withdraw = (uplink: ReadyMachinomyUplink) => (state: State) => async (
  authorize: AuthorizeWithdrawal
) => {
  const claimChannel = uplink.pluginAccount.claimIfProfitable(
    false,
    async (channel, fee) => {
      await authorize({
        value: uplink.outgoingCapacity$.value.plus(
          convert(wei(channel.spent), eth())
        ),
        fee: convert(wei(fee), eth())
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

export const Machinomy = {
  setupEngine,
  setupCredential,
  uniqueId,
  connectUplink,
  deposit,
  withdraw
}
