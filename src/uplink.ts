import { convert } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import createLogger from 'ilp-logger'
import {
  deserializeIlpPrepare,
  deserializeIlpReply,
  IlpPrepare,
  IlpReply,
  serializeIlpPrepare,
  serializeIlpReply
} from 'ilp-packet'
import { fetch as fetchAssetDetails } from 'ilp-protocol-ildcp'
import { Server as StreamServer } from 'ilp-protocol-stream'
import { BehaviorSubject, combineLatest } from 'rxjs'
import { distinctUntilChanged, map } from 'rxjs/operators'
import { State } from '.'
import { startStreamServer, stopStreamServer } from './services/stream-server'
import { SettlementEngine, SettlementEngineType } from './engine'
import { LndBaseUplink, LndUplinkConfig, Lnd } from './settlement/lnd'
import {
  XrpPaychanBaseUplink,
  XrpPaychanUplinkConfig,
  XrpPaychan
} from './settlement/xrp-paychan'
import { DataHandler, IlpPrepareHandler, Plugin } from './types/plugin'
import { defaultDataHandler, defaultIlpPrepareHandler } from './utils/packet'
import { SimpleStore, MemoryStore } from './utils/store'
import { PluginWrapper } from './utils/middlewares'
import { ReadyCredentials, getCredentialId } from './credential'
import { generateSecret, generateToken } from './utils/crypto'
import { Machinomy, MachinomyBaseUplink } from './settlement/machinomy'

const log = createLogger('switch-api:uplink')

export interface BaseUplinkConfig {
  settlerType: SettlementEngineType
  stream: {
    /** Enables deterministic generation of previous shared secrets so we can accept payments */
    serverSecret: Buffer
  }
  plugin: {
    btp: {
      serverUri: string
      authToken: string
    }
    store: SimpleStore
  }
}

export type UplinkConfig = (LndUplinkConfig | XrpPaychanUplinkConfig) &
  BaseUplinkConfig

export interface BaseUplink {
  readonly plugin: Plugin
  readonly settlerType: SettlementEngineType
  readonly credentialId: string
  /**
   * Amount of our *money* in layer 2 we have custody over,
   * immediately available for us to send to our peer
   */
  readonly outgoingCapacity$: BehaviorSubject<BigNumber>
  /**
   * Amount of *money* our peer has custody over in layer 2,
   * immediately available for our peer to send to us
   */
  readonly incomingCapacity$: BehaviorSubject<BigNumber>
  /**
   * Amount of *money* we've received in layer 2 that is *unavailble* to send
   * (money that we cannot directly send back to our peer)
   */
  readonly totalReceived$: BehaviorSubject<BigNumber>
  /**
   * Amount of *money* we've sent in layer 2 that is *unavailable* to receive
   * (money that our peer cannot directly send back to us)
   */
  readonly totalSent$: BehaviorSubject<BigNumber>
}

export type BaseUplinks =
  | LndBaseUplink
  | MachinomyBaseUplink
  | XrpPaychanBaseUplink

export interface ReadyUplink {
  /** Wrapper plugin with balance logic to and perform accounting and limit the packets we fulfill */
  readonly pluginWrapper: PluginWrapper
  /** Handle incoming packets from the endpoint sending money or trading */
  streamClientHandler: IlpPrepareHandler
  /** Handle incoming packets from the endpoint receiving money from other parties */
  streamServerHandler: DataHandler
  /** ILP address assigned from upstream connector */
  readonly clientAddress: string
  /** Max amount to be sent unsecured at a given time */
  readonly maxInFlight: BigNumber
  /** Total amount in layer 2 that can be claimed on layer 1 */
  readonly balance$: BehaviorSubject<BigNumber>
  /** Total amount that we can send immediately over Interledger */
  readonly availableToSend$: BehaviorSubject<BigNumber>
  /** Total amount that we could receive immediately over Interledger */
  readonly availableToReceive$: BehaviorSubject<BigNumber>
  /** STREAM server to accept incoming payments from any Interledger user */
  readonly streamServer: StreamServer
}

export type ReadyUplinks = ReadyUplink & BaseUplinks

/**
 * ------------------------------------
 * GETTING UPLINKS
 * ------------------------------------
 */

// TODO This also MUST check what connector it's connected to! (fix that)
export const isThatUplink = (uplink: ReadyUplinks) => (
  someUplink: ReadyUplinks
) =>
  someUplink.credentialId === uplink.credentialId &&
  someUplink.settlerType === uplink.settlerType

/**
 * ------------------------------------
 * ADDING & CONNECTING UPLINKS
 * ------------------------------------
 */

export const createUplink = (state: State) => async (
  readyCredential: ReadyCredentials
): Promise<ReadyUplinks> => {
  const authToken = await generateToken()
  const settler = state.settlers[readyCredential.settlerType]
  const createServerUri = settler.remoteConnectors['Kava Labs']
  const serverUri = createServerUri(authToken)
  // const serverUriNoToken = createServerUri('') // TODO !

  const credentialId = getCredentialId(readyCredential)
  const alreadyExists = state.uplinks.some(
    someUplink =>
      someUplink.credentialId === credentialId &&
      someUplink.settlerType === readyCredential.settlerType &&
      false // TODO This MUST comapre the connector it's connected to!
  )
  if (alreadyExists) {
    throw new Error('Cannot create duplicate uplink')
  }

  const config: BaseUplinkConfig = {
    settlerType: readyCredential.settlerType,
    stream: {
      serverSecret: await generateSecret()
    },
    plugin: {
      btp: {
        serverUri,
        authToken
      },
      store: {}
    }
  }

  return connectUplink(state)(readyCredential)(config)
}

export const connectBaseUplink = (
  credential: ReadyCredentials
): ((state: State) => (config: BaseUplinkConfig) => Promise<BaseUplinks>) => {
  switch (credential.settlerType) {
    case SettlementEngineType.Lnd:
      return Lnd.connectUplink(credential)
    case SettlementEngineType.Machinomy:
      return Machinomy.connectUplink(credential)
    case SettlementEngineType.XrpPaychan:
      return XrpPaychan.connectUplink(credential)
  }
}

export const connectUplink = (state: State) => (
  credential: ReadyCredentials
) => async (config: BaseUplinkConfig): Promise<ReadyUplinks> => {
  const uplink = await connectBaseUplink(credential)(state)(config)
  const settler = state.settlers[config.settlerType]
  const {
    plugin,
    outgoingCapacity$,
    incomingCapacity$,
    totalReceived$
  } = uplink

  const maxInFlight = await getNativeMaxInFlight(state, config.settlerType)
  const pluginWrapper = new PluginWrapper({
    plugin,
    maxBalance: maxInFlight,
    maxPacketAmount: maxInFlight,
    assetCode: settler.assetCode,
    assetScale: settler.assetScale,
    log: createLogger(`switch-api:${settler.assetCode}:balance`),
    store: new MemoryStore(config.plugin.store, 'wrapper')
  })

  await plugin.connect()
  const clientAddress = await verifyUpstreamAssetDetails(settler)(plugin)

  const balance$ = new BehaviorSubject(new BigNumber(0))
  combineLatest(outgoingCapacity$, totalReceived$)
    .pipe(sumAll)
    .subscribe(
      amount => {
        balance$.next(amount)
      },
      err => {
        balance$.error(err)
      },
      () => {
        balance$.complete()
      }
    )

  // TODO Add back "availableToCredit" and "availableToDebit"
  //      Use them to halve bilateral trust so we wait for a settlement on receiving side before next packet

  // TODO Also, credit extended should NOT be included in incoming capacity since
  //      the peer needs the capacity to send us the settlement for that -- it should be subtracted!

  const availableToReceive$ = new BehaviorSubject(new BigNumber(0))
  incomingCapacity$.subscribe(availableToReceive$)

  const availableToSend$ = new BehaviorSubject(new BigNumber(0))
  outgoingCapacity$.subscribe(availableToSend$)

  const handlers: {
    streamServerHandler: DataHandler
    streamClientHandler: IlpPrepareHandler
  } = {
    streamServerHandler: defaultDataHandler,
    streamClientHandler: defaultIlpPrepareHandler
  }

  // Setup internal packet handlers and routing
  setupHandlers(
    pluginWrapper,
    clientAddress,
    (data: Buffer) => handlers.streamServerHandler(data),
    (prepare: IlpPrepare) => handlers.streamClientHandler(prepare)
  )

  // Accept incoming payments
  const registerServerHandler = (handler: DataHandler) => {
    handlers.streamServerHandler = handler
  }
  const streamServer = await startStreamServer(
    plugin,
    registerServerHandler,
    config.stream.serverSecret
  )

  return Object.assign(handlers, {
    ...uplink,
    clientAddress,
    streamServer,
    maxInFlight,
    pluginWrapper,
    balance$,
    availableToSend$,
    availableToReceive$
  })
}

/**
 * Register handlers for incoming packets, routing incoming payments to the STREAM
 * server, and all other packets to the internal switch/trading service.
 *
 * @param plugin ILP plugin to send and receive packets
 * @param clientAddress Resolved address of the root plugin, to differentiate connection tags
 * @param streamServerHandler Handler registered by the STREAM server for anonymous payments
 * @param streamClientHandler Handler for packets sent uplink -> uplink within the api itself
 *
 * EFFECT: registers handlers on the plugin
 */
export const setupHandlers = (
  plugin: Plugin,
  clientAddress: string,
  streamServerHandler: DataHandler,
  streamClientHandler: IlpPrepareHandler
) => {
  plugin.deregisterDataHandler()
  plugin.registerDataHandler(async (data: Buffer) => {
    // Apparently plugin-btp will pass data as undefined...
    if (!data) throw new Error('no ilp packet included')

    const prepare = deserializeIlpPrepare(data)
    const hasConnectionTag = prepare.destination
      .replace(clientAddress, '')
      .split('.')
      .some(a => !!a)
    return hasConnectionTag
      ? // Connection ID exists in the ILP address, so route to Stream server (e.g. g.kava.39hadn9ma.~n32j7ba)
        streamServerHandler(data)
      : // ILP address is for the root plugin, so route packet to sending connection (e.g. g.kava.39hadn9ma)
        serializeIlpReply(await streamClientHandler(prepare))
  })
}

/** Confirm the upstream peer shares the same asset details and fetch our ILP address */
const verifyUpstreamAssetDetails = (settler: SettlementEngine) => async (
  plugin: Plugin
): Promise<string> => {
  // Confirm our peer is compatible with the configuration of this uplink
  const { assetCode, assetScale, clientAddress } = await fetchAssetDetails(
    data => plugin.sendData(data)
  )

  const incompatiblePeer =
    assetCode !== settler.assetCode || assetScale !== settler.assetScale
  if (incompatiblePeer) {
    await plugin.disconnect()
    throw new Error(
      'Upstream connector is using a different asset or configuration'
    )
  }

  return clientAddress
}

/*
 * ------------------------------------
 * SWITCHING ASSETS
 * (settlements + sending + clearing)
 * ------------------------------------
 */

/**
 * Serialize and send an ILP PREPARE to the upstream connector,
 * and prefund the value of the packet (assumes peer credit limit is 0)
 */
export const sendPacket = async (
  uplink: ReadyUplinks,
  prepare: IlpPrepare
): Promise<IlpReply> => {
  const additionalPrefundRequired = uplink.pluginWrapper.payableBalance$.value.plus(
    prepare.amount
  )

  // If we've already prefunded enough and the amount is 0 or negative, sendMoney on wrapper will simply return
  uplink.pluginWrapper
    .sendMoney(additionalPrefundRequired.toString())
    .catch(err => log.error(`Error during outgoing settlement: `, err))
  return deserializeIlpReply(
    await uplink.pluginWrapper.sendData(serializeIlpPrepare(prepare))
  )
}

/**
 * Registers a handler for incoming packets not addressed to a
 * specific Stream connection, such as packets sent from another uplink
 *
 * EFFECT: changes data handler on internal plugin
 */
export const registerPacketHandler = (handler: IlpPrepareHandler) => (
  uplink: ReadyUplinks
) => {
  uplink.streamClientHandler = handler
}

export const deregisterPacketHandler = registerPacketHandler(
  defaultIlpPrepareHandler
)

/** Convert the global max-in-flight amount to the local/native units (base units in plugin) */
export const getNativeMaxInFlight = async (
  state: State,
  settlerType: SettlementEngineType
): Promise<BigNumber> => {
  const { maxInFlightUsd, rateBackend } = state
  const { baseUnit } = state.settlers[settlerType]
  return convert(maxInFlightUsd, baseUnit(), rateBackend).dp(
    0,
    BigNumber.ROUND_DOWN
  )
}

/**
 * ------------------------------------
 * DEPOSITS & WITHDRAWALS
 * ------------------------------------
 */

export type AuthorizeDeposit = (params: {
  /** Total amount that will move from layer 1 to layer 2, in units of exchange */
  value: BigNumber
  /** Amount burned/lost as fee as a result of the transaction, in units of exchange */
  fee: BigNumber
}) => Promise<void>

export type AuthorizeWithdrawal = (params: {
  /** Total amount that will move from layer 2 to layer 1, in units of exchange */
  value: BigNumber
  /** Amount burned/lost as fee as a result of the transaction, in units of exchange */
  fee: BigNumber
}) => Promise<void>

export const depositToUplink = (uplink: ReadyUplinks) => {
  switch (uplink.settlerType) {
    case SettlementEngineType.Lnd:
      return
    case SettlementEngineType.Machinomy:
      return Machinomy.deposit(uplink)
    case SettlementEngineType.XrpPaychan:
      return XrpPaychan.deposit(uplink)
  }
}

export const withdrawFromUplink = (uplink: ReadyUplinks) => {
  switch (uplink.settlerType) {
    case SettlementEngineType.Lnd:
      return
    case SettlementEngineType.Machinomy:
      return Machinomy.withdraw(uplink)
    case SettlementEngineType.XrpPaychan:
      return XrpPaychan.withdraw(uplink)
  }
}

/**
 * ------------------------------------
 * REMOVE UPLINK
 * ------------------------------------
 */

/**
 * Gracefully end the session so the uplink can no longer send/receive
 */
export const closeUplink = async (uplink: ReadyUplinks) => {
  await stopStreamServer(uplink.streamServer).catch(err =>
    log.error('Error stopping Stream server: ', err)
  )
  return uplink.plugin.disconnect()
}

/**
 * ------------------------------------
 * RXJS UTILS
 * ------------------------------------
 */

export const sumAll = map((values: BigNumber[]) =>
  values.reduce((a, b) => a.plus(b))
)

export const distinctBigNum = distinctUntilChanged(
  (prev: BigNumber, curr: BigNumber) => prev.eq(curr)
)
