import { convert, eth, gwei, usd, wei } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import { isValidPrivate, privateToAddress, toBuffer } from 'ethereumjs-util'
import EthereumPlugin, { AccountData } from 'ilp-plugin-ethereum'
import {
  AuthorizeDeposit,
  AuthorizeWithdrawal,
  ReadyUplink,
  BaseUplinkConfig,
  BaseUplink,
  distinctBigNum
} from '../../uplink'
import { MemoryStore } from '../../utils/store'
import { streamMoney } from '../../services/switch'
import Web3 from 'web3'
import { HttpProvider } from 'web3/providers'
import createLogger from '../../utils/log'
import { SettlementEngine, SettlementEngineType } from '../../engine'
import { fetchGasPrice } from '../shared/eth'
import { LedgerEnv, State, SettlementModule } from '../..'
import { Option, some, none } from 'fp-ts/lib/Option'
import { Brand } from '../../types/util'
import { Subject, BehaviorSubject } from 'rxjs'
import { map } from 'rxjs/operators'

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
      mainnet: {
        'Kava Labs': (token: string) => `btp+wss://:${token}@ilp.kava.io/eth`
      }
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

// TODO Add this to setupCredential!
// export const validate = (
//   privateKey: string
// ): Option<ValidatedEthereumPrivateKey> => {
//   // Requires a 0x in front to validate private key, so prepend it if it's missing
//   // (Web3 also throws an obscure error if not)

//   return isValidPrivate(toBuffer(privateKey))
//     ? some({
//         settlerType: SettlementEngineType.Machinomy,
//         privateKey
//       })
//     : none
// }

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
  pluginAccount$: Subject<AccountData>
}

export type ReadyMachinomyUplink = MachinomyBaseUplink & ReadyUplink

export const connectUplink = (credential: ReadyEthereumCredential) => (
  state: State
) => async (config: BaseUplinkConfig): Promise<MachinomyBaseUplink> => {
  const server = config.plugin.btp.serverUri
  const store = config.plugin.store

  const { privateKey: ethereumPrivateKey } = credential
  const settler = state.settlers[
    credential.settlerType
  ]
  const { ethereumProvider } = settler

  const getGasPrice = () => fetchGasPrice(state)(settler)

  const pluginAccount$ = new Subject<AccountData>()
  const storeProxy = new Proxy(store, {
    set: (target, key, val) => {
      if (key === 'account') {
        pluginAccount$.next(JSON.parse(val))
      }

      return Reflect.set(target, key, val)
    }
  })

  const plugin = new EthereumPlugin(
    {
      server,
      ethereumPrivateKey,
      ethereumProvider,
      getGasPrice
    },
    {
      store: new MemoryStore(storeProxy),
      log: createLogger('ilp-plugin-ethereum')
    }
  )

  // TODO Updates to outgoingChannelCache may not trigger updates here, which is bad!

  const totalSent$ = new BehaviorSubject(new BigNumber(0))
  pluginAccount$
    .pipe(
      map(
        account =>
          new BigNumber(
            account.bestOutgoingClaim ? account.bestOutgoingClaim.value : 0
          )
      ),
      distinctBigNum,
      map(value => convert(wei(value), eth()))
    )
    .subscribe(totalSent$)

  const outgoingCapacity$ = new BehaviorSubject(new BigNumber(0))
  pluginAccount$
    .pipe(
      map(account =>
        account.outgoingChannelId
          ? plugin.channelCache[account.outgoingChannelId]
            ? plugin.channelCache[account.outgoingChannelId].value.minus(
                account.bestOutgoingClaim
                  ? account.bestOutgoingClaim.value
                  : new BigNumber(0)
              )
            : new BigNumber(0)
          : new BigNumber(0)
      ),
      distinctBigNum,
      map(value => convert(wei(value), eth()))
    )
    .subscribe(outgoingCapacity$)

  const totalReceived$ = new BehaviorSubject(new BigNumber(0))
  pluginAccount$
    .pipe(
      map(
        account =>
          new BigNumber(
            account.bestIncomingClaim ? account.bestIncomingClaim.value : 0
          )
      ),
      distinctBigNum,
      map(value => convert(wei(value), eth()))
    )
    .subscribe(totalReceived$)

  const incomingCapacity$ = new BehaviorSubject(new BigNumber(0))
  pluginAccount$
    .pipe(
      map(account =>
        account.bestIncomingClaim
          ? plugin.channelCache[account.bestIncomingClaim.channelId]
            ? plugin.channelCache[
                account.bestIncomingClaim.channelId
              ].value.minus(account.bestIncomingClaim.value)
            : new BigNumber(0)
          : new BigNumber(0)
      ),
      distinctBigNum,
      map(value => convert(wei(value), eth()))
    )
    .subscribe(outgoingCapacity$)

  return {
    settlerType: SettlementEngineType.Machinomy,
    credentialId: uniqueId(credential),
    outgoingCapacity$,
    incomingCapacity$,
    totalReceived$,
    totalSent$,
    pluginAccount$,
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

  await uplink.plugin.fundOutgoingChannel(fundAmountWei, async fee => {
    // TODO Check the base layer balance to confirm there's enough $$$ on chain (with fee)!

    await authorize({
      value: amount,
      fee: convert(wei(fee), eth())
    })
  })

  // TODO This is a hack to get the balance to update -- fix this
  uplink.pluginAccount$.next(uplink.plugin.account)

  // TODO Add functionality to request/get incoming capacity!
  // TODO Watch "availableToReceive" -- when that becomes > 0
  //      (subject to some timeout, of course)
}

const withdraw = (uplink: ReadyMachinomyUplink) => (state: State) => async (
  authorize: AuthorizeWithdrawal
) => {
  const claimChannel = uplink.plugin.claimIfProfitable(false, async fee => {
    await authorize({
      // TODO plugin itself should return the value so we know EXACTLY how much will be claimed
      value: uplink.outgoingCapacity$.value.plus(uplink.totalReceived$.value),
      fee: convert(wei(fee), eth())
    })
  })

  const requestClose = uplink.plugin._requestClose()

  // Simultaneously withdraw and request incoming capacity to be removed
  await Promise.all([claimChannel, requestClose])

  // TODO This is a ahck to get the balance to updated
  uplink.pluginAccount$.next(uplink.plugin.account)

  // TODO Also, confirm the incoming capacity has been closed -- or attempt to dispute it?
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
