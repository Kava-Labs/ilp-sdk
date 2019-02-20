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
  BaseUplink,
  distinctBigNum
} from '../uplink'
import { MemoryStore } from '../utils/store'
import Web3 from 'web3'
import { HttpProvider } from 'web3/providers'
import createLogger from '../utils/log'
import { SettlementEngine, SettlementEngineType } from '../engine'
import { fetchGasPrice } from './shared/eth'
import { LedgerEnv, State, SettlementModule } from '..'
import { BehaviorSubject, fromEvent } from 'rxjs'
import { map, timeout, first } from 'rxjs/operators'

/**
 * ------------------------------------
 * SETTLEMENT ENGINE
 * ------------------------------------
 */

export interface MachinomySettlementEngine extends SettlementEngine {
  ethereumProvider: HttpProvider
}

export const setupEngine = async (
  ledgerEnv: LedgerEnv
): Promise<MachinomySettlementEngine> => {
  const network = ledgerEnv === 'mainnet' ? 'mainnet' : 'kovan'
  const ethereumProvider = new Web3.providers.HttpProvider(
    `https://${network}.infura.io/v3/92e263da65ac4703bf99df7828c6beca`
  )

  // TODO Does the Web3 provider even perform any block polling/are multiple instances bad?

  // TODO Download and run a Parity light client here?

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
  settlerType: SettlementEngineType.Machinomy
  privateKey: string
}

export type ReadyEthereumCredential = {
  settlerType: SettlementEngineType.Machinomy
  privateKey: string
  address: string
}

export const setupCredential = ({
  privateKey,
  settlerType
}: ValidatedEthereumPrivateKey) => async (): Promise<
  ReadyEthereumCredential
> => {
  if (!privateKey.startsWith('0x')) {
    privateKey = '0x' + privateKey
  }

  return {
    settlerType,
    privateKey,
    address: '0x' + privateToAddress(toBuffer(privateKey)).toString('hex')
  }
}

export const uniqueId = (cred: ReadyEthereumCredential) => cred.address

export const closeCredential = () => Promise.resolve()

/**
 * ------------------------------------
 * UPLINK
 * ------------------------------------
 */

export interface MachinomyUplinkConfig extends BaseUplinkConfig {
  settlerType: SettlementEngineType.Machinomy
  credential: ValidatedEthereumPrivateKey
}

export interface MachinomyBaseUplink extends BaseUplink {
  plugin: EthereumPlugin
  settlerType: SettlementEngineType.Machinomy
  pluginAccount: EthereumAccount
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
      distinctBigNum,
      toEth
    )
    .subscribe(totalSent$)

  const outgoingCapacity$ = new BehaviorSubject(new BigNumber(0))
  fromEvent<PaymentChannel | undefined>(pluginAccount.account.outgoing, 'data')
    .pipe(
      map(remainingInChannel),
      distinctBigNum,
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
      distinctBigNum,
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
      distinctBigNum,
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
  amount: BigNumber
  authorize: AuthorizeDeposit
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
        value: uplink.outgoingCapacity$.value.plus(channel.spent),
        fee: convert(wei(fee), eth())
      })
    }
  )

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

export interface MachinomySettlementModule
  extends SettlementModule<
    SettlementEngineType.Machinomy,
    MachinomySettlementEngine,
    ValidatedEthereumPrivateKey,
    ReadyEthereumCredential,
    MachinomyBaseUplink,
    ReadyMachinomyUplink
  > {
  readonly deposit: (
    uplink: ReadyMachinomyUplink
  ) => (
    state: State
  ) => (opts: {
    amount: BigNumber
    authorize: AuthorizeDeposit
  }) => Promise<void>
  readonly withdraw: (
    uplink: ReadyMachinomyUplink
  ) => (state: State) => (authorize: AuthorizeDeposit) => Promise<void>
}

export const Machinomy: MachinomySettlementModule = {
  setupEngine,
  setupCredential,
  uniqueId,
  closeCredential,
  connectUplink,
  deposit,
  withdraw
}
