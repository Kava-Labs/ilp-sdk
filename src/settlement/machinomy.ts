import {
  exchangeQuantity,
  baseQuantity,
  accountQuantity,
  AssetQuantity
} from '@kava-labs/crypto-rate-utils'
import axios from 'axios'
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
import { State } from '..'
import { ethAsset, getAsset } from '../assets'
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

// TODO If this is imported from '..', it causes a runtime TypeError that I think is caused by circular dependency resolution
enum LedgerEnv {
  Mainnet = 'mainnet',
  Testnet = 'testnet',
  Local = 'local'
}

const DAI_MAINNET_ADDRESS = '0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359'
const DAI_KOVAN_ADDRESS = '0xC4375B7De8af5a38a93548eb8453a498222C4fF2'

const TOKEN_ADDRESSES = [
  {
    symbol: 'DAI',
    ledgerEnv: LedgerEnv.Mainnet,
    tokenAddress: DAI_MAINNET_ADDRESS
  },
  {
    symbol: 'DAI',
    ledgerEnv: LedgerEnv.Testnet,
    tokenAddress: DAI_KOVAN_ADDRESS
  },
  {
    symbol: 'DAI',
    ledgerEnv: LedgerEnv.Local,
    tokenAddress: DAI_KOVAN_ADDRESS
  }
]

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

// TODO Should this be denominated in the ERC-20 itself? (Return array of quantities?)
export const getBaseBalance = async (
  settler: MachinomySettlementEngine,
  credential: ReadyEthereumCredential
): Promise<AssetQuantity> => {
  const balanceWei = await settler.ethereumProvider.getBalance(
    credential.address
  )
  return exchangeQuantity(baseQuantity(ethAsset, balanceWei.toString()))
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

  const assetType = config.assetType || 'ETH'
  const asset = getAsset(assetType)

  // If using ERC-20s, fetch token contract address
  // tslint:disable-next-line:no-let
  let tokenAddress: string | undefined
  if (assetType !== 'ETH') {
    const tokenMetadata = TOKEN_ADDRESSES.find(
      tokenMetadata =>
        tokenMetadata.ledgerEnv === state.ledgerEnv &&
        tokenMetadata.symbol === assetType
    )

    if (!tokenMetadata) {
      throw new Error('ERC-20 not supported')
    } else {
      tokenAddress = tokenMetadata.tokenAddress
    }
  }

  const plugin = new EthereumPlugin(
    {
      role: 'client',
      server,
      ethereumPrivateKey,
      ethereumProvider,
      getGasPrice: fetchGasPrice,
      tokenAddress
    },
    {
      store: new MemoryStore(store),
      log: createLogger('ilp-plugin-ethereum')
    }
  )

  const pluginAccount = await plugin._loadAccount('peer')

  const mapToExchangeUnit = map<BigNumber, BigNumber>(amount =>
    amount.shiftedBy(-asset.exchangeScale)
  )

  const totalSent$ = new BehaviorSubject(new BigNumber(0))
  fromEvent<PaymentChannel | undefined>(pluginAccount.account.outgoing, 'data')
    .pipe(
      startWith(pluginAccount.account.outgoing.state),
      map(spentFromChannel),
      mapToExchangeUnit
    )
    .subscribe(totalSent$)

  const outgoingCapacity$ = new BehaviorSubject(new BigNumber(0))
  fromEvent<PaymentChannel | undefined>(pluginAccount.account.outgoing, 'data')
    .pipe(
      startWith(pluginAccount.account.outgoing.state),
      map(remainingInChannel),
      mapToExchangeUnit
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
      mapToExchangeUnit
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
      mapToExchangeUnit
    )
    .subscribe(incomingCapacity$)

  return {
    settlerType: SettlementEngineType.Machinomy,
    asset,
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
  const amountBaseUnits = baseQuantity(exchangeQuantity(uplink.asset, amount))
    .amount
  await uplink.pluginAccount.fundOutgoingChannel(
    amountBaseUnits,
    async feeWei => {
      // TODO Check the base layer balance to confirm there's enough $$$ on chain (with fee)!

      await authorize({
        value: amount,
        fee: exchangeQuantity(baseQuantity(ethAsset, feeWei))
      })
    }
  )

  // Wait up to 2 minutes for incoming capacity to be created
  await uplink.incomingCapacity$
    .pipe(
      first(amount => amount.isGreaterThan(0)),
      timeout(120000)
    )
    .toPromise()
}

// TODO Move this code into generic "uplink" code?
const withdraw = (uplink: ReadyMachinomyUplink) => async (
  authorize: AuthorizeWithdrawal
) => {
  /* tslint:disable-next-line:no-let */
  let claimChannel: Promise<any>

  const isAuthorized = new Promise<any>((resolve, reject) => {
    /* tslint:disable-next-line:no-let */
    let claimChannelAuthReady = false

    const authorizeOnlyOutgoing = async () =>
      !claimChannelAuthReady &&
      authorize({
        value: uplink.outgoingCapacity$.value,
        fee: exchangeQuantity(ethAsset, 0)
      }).then(resolve, reject)

    claimChannel = uplink.pluginAccount
      .claimIfProfitable(false, (channel, feeWei) => {
        claimChannelAuthReady = true

        const internalAuthorize = authorize({
          value: uplink.outgoingCapacity$.value.plus(
            exchangeQuantity(baseQuantity(uplink.asset, channel.spent)).amount
          ),
          fee: exchangeQuantity(baseQuantity(ethAsset, feeWei))
        })

        internalAuthorize.then(resolve, reject)

        return internalAuthorize
      })
      // If `authorize` was never called to claim the channel,
      // call `authorize` again, but this time only to request the outgoing channel to be closed
      // (this prevents deadlocks if for some reason the incoming channel was already closed)
      .then(authorizeOnlyOutgoing, authorizeOnlyOutgoing)
  })

  // TODO This won't reject if the withdraw fails!
  // Only request the peer to the close if the withdraw is authorized first
  const requestClose = isAuthorized.then(() =>
    uplink.pluginAccount.requestClose()
  )

  // Simultaneously withdraw and request incoming capacity to be removed
  /* tslint:disable-next-line:no-unnecessary-type-assertion */
  await Promise.all([claimChannel!, requestClose])

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

/**
 * Use the `fast` gasPrice per EthGasStation on mainnet
 * Fallback to Web3 eth_gasPrice RPC call if it fails
 */
export const fetchGasPrice = (
  ethereumProvider: ethers.providers.Provider
) => (): Promise<BigNumber> =>
  axios
    .get('https://ethgasstation.info/json/ethgasAPI.json')
    .then(
      ({ data }) =>
        baseQuantity(accountQuantity(ethAsset, data.fast / 10)).amount
    )
    .catch(async () => bnToBigNumber(await ethereumProvider.getGasPrice()))

const bnToBigNumber = (bn: ethers.utils.BigNumber) =>
  new BigNumber(bn.toString())
