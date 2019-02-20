import { btc, convert, satoshi } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import { Option, tryCatch } from 'fp-ts/lib/Option'
import LightningPlugin, {
  ChannelBalanceRequest,
  connectLnd,
  createInvoiceStream,
  createPaymentStream,
  GetInfoRequest,
  Invoice,
  InvoiceStream,
  LndService,
  PaymentStream,
  SendResponse,
  waitForReady
} from 'ilp-plugin-lightning'
import { BehaviorSubject, from, fromEvent, interval, merge } from 'rxjs'
import { filter, mergeMap, throttleTime } from 'rxjs/operators'
import { URL } from 'url'
import { LedgerEnv, SettlementModule, State } from '..'
import { SettlementEngine, SettlementEngineType } from '../engine'
import { Flavor } from '../types/util'
import {
  BaseUplink,
  BaseUplinkConfig,
  distinctBigNum,
  getNativeMaxInFlight,
  ReadyUplink
} from '../uplink'
import createLogger from '../utils/log'
import { MemoryStore } from '../utils/store'

/*
 * ------------------------------------
 * SETTLEMENT ENGINE
 * ------------------------------------
 */

export type LndSettlementEngine = Flavor<SettlementEngine, 'Lnd'>
const setupEngine = async (
  ledgerEnv: LedgerEnv
): Promise<LndSettlementEngine> => ({
  settlerType: SettlementEngineType.Lnd, // TODO

  assetCode: 'BTC',
  assetScale: 8,
  baseUnit: satoshi,
  exchangeUnit: btc,
  remoteConnectors: {
    local: {
      'Kava Labs': (token: string) => `btp+ws://:${token}@localhost:7441`
    },
    testnet: {
      'Kava Labs': (token: string) => `btp+wss://:${token}@test.ilp.kava.io/btc`
    },
    mainnet: {}
  }[ledgerEnv]
})

/*
 * ------------------------------------
 * CREDENTIAL
 * ------------------------------------
 */

/**
 * Confirm a host is semantically valid (e.g. "localhost:8080")
 * and split into component hostname and port
 */
const splitHost = (host: string): Option<ValidHost> =>
  tryCatch(() => new URL('https://' + host)).map(({ hostname, port }) => ({
    hostname,
    port: parseInt(port, 10)
  }))

export type ValidHost = {
  hostname: string
  port: number
}

// TODO Add method to validate credentials using `setupCredential` then `closeCredential`

export interface ValidatedLndCredential {
  settlerType: SettlementEngineType.Lnd // TODO!

  /** Hostname that exposes peering and gRPC server (on different ports) */
  hostname: string
  /** Port for gRPC connections */
  grpcPort?: number
  /** TLS cert as a Base64-encoded string */
  tlsCert: string
  /** LND macaroon as Base64-encoded string */
  macaroon: string
}

export type LndIdentityPublicKey = Flavor<string, 'LndIdentityPublicKey'>

export interface ReadyLndCredential {
  settlerType: SettlementEngineType.Lnd

  /** gRPC client connected to Lighnting node for performing requests */
  service: LndService
  /** Bidirectional streaming RPC to send outgoing payments and receive attestations */
  paymentStream: PaymentStream
  /** Streaming RPC of newly added or settled invoices */
  invoiceStream: InvoiceStream
  /** Lightning secp256k1 public key */
  identityPublicKey: LndIdentityPublicKey
  /** Streaming updates of balance in channel */
  channelBalance$: BehaviorSubject<BigNumber>
}

const fetchChannelBalance = async (lightning: LndService) => {
  const res = await lightning.channelBalance(new ChannelBalanceRequest())
  return convert(satoshi(res.getBalance()), btc())
}

const uniqueId = (cred: ReadyLndCredential): LndIdentityPublicKey =>
  cred.identityPublicKey

const setupCredential = (opts: ValidatedLndCredential) => async (): Promise<
  ReadyLndCredential
> => {
  // Create and connect the internal LND service (passed to plugins)
  const service = connectLnd(opts)
  await waitForReady(service)

  // Fetch the public key so the user doesn't have to provide it
  // (necessary as a unique identifier for this LND node)
  const response = await service.getInfo(new GetInfoRequest())
  const identityPublicKey = response.getIdentityPubkey()

  const paymentStream = createPaymentStream(service)
  const payments$ = fromEvent<SendResponse>(paymentStream, 'data')
  const invoiceStream = createInvoiceStream(service)
  const invoices$ = fromEvent<Invoice>(invoiceStream, 'data').pipe(
    // Only refresh when invoices are paid/settled
    filter(invoice => invoice.getSettled())
  )

  // Fetch an updated channel balance every 3s, or whenever an invoice is paid (by us or counterparty)
  const channelBalance$ = new BehaviorSubject(new BigNumber(0))
  merge(invoices$, payments$, interval(3000))
    .pipe(
      // Limit balance requests to 10 per second
      throttleTime(100),
      mergeMap(() => from(fetchChannelBalance(service))),
      // Only emit updated values
      distinctBigNum
    )
    .subscribe(channelBalance$)

  return {
    settlerType: SettlementEngineType.Lnd,
    service,
    paymentStream,
    invoiceStream,
    identityPublicKey,
    channelBalance$
  }
}

// TODO Also unsubscribe/end all of the event listeners (confirm there aren't any memory leaks)
export const closeCredential = async ({ service }: ReadyLndCredential) =>
  service.close()

/*
 * ------------------------------------
 * UPLINK
 * ------------------------------------
 */

export interface LndUplinkConfig extends BaseUplinkConfig {
  settlerType: SettlementEngineType.Lnd
  credentialId: LndIdentityPublicKey
}

export interface LndBaseUplink extends BaseUplink {
  settlerType: SettlementEngineType.Lnd
  credentialId: LndIdentityPublicKey
}

export type ReadyLndUplink = LndBaseUplink & ReadyUplink // TODO 'ReadyUplink' doesn't exist!

// TODO Is the base config fine?
const connectUplink = (credential: ReadyLndCredential) => (
  state: State
) => async (config: BaseUplinkConfig): Promise<LndBaseUplink> => {
  const server = config.plugin.btp.serverUri
  const store = config.plugin.store

  // TODO Remove this?
  // TODO Remove balance from lightning plugin?
  const maxInFlight = await getNativeMaxInFlight(
    state,
    SettlementEngineType.Lnd
  )

  const plugin = new LightningPlugin(
    {
      role: 'client',
      server,
      /**
       * Inject the existing LND service, since it may be shared across multiple uplinks
       * Share the same payment/invoice stream across multiple plugins
       */
      lnd: credential.service,
      paymentStream: credential.paymentStream,
      invoiceStream: credential.invoiceStream,
      // TODO Remove balance
      maxPacketAmount: maxInFlight.toString(),
      balance: {
        maximum: maxInFlight.times(2).toString(),
        settleTo: maxInFlight.toString(),
        settleThreshold: maxInFlight.toString() // TODO Hack for now to always attempt to settle (limited by payout amount)
      }
    },
    {
      log: createLogger('ilp-plugin-lightning'),
      store: new MemoryStore(store)
    }
  )

  const outgoingCapacity$ = credential.channelBalance$
  const incomingCapacity$ = new BehaviorSubject(new BigNumber(Infinity))
  const totalReceived$ = new BehaviorSubject(new BigNumber(0))
  const totalSent$ = new BehaviorSubject(new BigNumber(0))

  return {
    settlerType: SettlementEngineType.Lnd,
    credentialId: uniqueId(credential),
    plugin,
    outgoingCapacity$,
    incomingCapacity$,
    totalSent$,
    totalReceived$
  }
}

/**
 * ------------------------------------
 * SETTLEMENT MODULE
 * ------------------------------------
 */

export type LndSettlementModule = SettlementModule<
  SettlementEngineType.Lnd,
  LndSettlementEngine,
  ValidatedLndCredential,
  ReadyLndCredential,
  // LndUplinkConfig,
  LndBaseUplink,
  ReadyLndUplink
>

export const Lnd: LndSettlementModule = {
  // settlerType: SettlementEngineType.Lnd,
  setupEngine,
  setupCredential,
  uniqueId,
  closeCredential,
  connectUplink
}
