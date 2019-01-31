import BtpPlugin, {
  IlpPluginBtpConstructorOptions,
  IlpPluginBtpConstructorModules
} from 'ilp-plugin-btp'
import { FormattedPaymentChannel } from 'ripple-lib/dist/npm/ledger/parse/payment-channel'
import { PluginStore } from 'utils/store'

declare module 'ilp-plugin-xrp-asym-client' {
  export interface PaymentChannel extends FormattedPaymentChannel {
    /** Total amount of XRP funded in this channel */
    amount: string
    /** Total amount of XRP delivered by this channel (per docs) */
    balance: string
  }

  export interface PaymentChannelClaim {
    /** Value of the claim, in plugin base units */
    amount: string
    /** Valid signature to enforce the claim on-ledger */
    signature: string
  }

  export interface XrpAsymClientOpts extends IlpPluginBtpConstructorOptions {
    /** XRP secret */
    secret: string
    /** Orders of magnitude between base unit of plugin and XRP */
    currencyScale?: number
    /** WebSocket URI of the Rippled server to connect to */
    xrpServer?: string
    /**
     * Amount to fund new outgoing channels, in units of XRP,
     * and the default for depositing to channels
     */
    outgoingChannelAmountXRP?: string
    /** Should channels automatically be created and topped up? */
    autoFundChannels?: boolean
  }

  export interface XrpAsymClientServices
    extends IlpPluginBtpConstructorModules {
    /** Key-value store for persisting the incoming claim */
    store: PluginStore
  }

  export default class XrpAsymClient extends BtpPlugin {
    constructor(opts: XrpAsymClientOpts, services: XrpAsymClientServices)

    /**
     * Perform handshake to exchange existing channel and claim details,
     * or request an incoming channel and open an outgoing channel
     */
    _connect(): Promise<void>

    /**
     * Deposit to an existing outgoing channel
     * for the given amount in units of XRP
     */
    _fundOutgoingChannel(amount: string): Promise<void>

    /* Outgoing channel */

    /** Outgoing payment channel claim signature */
    _lastClaim?: PaymentChannelClaim
    /** Outgoing channel id (256 bit hex) */
    _channel?: string
    /** Cached details from the outgoing payment channel */
    _channelDetails?: PaymentChannel

    /* Incoming channel */

    /** Incoming payment channel claim signature */
    _bestClaim?: PaymentChannelClaim
    /** Incoming channel id (256 bit hex) */
    _clientChannel?: string
    /** Cached details from the incoming payment channel */
    _paychan?: PaymentChannel
  }
}
