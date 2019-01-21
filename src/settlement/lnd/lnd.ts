import {
  NewUplink,
  TotalReceived,
  AvailableToSend,
  AvailableToDebit,
  AvailableToReceive, // TODO !
  UplinkConfig
} from '../../uplink'
import BigNumber from 'bignumber.js'
import { btc, satoshi, convert, RateApi } from '@kava-labs/crypto-rate-utils'
import LightningPlugin, {
  LightningAccount,
  LightningService,
  ChannelBalanceRequest,
  connectLnd,
  waitForReady,
  createPaymentStream,
  createInvoiceStream,
  InvoiceStream,
  PaymentStream
} from 'ilp-plugin-lightning'
import { SettlementEngineType, SettlementEngine } from '..'
import createLogger from '../../utils/log'
import { MemoryStore } from '../../utils/store'
import { Maybe } from 'purify-ts/adts/Maybe'
import { ApiUtils } from 'api'
import { fromStream } from 'rxjs/Rx/Node' // TODO !

/**
 * VALIDATION
 * TODO -- Organize all of this crap!
 */

import { URL } from 'url'
import { publicKeyVerify } from 'secp256k1'

// TODO Brand is stricter than flavor -- that's both good and bad

type Brand<K, T> = K & { __brand: T }

interface Flavoring<FlavorT> {
  _type?: FlavorT
}
export type Flavor<T, FlavorT> = T & Flavoring<FlavorT>

/** Unvalidated LND credentials directly from the user */
interface UnvalidatedLndCredentials {
  /** Lightning secp256k1 public key */
  identityPublicKey: string
  /** Hostname and gRPC port for the Lightning connection */
  host: string
  /** TLS cert as a Base64-encoded string or Buffer (e.g. using `fs.readFile`) */
  tlsCert: string | Buffer
  /** LND macaroon as Base64-encoded string or Buffer (e.g. using `fs.readFile`) */
  macaroon: string | Buffer
}

/** Valid LND credentials that successfully authenticated with the remote node */
type ValidatedLndCredentials = Brand<ParsedLndCredentials, 'authenticated'>

/** Verify an secp256k1 public key exists, such as Lightning identity public key */
const verifyIdentityPublicKey = (publicKey: string): Maybe<string> =>
  Just(publicKey).filter(pk => publicKeyVerify(Buffer.from(pk)))

export type ValidHost = {
  hostname: string
  port: number
}

/** Confirm a host is semantically valid (e.g. "localhost:8080") */
const validateHost = (host: string): Maybe<ValidHost> =>
  Maybe.encase(() => new URL('https://' + host)).map(({ hostname, port }) => ({
    hostname,
    port: parseInt(port, 10)
  }))

// TODO UnvalidatedLndCredentials => ValidLndCredentials
const convertAndValidate = ({
  lndHost,
  identityPublicKey,
  tlsCert,
  macaroon
}: UnvalidatedLndCredentials): Maybe<ValidLndCredentials> => {
  const host = validateHost(lndHost)
  if (host.isNothing()) {
    return Nothing
  }

  const publicKey = verifyIdentityPublicKey(identityPublicKey)
  if (publicKey.isNothing()) {
    return Nothing
  }

  // TODO This is not correct!
  const a = Just({
    ...host.extract(),
    identityPublicKey: publicKey.extract(),
    tlsCert: tlsCert.toString('base64'),
    macaroon: macaroon.toString('base64')
  })

  return validateLndCredentials(a)
}

export const validateLndCredentials = (
  lndCreds: ParsedLndCredentials
): Promise<Maybe<ValidatedLndCredentials>> =>
  createLndConnection(lndCreds)
    .then(service => service.close())
    .then(() => Just(lndCreds as ValidatedLndCredentials))
    .catch(() => Nothing)

/**
 * ------------------------------------
 * SETTLEMENT ENGINE
 * ------------------------------------
 */

// TODO Or maybe there's just a generic settlement engine interface?
interface LndSettlementEngine extends SettlementEngine {}

export const setupEngine = (): LndSettlementEngine => ({
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
  }
})

// TODO These can likely be generic and then passed into the "createUplink" method

/** Convert the global max-in-flight amount to the local/native/base units of the plugin */
const getNativeMaxInFlight = ({
  maxInFlightUsd,
  rateBackend
}: ApiUtils): BigNumber => convert(maxInFlightUsd, satoshi(), rateBackend)

const getPluginBalanceConfig = (maxInFlight: BigNumber) => {
  const maxPrefund = maxInFlight.times(1.1).dp(0, BigNumber.ROUND_CEIL)
  const maxCredit = maxPrefund
    .plus(maxInFlight.times(2))
    .dp(0, BigNumber.ROUND_CEIL)

  return {
    maximum: maxCredit,
    settleTo: maxPrefund,
    settleThreshold: maxPrefund
  }
}

const getPluginMaxPacketAmount = (maxInFlight: BigNumber) =>
  maxInFlight.times(2).toString()

/**
 * ------------------------------------
 * CREDENTIAL
 * ------------------------------------
 */

// TODO Add back all credential validation code from btc.ts file!

/** LND credentials in internal format to attempt a connection */
interface ParsedLndCredential {
  /** Lightning secp256k1 public key */
  identityPublicKey: string
  /** Hostname that exposes peering and gRPC server (on different ports) */
  hostname: string
  /** Port for gRPC connections */
  grpcPort: number
  /** TLS cert as a Base64-encoded string */
  tlsCert: string
  /** LND macaroon as Base64-encoded string */
  macaroon: string
}

// TODO Should there be two separate hierachies for the instance, and
// the config that was used to create it?
export interface ReadyLndCredential extends ParsedLndCredential {
  settlerType: SettlementEngineType.Lnd

  service: LightningService
  invoiceStream: InvoiceStream
  paymentStream: PaymentStream
  cachedChannelBalance: BigNumber
}

const throttle = (run: Function, wait: number) => {
  let timeout: NodeJS.Timeout | null = null

  return () => {
    timeout =
      timeout ||
      setTimeout(() => {
        timeout = null
        run()
      }, wait)
  }
}

const fetchChannelBalance = async (lightning: LightningService) => {
  const res = await lightning.channelBalance(new ChannelBalanceRequest())
  return convert(satoshi(res.getBalance()), btc())
}

export const setupCredential = async (
  opts: ParsedLndCredential
): Promise<ReadyLndCredential> => {
  // Create and connect the internal LND service (passed to plugins)
  const service = connectLnd(opts)
  await waitForReady(service)

  // TODO Refactor to remove ugly mutation -- just use Observable.fromStream or something instead!
  let cachedChannelBalance = new BigNumber(0)
  const updateChannelBalance = throttle(async () => {
    cachedChannelBalance = await fetchChannelBalance(service)
  }, 100) /** Limit refreshes to 10 per second */

  // Fetch an updated channel balance whenever an invoice
  // is paid or we pay an invoice
  const paymentStream = createPaymentStream(service)
  paymentStream.on('data', updateChannelBalance)
  const invoiceStream = createInvoiceStream(service)
  invoiceStream.on('data', updateChannelBalance)

  return {
    ...opts,
    service,
    invoiceStream,
    paymentStream,
    cachedChannelBalance
  }
}

export const uniqueId = (cred: ParsedLndCredential) => cred.identityPublicKey

export const closeCredential = async (cred: ReadyLndCredential) =>
  cred.service.close()

/**
 * === === === === === === === === === === === ===
 * UPLINK
 * === === === === === === === === === === === ===
 */

// TODO How should the generic version be named compared to the non- & version?
export interface LndUplinkConfig {
  settlerType: SettlementEngineType.Lnd
  credential: ParsedLndCredential // TODO e.g. Rename to "ValidLndConfigCredential"
}

// TODO Add comments for these things!
export interface OnlyLnd {
  /** Plugin specific to this uplink and type of uplink */
  plugin: LightningPlugin
  // credential: ReadyLndCredential // TODO Should this really be a reference?
  // ^ Or should credential reference the settlement engine itself?
  settlerType: SettlementEngineType.Lnd
  // credentialId: string
  // settler: LndSettlementEngine
}

// TODO Maybe this makes more sense?
// And then the "create/connect" would only build the Lnd-specific part
export type LndUplink = OnlyLnd & NewUplink

export const connectUplink = (utils: ApiUtils) => (
  settler: LndSettlementEngine
) => (credential: ReadyLndCredential) => (
  config: UplinkConfig & LndUplinkConfig
): OnlyLnd => {
  const server = config.plugin.btp.serverUri
  const store = config.plugin.store

  const { hostname: lndHost, identityPublicKey: lndIdentityPubkey } = credential

  const maxInFlight = getNativeMaxInFlight(utils)

  const plugin = new LightningPlugin(
    {
      role: 'client',
      server,
      lndIdentityPubkey,
      lndHost,
      /** Inject the existing LND service, since it may be shared across multiple uplinks */
      lnd: credential.service,
      maxPacketAmount: getPluginMaxPacketAmount(maxInFlight),
      balance: getPluginBalanceConfig(maxInFlight)
    },
    {
      log: createLogger('ilp-plugin-lightning'),
      store: new MemoryStore(store)
    }
  )

  return {
    settlerType: SettlementEngineType.Lnd,
    plugin
  }
}

/**
 * Generic utils for lightning
 */

const getAccount = (uplink: LndUplink): Maybe<LightningAccount> =>
  Maybe.fromNullable(uplink.plugin._accounts.get('server'))

/**
 * Balance-related getters
 */

// TODO Should this just have a generic "GetBalance<UplinkType> => BigNumber" type?

export const availableToSend: AvailableToSend<LndUplink> = uplink =>
  uplink.cachedChannelBalance // TODO Fix!

export const availableToReceive: AvailableToReceive<LndUplink> = () =>
  new BigNumber(Infinity)

export const totalReceived: TotalReceived<LndUplink> = () => new BigNumber(0)

export const availableToDebit: AvailableToDebit<LndUplink> = uplink =>
  getAccount(uplink)
    .map(({ account }) => convert(satoshi(account.balance), btc()))
    .orDefault(new BigNumber(0))

// TODO Export all members at the end so it's clear what's exported and what isn't
