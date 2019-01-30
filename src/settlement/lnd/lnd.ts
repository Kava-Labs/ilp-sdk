import { btc, convert, satoshi } from '@kava-labs/crypto-rate-utils'
import { State, LedgerEnv, getSettler } from '../../api'
import BigNumber from 'bignumber.js'
import { fromNullable, Option, tryCatch } from 'fp-ts/lib/Option'
import LightningPlugin, {
  ChannelBalanceRequest,
  connectLnd,
  createInvoiceStream,
  createPaymentStream,
  GetInfoRequest,
  LndService,
  waitForReady,
  Invoice,
  SendResponse,
  PaymentStream,
  InvoiceStream
} from 'ilp-plugin-lightning'
import { BehaviorSubject, merge, from, interval, fromEvent } from 'rxjs'
import { map, mergeMap, throttleTime, filter, sample } from 'rxjs/operators'
import { URL } from 'url'
import { SettlementEngine, SettlementEngineType } from '..'
import {
  getNativeMaxInFlight,
  getPluginBalanceConfig,
  getPluginMaxPacketAmount,
  distinctBigNum,
  BaseUplink,
  ReadyUplink,
  BaseUplinkConfig
} from '../../uplink'
import createLogger from '../../utils/log'
import { MemoryStore } from '../../utils/store'
import { Flavor } from '../../types/util'

/*
 * ------------------------------------
 * SETTLEMENT ENGINE
 * ------------------------------------
 */

export type LndSettlementEngine = Flavor<SettlementEngine, 'Lnd'>
export const setupEngine = (ledgerEnv: LedgerEnv): LndSettlementEngine => ({
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
    mainnet: {
      'Kava Labs': (token: string) => `btp+wss://:${token}@ilp.kava.io/btc`
    }
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
  /** Hostname that exposes peering and gRPC server (on different ports) */
  hostname: string
  /** Port for gRPC connections */
  grpcPort: number
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

// TODO Is this used outside of "getCredential" ?
const uniqueId = (cred: ReadyLndCredential) => cred.identityPublicKey

const getCredential = (
  state: State,
  credentialId: LndIdentityPublicKey
): Option<ReadyLndCredential> =>
  fromNullable(
    state.credentials.filter(
      (cred): cred is ReadyLndCredential =>
        cred.settlerType === SettlementEngineType.Lnd &&
        uniqueId(cred) === credentialId
    )[0]
  )

export const setupCredential = async (
  opts: ValidatedLndCredential
): Promise<ReadyLndCredential> => {
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
      distinctBigNum()
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

// TODO Also unsubscribe/end all of the event listeners (make sure no memory leaks)
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

export type ReadyLndUplink = LndBaseUplink & ReadyUplink

export const connectUplink = (state: State) => (
  credential: ReadyLndCredential
) => async (config: LndUplinkConfig): Promise<LndBaseUplink> => {
  const server = config.plugin.btp.serverUri
  const store = config.plugin.store

  const settler = getSettler(state)(SettlementEngineType.Lnd)

  const maxInFlight = getNativeMaxInFlight(state, SettlementEngineType.Lnd)
  const maxPacketAmount = getPluginMaxPacketAmount(maxInFlight)
  const balance = getPluginBalanceConfig(maxInFlight)

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
      maxPacketAmount,
      balance
    },
    {
      log: createLogger('ilp-plugin-lightning'),
      store: new MemoryStore(store)
    }
  )

  const account = await plugin.loadAccount('peer')

  const outgoingCapacity$ = credential.channelBalance$
  const incomingCapacity$ = new BehaviorSubject(new BigNumber(Infinity))
  const totalReceived$ = new BehaviorSubject(new BigNumber(0))
  const totalSent$ = new BehaviorSubject(new BigNumber(0))

  const availableToDebit$ = new BehaviorSubject(new BigNumber(0))
  account.payoutAmount$
    .pipe(
      // Only emit updated values
      distinctBigNum(),
      map(amount => amount.negated()),
      map(amount => convert(satoshi(amount), btc()))
    )
    // TODO Simpler way to do this? Try .subscribe(availableToDebit$) again?
    .subscribe({
      next: val => {
        availableToDebit$.next(val)
      },
      complete: () => {
        availableToDebit$.complete()
      },
      error: err => {
        availableToDebit$.error(err)
      }
    })

  const idleAvailableToDebit = convert(
    settler.baseUnit(balance.settleTo),
    settler.exchangeUnit()
  )

  const availableToCredit$ = new BehaviorSubject(new BigNumber(0))
  account.balance$
    .pipe(
      // Only emit updated values
      distinctBigNum(),
      map(amount => balance.maximum.minus(amount)),
      map(amount => convert(satoshi(amount), btc()))
    )
    .subscribe(availableToCredit$)

  const idleAvailableToCredit = convert(
    settler.baseUnit(balance.maximum.minus(balance.settleTo)),
    settler.exchangeUnit()
  )

  return {
    settlerType: SettlementEngineType.Lnd,
    credentialId: uniqueId(credential),
    plugin,
    outgoingCapacity$,
    incomingCapacity$,
    availableToDebit$,
    idleAvailableToDebit,
    availableToCredit$,
    idleAvailableToCredit,
    totalSent$,
    totalReceived$
  }
}
