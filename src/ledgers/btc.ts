import { btc, satoshi } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import createLogger from 'ilp-logger'
import LightningPlugin from 'ilp-plugin-lightning'
import { ILedgerOpts, Ledger } from '../ledger'
import { PluginWrapper } from '../utils/middlewares'
import { IPlugin } from '../utils/types'

export interface IBtcOpts extends ILedgerOpts {
  readonly lndPubKey: string
  readonly lndHost: string
  readonly tlsCert: string
  readonly macaroon: string
}

// TODO Use this!
// // Limit the precision based on the scale of the base unit
// .decimalPlaces(dest.unit - dest.pluginBase, BigNumber.ROUND_DOWN)

export class Btc extends Ledger {
  public static readonly assetCode = 'BTC'
  public readonly baseUnit = satoshi
  public readonly exchangeUnit = btc
  public readonly remoteConnectors = {
    local: {
      'Kava Labs': (token: string) => `btp+ws://:${token}@localhost:7441`
    },
    testnet: {
      'Kava Labs': (token: string) => `btp+wss://:${token}@test.ilp.kava.io/btc`
    },
    mainnet: {
      'Kava Labs': (token: string) => `btp+wss://:${token}@ilp.kava.io/btc`
    }
  }

  private readonly lndPubKey: string
  private readonly lndHost: string
  private readonly tlsCert: string
  private readonly macaroon: string

  constructor({ lndPubKey, lndHost, tlsCert, macaroon, ...opts }: IBtcOpts) {
    super(opts)

    this.lndPubKey = lndPubKey
    this.lndHost = lndHost
    this.tlsCert = tlsCert
    this.macaroon = macaroon
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

    const plugin = new LightningPlugin({
      role: 'client',
      maxPacketAmount: maxInFlight,
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
        maximum: maxCredit,
        settleTo: maxPrefund,
        settleThreshold: maxPrefund
      }
    })

    return new PluginWrapper({
      plugin,
      ildcpInfo: {
        clientAddress: '',
        assetCode: 'BTC',
        assetScale: 8
      },
      log: createLogger('ilp-plugin-lightning:max-packet'),
      maxPacketAmount: maxInFlight.toString()
    })
  }

  protected async destroyPlugin(plugin: IPlugin) {
    return plugin.disconnect()
  }
}
