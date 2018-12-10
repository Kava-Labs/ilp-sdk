import { convert, eth, gwei, usd, wei } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import createLogger from 'ilp-logger'
import EthereumPlugin from 'ilp-plugin-ethereum'
import pEvent from 'p-event'
import Web3 from 'web3'
import { HttpProvider } from 'web3/providers'
import { ILedgerOpts, Ledger } from '../ledger'
import { PluginWrapper } from '../utils/middlewares'
import { streamMoney } from '../utils/stream'
import { IPlugin } from '../utils/types'

export interface IEthOpts extends ILedgerOpts {
  readonly ethereumPrivateKey: string
}

// TODO Should we emit events on "escrow" and on "send money" ?

export class Eth extends Ledger {
  public static readonly assetCode = 'ETH'
  public readonly baseUnit = gwei
  public readonly exchangeUnit = eth
  public readonly remoteConnectors = {
    local: {
      'Kava Labs': (token: string) => `btp+ws://:${token}@localhost:7442`
    },
    testnet: {
      'Kava Labs': (token: string) => `btp+wss://:${token}@test.ilp.kava.io/eth`
    },
    mainnet: {
      'Kava Labs': (token: string) => `btp+wss://:${token}@ilp.kava.io/eth`
    }
  }

  private readonly ethereumPrivateKey: string
  private readonly ethereumProvider: HttpProvider

  constructor({ ethereumPrivateKey, ...opts }: IEthOpts) {
    super(opts)

    this.ethereumPrivateKey = ethereumPrivateKey
    this.ethereumProvider = new Web3.providers.HttpProvider(
      `https://${
        process.env.LEDGER_ENV === 'mainnet' ? 'mainnet' : 'kovan'
      }.infura.io/bXIbx0x6ofEuDANTSeKI`
    )
  }

  // TODO Max packet wrapper fucks everything up! Find a better solution.

  public async createPlugin(serverUri: string) {
    // TODO On kava-connector, incoming channel fee is 0 (temporarily)
    const gas = 115636
    const gasPrice = await this.getGasPrice()
    // Multiply fee be 2x for channel back to ourselves
    const txFee = convert(wei(gasPrice.times(gas)), gwei()).times(2)

    const outgoingChannelAmount = convert(usd(10), gwei(), this.rateBackend)

    /**
     * Machinomy settlements are so fast that we only need to prefund a tad over 1x max packet
     */
    const maxInFlight = await this.maxInFlight
    const maxPrefund = txFee
      .plus(maxInFlight.times(1.1))
      .dp(0, BigNumber.ROUND_CEIL)
    const maxCredit = maxPrefund
      .plus(maxInFlight.times(2))
      .dp(0, BigNumber.ROUND_CEIL)

    const plugin = (new EthereumPlugin(
      {
        balance: {
          maximum: maxCredit,
          settleTo: maxPrefund,
          settleThreshold: maxPrefund
        },
        ethereumPrivateKey: this.ethereumPrivateKey,
        ethereumProvider: this.ethereumProvider,
        outgoingChannelAmount,
        role: 'client',
        server: serverUri
      },
      {
        store: this.store
      }
    ) as unknown) as IPlugin // TODO fix the incompatibilities between eventemitters

    const that = this
    return new PluginWrapper({
      plugin,
      ildcpInfo: {
        clientAddress: '',
        assetCode: 'ETH',
        assetScale: 9
      },
      log: createLogger('ilp-plugin-ethereum:max-packet'),
      maxPacketAmount: maxInFlight.toString()
    })
  }

  protected async setupPlugin(): Promise<void> {
    // TODO Remove this with new eth plugin
    // Wait to ensure server credits the claim from `connect`
    await new Promise(r => setTimeout(r, 500))

    const gasPrice = await this.getGasPrice()
    const openTxFee = gasPrice.times(115636)

    const sendAmount = convert(wei(openTxFee.times(1.5)), gwei())

    let actualReceived = new BigNumber(0)

    const shouldFulfill = (
      sourceAmount: BigNumber,
      destAmount: BigNumber
    ): boolean => {
      const doneSending = actualReceived.gt(sendAmount)
      const minDestAmount = sourceAmount
        .times(0.98)
        .integerValue(BigNumber.ROUND_DOWN)
      const willFulfill = destAmount.gte(minDestAmount) && !doneSending
      if (willFulfill) {
        actualReceived = actualReceived.plus(destAmount)
      }

      return willFulfill
    }

    const nextPacketAmount = (maxPacketAmount: BigNumber) =>
      actualReceived.gt(sendAmount) ? new BigNumber(0) : maxPacketAmount

    // Don't await in case this resolves *after* the money comes in
    streamMoney({
      source: this,
      dest: this,
      shouldFulfill,
      nextPacketAmount
    })

    // TODO Check how much we actually sent, and log "poor exchange rate" or something if it failed

    // Wait for us to receive money so we know the paychans are bilateral
    let timer: NodeJS.Timer
    await Promise.race([
      pEvent(this, 'moneyIn'),
      // Wait up to 60 seconds for the channel to be opened
      new Promise(
        () =>
          (timer = setTimeout(() => {
            throw new Error('Failed to open reciprocal channel on Ethereum')
          }, 60000))
      )
    ])

    clearTimeout(timer)
  }

  protected async destroyPlugin(plugin: IPlugin) {
    // @ts-ignore DefinitelyTyped is incomplete
    this.ethereumProvider.disconnect()
    return plugin.disconnect()
  }

  private async getGasPrice(): Promise<BigNumber> {
    const web3 = new Web3(this.ethereumProvider)
    return new BigNumber(await web3.eth.getGasPrice())
  }
}
