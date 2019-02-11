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
import {
  getOrCreateSettler,
  State,
  ReadyCredentials,
  SettlementModule,
  SettlementModules
} from './api'
import { startStreamServer, stopStreamServer } from './services/stream-server'
import { SettlementEngine, SettlementEngineType } from './settlement'
import * as Lnd from './settlement/lnd/lnd'
import * as XrpPaychan from './settlement/xrp-paychan/xrp-paychan'
import { DataHandler, IlpPrepareHandler, Plugin } from './types/plugin'
import { generateSecret } from './utils/crypto'
import { defaultDataHandler, defaultIlpPrepareHandler } from './utils/packet'
import { SimpleStore, MemoryStore } from './utils/store'
import { PluginWrapper } from 'utils/middlewares'

const log = createLogger('switch-api:uplink')

type SettlementModule3<
  TSettlerType extends SettlementEngineType
> = TSettlerType extends SettlementEngineType.Lnd
  ? Lnd.LndSettlementModule
  : TSettlerType extends SettlementEngineType.XrpPaychan
  ? XrpPaychan.XrpPaychanSettlementModule
  : never

// TODO Yuck! Remove this!
export const getSettlerModule = <TSettlerType extends SettlementEngineType>(
  settlerType: TSettlerType
): SettlementModule3<TSettlerType> => {
  switch (settlerType) {
    case SettlementEngineType.Lnd:
      return Lnd.settlementModule as SettlementModule3<TSettlerType>
    case SettlementEngineType.XrpPaychan:
      return XrpPaychan.settlementModule as SettlementModule3<TSettlerType>
    default:
      throw new Error('fuck')
  }
}

declare const b: SettlementEngineType
const a = getSettlerModule(b)

/**
 * Build the ledger-specific uplink, and decorate it with generic functionality
 */

export interface BaseUplinkConfig {
  settlerType: SettlementEngineType
  plugin: {
    btp: {
      serverUri: string
      authToken: string
    }
    store: SimpleStore
  }
}

export type UplinkConfig = (
  | Lnd.LndUplinkConfig
  | XrpPaychan.XrpPaychanUplinkConfig) &
  BaseUplinkConfig

export interface BaseUplink {
  readonly plugin: Plugin
  readonly settlerType: SettlementEngineType
  readonly credentialId: string

  // BALANCES

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

  // TODO These aren't currently used, but may be added back in the future:

  /**
   * Amount of *credit* our peer *is* indebted to us,
   * immediately available for us to spend from
   *
   * - Essentially, the amount prefunded at any moment in time
   */
  // readonly availableToDebit$: BehaviorSubject<BigNumber>
  /**
   * Amount of *credit* our peer *should be* indebted to us
   * after we've settled up with them (settleTo)
   */
  // readonly idleAvailableToDebit: BigNumber
  /**
   * Amount of *credit* we *are* extending to our peer,
   * immediately available for our peer to spend from
   *
   * TODO "our peer to spend from" isn't true/the best description
   */
  // readonly availableToCredit$: BehaviorSubject<BigNumber>
  /**
   * Amount of *credit* that we *should be* extending to our peer
   * after they've settled up with us (max balance - settleTo)
   */
  // readonly idleAvailableToCredit: BigNumber
}

export type ReadyUplink = (
  | Lnd.LndBaseUplink
  // | BaseMachinomyUplink
  | XrpPaychan.XrpPaychanBaseUplink) & {
  /** Wrapper plugin with balance logic to enforce packet clearing and perform accounting */
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
  /**
   * Total amount that we can send immediately over Interledger,
   * including money in layer 2 and amount to debit from connector
   */
  readonly availableToSend$: BehaviorSubject<BigNumber>
  /**
   * Total amount that we could receive immediately over Interledger,
   * including credit we're extending and incoming capacity in layer 2
   */
  readonly availableToReceive$: BehaviorSubject<BigNumber>
  /** STREAM server to accept incoming payments from any Interledger user */
  readonly streamServer: StreamServer
}

// TODO Fix the below 6 lines!!! REALLY bad! (also ADD CORRECT TYPES)
export const connectUplink = (state: State) => (uplink: BaseUplink) => async (
  config: BaseUplinkConfig
): Promise<ReadyUplink> => {
  const settler = await getOrCreateSettler(state, config.settlerType)
  const {
    plugin,
    outgoingCapacity$,
    incomingCapacity$,
    totalReceived$
  } = uplink

  // Connect the plugin & confirm the upstream connector is using the correct asset
  await plugin.connect()
  const clientAddress = await verifyUpstreamAssetDetails(settler)(plugin)

  // Calculate available balance
  const balance$ = new BehaviorSubject(new BigNumber(0))
  combineLatest(outgoingCapacity$, totalReceived$)
    .pipe(sumAll)
    .subscribe(balance$)

  // TODO Credit extended shouldn't be included in the incoming capacity:
  //      For example, if the peer doesn't have that capacity to send us the final settlement,
  //      the settlement shouldn't be attempted in the first place

  // TODO If I have 0 availableToCredit -- e.g., I've extended credit --
  //      the incoming capacity should be LESS how much credit I've extended
  //      because I'm expecting a settlement for that amount
  // const availableToReceive$ = new BehaviorSubject(new BigNumber(0))
  // combineLatest(incomingCapacity$, availableToCredit$)
  //   .pipe(sumAll)
  //   .subscribe(availableToReceive$)
  // TODO ^ Does this work, or do I need individual next, complete, error?

  // TODO Peg the max in flight for this specific uplink for simplicity
  // TODO Create the balance wrapper here for less duplication
  const maxInFlight = await getNativeMaxInFlight(state, credential.settlerType)
  const pluginWrapper = new PluginWrapper({
    plugin,
    maxBalance: maxInFlight,
    maxPacketAmount: maxInFlight,
    assetCode: settler.assetCode,
    assetScale: settler.assetScale,
    log: createLogger(`switch-api:${settler.assetCode}:balance`),
    store: new MemoryStore(config.plugin.store, 'wrapper')
  })
  // TODO Are availableToCredit, idleAvailableToCredit, availableToDebit and idleAvailableToCredit actually important now!?

  // TODO Map balanceBalance and availableToCredit to the correct units (example:)
  /*
  const availableToDebit$ = new BehaviorSubject(new BigNumber(0))
  pluginWrapper.payableBalance$
    .pipe(
      // Only emit updated values
      distinctBigNum,
      map(amount => amount.negated()),
      map<BigNumber, BigNumber>(amount => convert(xrpBase(amount), xrp()))
    )
    .subscribe(availableToDebit$)
  */

  // Setup internal packet handlers and routing

  // TODO These handlers are mutated... yuck!
  const handlers: {
    streamServerHandler: DataHandler
    streamClientHandler: IlpPrepareHandler
  } = {
    streamServerHandler: defaultDataHandler,
    streamClientHandler: defaultIlpPrepareHandler
  }

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
    await generateSecret() // TODO Use this from the config
  )

  return Object.assign(handlers, {
    ...uplink,
    pluginWrapper,
    clientAddress,
    streamServer,
    balance$
    // availableToSend$,
    // availableToReceive$
  })
}

// EFFECT: registers the handlers on the plugin itself
export const setupHandlers = (
  plugin: Plugin,
  clientAddress: string,
  streamServerHandler: DataHandler,
  streamClientHandler: IlpPrepareHandler
) => {
  plugin.deregisterDataHandler()
  plugin.registerDataHandler(async (data: Buffer) => {
    // Apparently plugin-btp will pass data as undefined...
    if (!data) {
      // ...and it will (thankfully) translate this into a BTP error
      throw new Error()
    }

    const prepare = deserializeIlpPrepare(data)
    const hasConnectionTag = prepare.destination
      .replace(clientAddress, '')
      .split('.')
      .some(a => !!a)
    return hasConnectionTag
      ? // Connection ID exists in the ILP address, so route to Stream server
        streamServerHandler(data)
      : // ILP address is for the root plugin, so route packet to sending connection
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

// TODO Settle (up to) (payableBalance - packet amount)? BEFORE sending the packet!

/**
 * Serialize and send an ILP PREPARE to the upstream connector
 */
export const sendPacket = async (
  uplink: ReadyUplink,
  prepare: IlpPrepare
): Promise<IlpReply> => {
  // TODO Limit this by payableBalance?
  uplink.pluginWrapper
    .sendMoney(prepare.amount)
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
  uplink: ReadyUplink
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
  const { baseUnit } = await getOrCreateSettler(state, settlerType)
  return convert(maxInFlightUsd, baseUnit(), rateBackend).dp(
    0,
    BigNumber.ROUND_DOWN
  )
}

// TODO Should I set/add back the max packet amount?

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
}) => Promise<boolean>

export type AuthorizeWithdrawal = (params: {
  /** Total amount that will move from layer 2 to layer 1, in units of exchange */
  value: BigNumber
  /** Amount burned/lost as fee as a result of the transaction, in units of exchange */
  fee: BigNumber
}) => Promise<boolean>

/**
 * ------------------------------------
 * REMOVE UPLINK
 * ------------------------------------
 */

/**
 * Gracefully end the session so the uplink can no longer send/receive
 */
export const disconnect = async (uplink: ReadyUplink) => {
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
