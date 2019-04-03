import { convert, eth, gwei, wei } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import { ethers } from 'ethers'
import EthereumPlugin, {
  ClaimablePaymentChannel,
  EthereumAccount,
  PaymentChannel,
  remainingInChannel,
  spentFromChannel
} from 'ilp-plugin-ethereum'
import { BehaviorSubject, fromEvent } from 'rxjs'
import { first, map, startWith, timeout } from 'rxjs/operators'
import { LedgerEnv, State } from '..'
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
import { fetchGasPrice } from './shared/eth'

/**
 * ------------------------------------
 * SETTLEMENT ENGINE
 * ------------------------------------
 */

export interface MachinomySettlementEngine extends SettlementEngine {
  readonly settlerType: SettlementEngineType.Machinomy
  readonly ethereumProvider: ethers.providers.Provider
  readonly fetchGasPrice?: () => Promise<BigNumber>
}

export const setupEngine = async (
  ledgerEnv: LedgerEnv
): Promise<MachinomySettlementEngine> => {
  const network = ledgerEnv === LedgerEnv.Mainnet ? 'homestead' : 'kovan'
  const ethereumProvider = ethers.getDefaultProvider(network)

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
    ethereumProvider,
    fetchGasPrice:
      ledgerEnv === LedgerEnv.Mainnet
        ? fetchGasPrice(ethereumProvider)
        : undefined
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

/** Ensure that the given hex string begins with "0x" */
const ensureHexPrefix = (hexStr: string) =>
  hexStr.startsWith('0x') ? hexStr : '0x' + hexStr

const addressFromPrivate = (privateKey: string) =>
  ethers.utils.computeAddress(privateKey)

// TODO If the private key is invalid, this should return a specific error rather than throwing
export const setupCredential = ({
  privateKey,
  settlerType
}: ValidatedEthereumPrivateKey) => async (): Promise<
  ReadyEthereumCredential
> => ({
  settlerType,
  privateKey: ensureHexPrefix(privateKey),
  address: addressFromPrivate(ensureHexPrefix(privateKey))
})

export const uniqueId = (cred: ReadyEthereumCredential) => cred.address

export const configFromEthereumCredential = ({
  address,
  ...config
}: ReadyEthereumCredential): ValidatedEthereumPrivateKey => config

export const getBaseBalance = async (
  settler: MachinomySettlementEngine,
  credential: ReadyEthereumCredential
) => {
  const balanceWei = await settler.ethereumProvider.getBalance(
    credential.address
  )
  return convert(wei(balanceWei.toString()), eth())
}

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
  const { ethereumProvider, fetchGasPrice } = settler

  const plugin = new EthereumPlugin(
    {
      role: 'client',
      server,
      ethereumPrivateKey,
      ethereumProvider,
      getGasPrice: fetchGasPrice
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
      startWith(pluginAccount.account.outgoing.state),
      map(spentFromChannel),
      toEth
    )
    .subscribe(totalSent$)

  const outgoingCapacity$ = new BehaviorSubject(new BigNumber(0))
  fromEvent<PaymentChannel | undefined>(pluginAccount.account.outgoing, 'data')
    .pipe(
      startWith(pluginAccount.account.outgoing.state),
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
      startWith(pluginAccount.account.incoming.state),
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
      startWith(pluginAccount.account.incoming.state),
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

const withdraw = (uplink: ReadyMachinomyUplink) => async (
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
  withdraw,
  getBaseBalance
}
