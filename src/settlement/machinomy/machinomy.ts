import { convert, eth, gwei, usd, wei } from '@kava-labs/crypto-rate-utils'
import { ApiUtils } from 'api'
import BigNumber from 'bignumber.js'
import { isValidPrivate, privateToAddress, toBuffer } from 'ethereumjs-util'
import EthereumPlugin from 'ilp-plugin-ethereum'
import EthereumAccount, { AccountData } from 'ilp-plugin-ethereum/build/account'
import {
  remainingInChannel,
  spentFromChannel
} from 'ilp-plugin-ethereum/build/utils/contract'
import {
  AuthorizeDeposit,
  AuthorizeWithdrawal,
  interledgerBalance,
  NewUplink,
  UplinkConfig,
  getNativeMaxInFlight,
  getPluginBalanceConfig,
  getPluginMaxPacketAmount
} from 'uplink'
import { Just, Maybe, Nothing } from 'purify-ts/adts/Maybe'
import { MemoryStore } from 'utils/store'
import { streamMoney } from 'utils/switch'
import Web3 from 'web3'
import { HttpProvider } from 'web3/providers'
import createLogger from '../../utils/log'
import { SettlementEngine, SettlementEngineType } from '..'
import { fetchGasPrice } from '../shared/eth'

/**
 * ------------------------------------
 * SETTLEMENT ENGINE
 * ------------------------------------
 */

export interface MachinomySettlementEngine extends SettlementEngine {
  ethereumProvider: HttpProvider
}

export const setupEngine = (utils: ApiUtils): MachinomySettlementEngine => {
  const network = utils.ledgerEnv === 'mainnet' ? 'mainnet' : 'kovan'
  const ethereumProvider = new Web3.providers.HttpProvider(
    `https://${network}.infura.io/v3/92e263da65ac4703bf99df7828c6beca`
  ) /** Disconnect is a no-op on the HTTP provider */
  // TODO ^ Does the Web3 provider even perform any block polling?
  //        Or can I just ...?

  // TODO Download and run a Parity light client here?

  return {
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
    },
    ethereumProvider
  }
}

// TODO These can likely be generic and then passed into the "createUplink" method

/**
 * ------------------------------------
 * CREDENTIAL
 * ------------------------------------
 */

type Brand<K, T> = K & { __brand: T } // TODO Use that "newtypes" library or whatever it's called
export type ValidatedEthereumPrivateKey = Brand<string, 'ValidEthPrivateKey'>

export const validate = (
  privateKey: string
): Maybe<ValidatedEthereumPrivateKey> => {
  // Requires a 0x in front to validate private key, so prepend it if it's missing
  // (Web3 also throws an obscure error if not)
  if (!privateKey.startsWith('0x')) {
    privateKey = '0x' + privateKey
  }

  return isValidPrivate(toBuffer(privateKey))
    ? Just(privateKey as ValidatedEthereumPrivateKey)
    : Nothing
}

export type ReadyEthereumCredential = {
  settlerType: SettlementEngineType.Machinomy

  privateKey: string
  address: string
}

export const setupCredential = (
  privateKey: ValidatedEthereumPrivateKey
): ReadyEthereumCredential => ({
  privateKey,
  address: '0x' + privateToAddress(toBuffer(privateKey)).toString('hex')
})

// TODO Does the unique id need to be generated from the
//      validated credential, or the ready credential?
export const uniqueId = (cred: ValidatedEthereumPrivateKey) => cred

/**
 * ------------------------------------
 * UPLINK
 * ------------------------------------
 */

// TODO Move all the Ethereum-based credentials to their own config,
//      since they can be abstracted

export interface MachinomyUplinkConfig {
  settlerType: SettlementEngineType.Machinomy
  credential: ValidatedEthereumPrivateKey
}

export interface OnlyMachinomy {
  plugin: EthereumPlugin
  settlerType: SettlementEngineType.Machinomy
  // credentialId: string // TODO This can be abstracted to "NewUplink" !
  // TODO ^ since lookups only require (settlerType & credentialId)
}

export type MachinomyUplink = OnlyMachinomy & NewUplink

/* prettier-ignore */
export type ConnectMachinomyUplink =
  (utils: ApiUtils) =>
  (settler: MachinomySettlementEngine) =>
  (credential: ReadyEthereumCredential) =>
  (config: UplinkConfig & MachinomyUplinkConfig) =>
  OnlyMachinomy

export const connectUplink: ConnectMachinomyUplink = utils => settler => credential => config => {
  const server = config.plugin.btp.serverUri
  const store = config.plugin.store

  const { privateKey: ethereumPrivateKey } = credential
  const { ethereumProvider } = settler

  const maxInFlight = getNativeMaxInFlight(utils, settler)
  const getGasPrice = () => fetchGasPrice(utils)(settler)

  const plugin = new EthereumPlugin(
    {
      role: 'client',
      server,
      ethereumPrivateKey,
      ethereumProvider,
      balance: getPluginBalanceConfig(maxInFlight),
      maxPacketAmount: getPluginMaxPacketAmount(maxInFlight),
      getGasPrice /* Only used for channel watcher to settle channels */
    },
    {
      store: new MemoryStore(store),
      log: createLogger('ilp-plugin-ethereum')
    }
  )

  return {
    settlerType: SettlementEngineType.Machinomy,
    plugin
  }
}

/**
 * Generic utils for Ethereum
 */

// TODO Neither of these helpers should be necessary if the eth plugin is refactored

/** Lookup the internal plugin account from the given uplink */
const getAccount = (uplink: MachinomyUplink): Maybe<EthereumAccount> =>
  Maybe.fromNullable(uplink.plugin._accounts.get('peer'))

/**
 * Lookup the internal plugin account, and use the given getter to
 * fetch a balance from it, defaulting to 0 if the account doesn't exist
 */
const mapAccountBalance = (
  uplink: MachinomyUplink,
  mapper: (account: AccountData) => BigNumber
) =>
  getAccount(uplink)
    .map(({ account }) => mapper(account))
    .orDefault(new BigNumber(0))

/**
 * Balance-related getters
 */

export const availableToReceive = (uplink: MachinomyUplink) =>
  mapAccountBalance(uplink, account =>
    convert(wei(remainingInChannel(account.incoming)), eth())
  )

export const availableToSend = (uplink: MachinomyUplink) =>
  mapAccountBalance(uplink, account =>
    convert(wei(remainingInChannel(account.outgoing)), eth())
  )

export const totalReceived = (uplink: MachinomyUplink) =>
  mapAccountBalance(uplink, account =>
    convert(wei(spentFromChannel(account.incoming)), eth())
  )

export const availableToDebit = (uplink: MachinomyUplink) =>
  mapAccountBalance(uplink, account => convert(gwei(account.balance), eth()))

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

/**
 * Moving between layer 1 <-> layer 2
 */

// TODO Update the eth plugin & confirm all units are correct.
export const deposit = (utils: ApiUtils) => (
  settler: MachinomySettlementEngine
) => (credential: ReadyEthereumCredential) => (
  uplink: MachinomyUplink
) => async ({
  amount = convert(usd(10), eth(), utils.rateBackend),
  authorize
}: {
  amount?: BigNumber
  authorize: AuthorizeDeposit
}) => {
  const gasPriceWei = new BigNumber(await fetchGasPrice(utils)(settler))
  const fundAmountWei = convert(eth(amount), wei())

  const pluginAccount = getAccount(uplink).extract()
  if (!pluginAccount) {
    // TODO Log the error? This shouldn't really ever occur
    return
  }

  const web3 = new Web3(settler.ethereumProvider)
  // TODO Make sure "gas" is available

  const internalAuthorize = async (gas: BigNumber): Promise<boolean> => {
    const txFeeWei = gasPriceWei.times(gas)
    const balanceEth = await baseLayerBalance(settler, credential)
    const balanceWei = convert(eth(balanceEth), wei())

    const totalAmountWei = fundAmountWei.plus(txFeeWei)
    const insufficientFunds = totalAmountWei.gt(balanceWei)
    if (insufficientFunds) {
      throw new InsufficientFundsError()
    }

    return authorize({
      fee: convert(wei(txFeeWei), eth()) /** eth */,
      value: amount /** eth */
    })
  }

  // TODO Implement this open new channel/deposit to channel logic in the eth plugin itself. Simpler.
  const fundChannel = !pluginAccount.account.outgoing
    ? pluginAccount.openChannel
    : pluginAccount.depositToChannel
  await fundChannel({
    amount: fundAmountWei,
    gasPrice: gasPriceWei.toNumber(),
    authorize: internalAuthorize
  })

  // Stream 1 packet to self to open incoming capacity
  // Don't await in case this resolves *after* the money comes in
  streamMoney({
    amount: new BigNumber(1) /** gwei */,
    source: uplink,
    dest: uplink
  })

  // TODO How to catch errors here? If "poor exchange rate," best way to handle that?

  // TODO Watch "availableToReceive" -- when that becomes > 0
  //      (subject to some timeout, of course)
}

// TODO Stream funds off the connector BEFORE the actual withdrawal

const withdraw = (utils: ApiUtils) => (settler: MachinomySettlementEngine) => (
  credential: ReadyEthereumCredential
) => (uplink: MachinomyUplink) => async ({
  authorize
}: {
  authorize: AuthorizeWithdrawal
}) => {
  const gasPrice = await fetchGasPrice(utils)(settler)
  const { gas, claim, approve, deny } = await pluginAccount.claimChannel(
    gasPrice
  )
  const bestIncomingClaim = claim.value
  const txFeeWei = new BigNumber(gasPrice).times(gas)

  // TODO make sure units are correct !

  const shouldContinue = await authorize({
    fee: convert(wei(txFeeWei), eth()) /** eth */,
    value: interledgerBalance(uplink) /** eth */
  })

  if (!shouldContinue) {
    return deny()
  }

  // Simultaneously withdraw and request incoming capacity to be removed
  await Promise.all([
    approve(), // Claim & close incoming channel
    pluginAccount.requestClose() // Request peer to close outgoing channel
  ])

  // TODO I'm not sure this is necessary!
  await plugin.disconnect()

  // TODO Close this account/remove uplink at top level?
}
