import { convert, usd, xrp, xrpBase } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import createLogger from 'ilp-logger'
import XrpAsymClient from 'ilp-plugin-xrp-asym-client'
import { createSubmitter } from 'ilp-plugin-xrp-paychan-shared'
import { deriveAddress, deriveKeypair } from 'ripple-keypairs'
import { RippleAPI } from 'ripple-lib'
import { ILedgerOpts, Ledger } from '../ledger'
import { PluginWrapper } from '../utils/middlewares'
import { IPlugin } from '../utils/types'

interface IXrpOpts extends ILedgerOpts {
  readonly xrpSecret: string
}

export class Xrp extends Ledger {
  public static readonly assetCode = 'XRP'
  public readonly baseUnit = xrpBase
  public readonly exchangeUnit = xrp
  public readonly remoteConnectors = {
    local: {
      'Kava Labs': (token: string) => `btp+ws://:${token}@localhost:7443`
    },
    testnet: {
      'Kava Labs': (token: string) => `btp+wss://:${token}@test.ilp.kava.io/xrp`
    },
    mainnet: {
      'Kava Labs': (token: string) => `btp+wss://:${token}@ilp.kava.io/xrp`
    }
  }

  private readonly xrpSecret: string
  private readonly xrpAddress: string
  private readonly xrpServer =
    process.env.LEDGER_ENV === 'mainnet'
      ? 'wss://s1.ripple.com'
      : 'wss://s.altnet.rippletest.net:51233'

  constructor({ xrpSecret, ...opts }: IXrpOpts) {
    super(opts)

    this.xrpSecret = xrpSecret
    this.xrpAddress = deriveAddress(deriveKeypair(xrpSecret).publicKey)
  }

  protected async createPlugin(serverUri: string) {
    /**
     * TODO ?
     */
    const maxInFlight = await this.maxInFlight
    const maxPrefund = maxInFlight.times(1.1).dp(0, BigNumber.ROUND_CEIL)
    const maxCredit = maxPrefund
      .plus(maxInFlight.times(2))
      .dp(0, BigNumber.ROUND_CEIL)
    const outgoingChannelAmountXRP = convert(
      usd(10),
      xrp(),
      this.rateBackend
    ).toString()

    const plugin: IPlugin = new XrpAsymClient({
      currencyScale: 9,
      secret: this.xrpSecret,
      server: serverUri,
      xrpServer: this.xrpServer,
      outgoingChannelAmountXRP
    })

    // TODO If maxPacketAmount is a big number, the errors returned change, and seem related to the amount sent. Changing it to a string prevents this. Wtf was going on?
    const that = this
    return new PluginWrapper({
      plugin,
      ildcpInfo: {
        clientAddress: '',
        assetCode: 'XRP',
        assetScale: 9
      },
      balance: {
        maximum: maxCredit,
        settleThreshold: maxPrefund,
        settleTo: maxPrefund
      },
      maxPacketAmount: maxInFlight.toString(),
      log: createLogger('ilp-plugin-xrp-asym-client:wrapper')
    })
  }

  protected async destroyPlugin(plugin: IPlugin) {
    await plugin.disconnect()

    const api = new RippleAPI({
      server: this.xrpServer
    })
    await api.connect()

    const submitter = createSubmitter(api, this.xrpAddress, this.xrpSecret)

    // TODO Lookup channels from store so it doesn't close all channels linked to the xrp account
    const channels = await api.connection.request({
      account: this.xrpAddress,
      command: 'account_channels'
    })

    // TODO Add better logging
    for (const { channel_id } of channels) {
      try {
        await submitter.submit('preparePaymentChannelClaim', {
          channel: channel_id,
          close: true
        })
      } catch (err) {
        throw new Error('TODO')
      }
    }
  }
}
