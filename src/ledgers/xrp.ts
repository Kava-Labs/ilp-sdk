import createLogger from 'ilp-logger'
import XrpAsymClient from 'ilp-plugin-xrp-asym-client'
import { createSubmitter } from 'ilp-plugin-xrp-paychan-shared'
import { deriveAddress, deriveKeypair } from 'ripple-keypairs'
import { RippleAPI } from 'ripple-lib'
import { Ledger } from '../ledger'
import { convert, IUnit } from '../utils/convert'
import { PluginWrapper } from '../utils/middlewares'
import { IPlugin } from '../utils/types'

interface IXrpOpts {
  readonly xrpSecret: string
}

export class Xrp extends Ledger {
  public readonly assetCode = 'XRP'
  public readonly assetScale = 9
  public readonly remoteConnectors = {
    test: {
      'Kava Labs': 'test.ilp.kava.io/xrp'
    },
    live: {
      'Kava Labs': 'ilp.kava.io/xrp'
    }
  }

  // TODO Do fx from USD so this remains stable, cuz XRP volatility
  protected readonly maxInFlight = convert('0.2', IUnit.Xrp, IUnit.XrpBase)

  private readonly xrpSecret: string

  constructor({ xrpSecret }: IXrpOpts) {
    super()

    this.xrpSecret = xrpSecret
  }

  private get xrpServer() {
    return process.env.LEDGER_ENV === 'mainnet'
      ? 'wss://s1.ripple.com'
      : 'wss://s.altnet.rippletest.net:51233'
  }

  private get xrpAddress() {
    return deriveAddress(deriveKeypair(this.xrpSecret).publicKey)
  }

  protected async createPlugin(serverUri: string) {
    const plugin: IPlugin = new XrpAsymClient({
      currencyScale: 9,
      secret: this.xrpSecret,
      server: serverUri,
      xrpServer: this.xrpServer
    })

    return new PluginWrapper({
      plugin,
      assetCode: 'XRP',
      assetScale: 9,
      balance: {
        maximum: this.maxInFlight.times(4),
        settleThreshold: this.maxInFlight.times(2),
        settleTo: this.maxInFlight.times(2)
      },
      log: createLogger('ilp-plugin-xrp-asym-client:balance')
    })
  }

  protected async destroyPlugin(plugin: IPlugin) {
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

    return plugin.disconnect()
  }
}
