import LightningPlugin = require('ilp-plugin-lightning')
import { Ledger } from '../ledger'
import { convert, IUnit } from '../utils/convert'
import { IPlugin } from '../utils/types'

export interface IBtcOpts {
  readonly lndPubKey: string
  readonly lndHost: string
  readonly tlsCert: string
  readonly macaroon: string
}

export class Btc extends Ledger {
  public readonly assetCode = 'BTC'
  public readonly assetScale = 8
  public readonly remoteConnectors = {
    testnet: {
      'Kava Labs': 'test.ilp.kava.io/btc'
    },
    mainnet: {
      'Kava Labs': 'ilp.kava.io/btc'
    }
  }
  public readonly maxInFlight = convert(0.00001, IUnit.Btc, IUnit.Satoshi)

  private readonly lndPubKey: string
  private readonly lndHost: string
  private readonly tlsCert: string
  private readonly macaroon: string

  constructor({ lndPubKey, lndHost, tlsCert, macaroon }: IBtcOpts) {
    super()

    this.lndPubKey = lndPubKey
    this.lndHost = lndHost
    this.tlsCert = tlsCert
    this.macaroon = macaroon
  }

  protected createPlugin(serverUri: string) {
    return new LightningPlugin({
      role: 'client',
      maxPacketAmount: this.maxInFlight,
      lndIdentityPubkey: this.lndPubKey,
      lndHost: this.lndHost,
      lnd: {
        lndHost: this.lndHost,
        tlsCertInput: this.tlsCert,
        macaroonInput: this.macaroon
      },
      // @ts-ignore
      server: serverUri,
      balance: {
        // If we're a sender, only settle up to a certain amount
        maximum: this.maxInFlight.times(4),
        settleTo: this.maxInFlight.times(2),
        settleThreshold: this.maxInFlight.times(2)
      }
    })
  }

  protected async destroyPlugin(plugin: IPlugin) {
    return plugin.disconnect()
  }
}
