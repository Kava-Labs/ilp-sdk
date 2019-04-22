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
import { ReadyCredentials, getCredential, getCredentialId } from './credential'
import { SettlementEngine, SettlementEngineType } from './engine'
import { startStreamServer, stopStreamServer } from './services/stream-server'
import { DataHandler, IlpPrepareHandler, Plugin } from './types/plugin'
import { Lnd, LndBaseUplink } from './settlement/lnd'
import { XrpPaychan, XrpPaychanBaseUplink } from './settlement/xrp-paychan'
import { Machinomy, MachinomyBaseUplink } from './settlement/machinomy'
import { defaultDataHandler, defaultIlpPrepareHandler } from './utils/packet'
import { SimpleStore, MemoryStore } from './utils/store'
import { PluginWrapper } from './utils/middlewares'
import { generateSecret, generateToken } from './utils/crypto'

const log = createLogger('ilp-sdk:uplink')

/** TODO The config to export should be *re-generated* each time by an uplink */

export interface BaseUplinkConfig {
  readonly settlerType: SettlementEngineType
  readonly credentialId: string
  readonly stream: {
    /**
     * Deterministic generation of previous shared secrets so we can accept payments
     * - Encoded as a hex string
     */
    readonly serverSecret: string
  }
  readonly plugin: {
    readonly btp: {
      readonly serverUri: string
      readonly authToken: string
    }
    // TODO Should the wrapper & plugin have separate stores? (for security) (with new connector, it probs won't)
    // TODO Should the store be versioned to the version of the plugin? (would make migrations easier)
    readonly store: SimpleStore
  }
}

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
  /* tslint:disable-next-line:readonly-keyword TODO */
  streamClientHandler: IlpPrepareHandler
  /** Handle incoming packets from the endpoint receiving money from other parties */
  /* tslint:disable-next-line:readonly-keyword TODO */
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
  /** STREAM server to accept incoming payments from any Interledger client */
  readonly streamServer: StreamServer
  /** TODO */
  readonly config: BaseUplinkConfig
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
      someUplink.settlerType === readyCredential.settlerType
    // TODO This MUST compare the connector it's connected to!
  )
  if (alreadyExists) {
    throw new Error('Cannot create duplicate uplink')
  }

  const config: BaseUplinkConfig = {
    settlerType: readyCredential.settlerType,
    credentialId,
    stream: {
      serverSecret: (await generateSecret()).toString('hex')
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
  const {
    plugin,
    outgoingCapacity$,
    incomingCapacity$,
    totalReceived$
  } = uplink

  const settler = state.settlers[config.settlerType]
  const { exchangeUnit, baseUnit } = settler

  const maxInFlight = await getNativeMaxInFlight(state, config.settlerType)
  const pluginWrapper = new PluginWrapper({
    plugin,
    maxBalance: maxInFlight,
    maxPacketAmount: maxInFlight,
    assetCode: settler.assetCode,
    assetScale: settler.assetScale,
    log: createLogger(`ilp-sdk:${settler.assetCode}:balance`),
    store: new MemoryStore(config.plugin.store, 'wrapper')
  })

  await plugin.connect()
  const clientAddress = await verifyUpstreamAssetDetails(settler)(plugin)

  const balance$ = new BehaviorSubject(new BigNumber(0))
  combineLatest(
    outgoingCapacity$.pipe(distinctBigNum),
    totalReceived$.pipe(distinctBigNum)
  )
    .pipe(sumAll)
    // TODO Try subscribing directly...?
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

  const convertToExchangeUnit = map((value: BigNumber) =>
    convert(baseUnit(value), exchangeUnit())
  )

  // Available to receive (ILP packets) = incomingCapacity - credit already extended
  const availableToReceive$ = new BehaviorSubject(new BigNumber(0))
  combineLatest(
    incomingCapacity$.pipe(distinctBigNum),
    pluginWrapper.receivableBalance$.pipe(
      distinctBigNum,
      convertToExchangeUnit
    )
  )
    .pipe(subtract)
    .subscribe(availableToReceive$)

  // Available to send (ILP packets) = outgoingCapacity + amount prefunded
  const availableToSend$ = new BehaviorSubject(new BigNumber(0))
  combineLatest(
    outgoingCapacity$.pipe(distinctBigNum),
    pluginWrapper.payableBalance$.pipe(
      distinctBigNum,
      convertToExchangeUnit
    )
  )
    .pipe(subtract)
    .subscribe(availableToSend$)

  const handlers: {
    /* tslint:disable-next-line:readonly-keyword TODO */
    streamServerHandler: DataHandler
    /* tslint:disable-next-line:readonly-keyword TODO */
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
  // TODO For now, this won't work, because the original non-wrapper plugin won't auto settle
  const registerServerHandler = (handler: DataHandler) => {
    handlers.streamServerHandler = handler
  }
  const streamServer = await startStreamServer(
    plugin,
    registerServerHandler,
    Buffer.from(config.stream.serverSecret, 'hex')
  )

  return Object.assign(handlers, {
    ...uplink,
    clientAddress,
    streamServer,
    maxInFlight,
    pluginWrapper,
    balance$,
    availableToSend$,
    availableToReceive$,
    config
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
  plugin: PluginWrapper,
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
 * EFFECT: mutates data handler mapped to the internal plugin
 */
export const registerPacketHandler = (handler: IlpPrepareHandler) => (
  uplink: ReadyUplinks
) => {
  uplink.streamClientHandler = handler
}

/**
 * Removes an existing handler for incoming packets not
 * addressed to a specific Stream connection
 *
 * EFFECT: mutates data handler mapped to the internal plugin
 */
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
  readonly value: BigNumber
  /** Amount burned/lost as fee as a result of the transaction, in units of exchange */
  readonly fee: BigNumber
}) => Promise<void>

export type AuthorizeWithdrawal = (params: {
  /** Total amount that will move from layer 2 to layer 1, in units of exchange */
  readonly value: BigNumber
  /** Amount burned/lost as fee as a result of the transaction, in units of exchange */
  readonly fee: BigNumber
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
 * BASE LAYER BALANCE
 * ------------------------------------
 */
export const getBaseBalance = (state: State) => async (
  uplink: ReadyUplinks
) => {
  const credential = getCredential(state)(uplink.credentialId)!

  switch (credential.settlerType) {
    case SettlementEngineType.Lnd:
      return Lnd.getBaseBalance(credential)
    case SettlementEngineType.Machinomy:
      const machinomySettler = state.settlers[credential.settlerType]
      return Machinomy.getBaseBalance(machinomySettler, credential)
    case SettlementEngineType.XrpPaychan:
      const xrpSettler = state.settlers[credential.settlerType]
      return XrpPaychan.getBaseBalance(xrpSettler, credential)
  }
}

/**
 * ------------------------------------
 * RXJS UTILS
 * ------------------------------------
 */

export const sumAll = map((values: BigNumber[]) =>
  values.reduce((a, b) => a.plus(b))
)

export const subtract = map(([a, b]: [BigNumber, BigNumber]) => a.minus(b))

export const distinctBigNum = distinctUntilChanged(
  (prev: BigNumber, curr: BigNumber) => prev.isEqualTo(curr)
)
