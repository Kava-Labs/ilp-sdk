import { fetch as fetchAssetDetails } from 'ilp-protocol-ildcp'
import {
  deserializeIlpPrepare,
  deserializeIlpReply,
  IlpReply,
  serializeIlpPrepare,
  IlpPrepare,
  serializeIlpReply
} from 'ilp-packet'
import { Plugin, DataHandler, IlpPrepareHandler } from './types/plugin'
import { defaultDataHandler, defaultIlpPrepareHandler } from './utils/packet'
import BigNumber from 'bignumber.js'
import { SettlementEngineType, SettlementEngine } from 'settlement'
import * as Lnd from './settlement/lnd/lnd'
// import * as Machinomy from 'settlement/machinomy/machinomy'
// import * as XrpPaychan from 'settlement/xrp-paychan/xrp-paychan'
import { SimpleStore } from './utils/store'
import { convert } from '@kava-labs/crypto-rate-utils'
import { State, Credential, getSettler } from './api'
import { BehaviorSubject, combineLatest } from 'rxjs'
import { startStreamServer, stopStreamServer } from './services/stream-server'
import { generateSecret } from './utils/crypto'
import { Server as StreamServer } from 'ilp-protocol-stream'
import { streamMoney } from './services/switch'
import BtpPlugin from 'ilp-plugin-btp'
import { map } from 'rxjs/operators'

export const getSettlerModule = (settlerType: SettlementEngineType) => {
  return Lnd

  // TODO Add this back (to support everything)!
  // switch (settlerType) {
  //   case SettlementEngineType.Lnd:
  //     return Lnd
  //   case SettlementEngineType.Machinomy:
  //     return Machinomy
  //   case SettlementEngineType.XrpPaychan:
  //     return XrpPaychan
  // }
}

/**
 * Build the ledger-specific uplink, and decorate it with generic functionality
 */

// TODO Temporary types!
type MachinomyUplinkConfig = { baz: 'adsklfjakldsfj' }
type XrpPaychanUplinkConfig = { foo: 'mehakldjf' }

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
  | MachinomyUplinkConfig
  | XrpPaychanUplinkConfig) &
  BaseUplinkConfig

// TODO Add comments here

export interface BaseUplink {
  plugin: Plugin // TODO make readonly
  readonly settlerType: SettlementEngineType
  readonly credentialId: string

  // BALANCES

  /**
   * Amount of our *money* in layer 2,
   * immediately available for us to send to our peer
   */
  readonly outgoingCapacity$: BehaviorSubject<BigNumber>
  /**
   * Amount of our peer's *money* in layer 2,
   * immediately available for our peer to send to us
   */
  readonly incomingCapacity$: BehaviorSubject<BigNumber>
  /**
   * Amount of *credit* our peer is indebted to us,
   * immediately available for us to spend from
   */
  readonly availableToDebit$: BehaviorSubject<BigNumber>
  /**
   * Amount of *credit* we're extending to our peer,
   * immediately available for our peer to spend from
   */
  readonly availableToCredit$: BehaviorSubject<BigNumber>
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

// TODO For testing purposes.
interface BaseMachinomyUplink extends BaseUplink {
  foo: 'bar'
}
interface BaseXrpPaychanUplink extends BaseUplink {
  bar: 'baz'
}

export type ReadyUplink = (
  | Lnd.LndBaseUplink
  | BaseMachinomyUplink
  | BaseXrpPaychanUplink) & {
  /** Handle incoming packets from the endpoint sending money or trading */
  streamClientHandler: IlpPrepareHandler
  /** Handle incoming packets from the endpoint receiving money from other parties */
  streamServerHandler: DataHandler
  /** ILP address assigned from upstream connector */
  readonly clientAddress: string
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

export const connectUplink = (state: State) => (
  credential: Lnd.ReadyLndCredential
) => async (config: UplinkConfig): Promise<ReadyUplink> => {
  // TODO Fix this code to make it more agnostic!
  const settler = Lnd.setupEngine(state.ledgerEnv) // TODO !
  const settlerUplink = await getSettlerModule(
    credential.settlerType
  ).connectUplink(state)(credential)(config as Lnd.LndUplinkConfig)

  const {
    plugin,
    outgoingCapacity$,
    incomingCapacity$,
    availableToDebit$,
    availableToCredit$,
    totalReceived$
  } = settlerUplink

  // Register a money handler, because, apparently, this is ABSOLUTELY necessary?
  plugin.registerMoneyHandler(() => Promise.resolve())

  // Connect the plugin & confirm the upstream connector is using the correct asset
  await plugin.connect()
  const clientAddress = await verifyUpstreamAssetDetails(settler)(plugin)

  // Setup internal packet handlers and routing
  // TODO Use a BehaviorSubject for this/function that maps to internal handlers? Setup handlers should only be called once!

  const handlers: {
    streamServerHandler: DataHandler
    streamClientHandler: IlpPrepareHandler
  } = {
    streamServerHandler: defaultDataHandler,
    streamClientHandler: defaultIlpPrepareHandler
  }

  setupHandlers(
    plugin,
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

  // Calculate available balance
  const balance$ = new BehaviorSubject(new BigNumber(0))
  combineLatest(outgoingCapacity$, availableToDebit$, totalReceived$)
    .pipe(map(sumAll))
    .subscribe(balance$)

  const availableToSend$ = new BehaviorSubject(new BigNumber(0))
  combineLatest(outgoingCapacity$, availableToDebit$)
    .pipe(map(sumAll))
    .subscribe(availableToSend$)

  const availableToReceive$ = new BehaviorSubject(new BigNumber(0))
  combineLatest(incomingCapacity$, availableToCredit$)
    .pipe(map(sumAll))
    .subscribe(availableToReceive$)

  return Object.assign(handlers, {
    ...settlerUplink,
    clientAddress,
    streamServer,
    balance$,
    availableToSend$,
    availableToReceive$
  })
}

/** Handle incoming packets */

// EFFECT: registers the handlers on the plugin itself
export const setupHandlers = (
  plugin: Plugin,
  clientAddress: string,
  streamServerHandler: DataHandler,
  streamClientHandler: IlpPrepareHandler
) => {
  plugin.deregisterDataHandler()
  plugin.registerDataHandler(async (data: Buffer) => {
    // TODO Apparently plugin-btp will pass data as undefined. Wtf?
    if (!data) {
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
      : // ILP address is for the root plugin, so route to sending connection
        serializeIlpReply(await streamClientHandler(prepare))
  })
}

/** Confirm the upstream peer shares the same asset details and save our ILP address */
const verifyUpstreamAssetDetails = (settler: SettlementEngine) => async (
  plugin: Plugin
): Promise<string> => {
  // Confirm our peer is compatible with the configuration of this uplink
  const { assetCode, assetScale, clientAddress } = await fetchAssetDetails(
    data => plugin.sendData(data)
  )

  // TODO Refactor to use Option<ClientAddress>
  const incompatiblePeer =
    assetCode !== settler.assetCode || assetScale !== settler.assetScale
  if (incompatiblePeer) {
    throw new Error(
      'Upstream connector is using a different asset or configuration'
    ) // TODO Should this error disconnect the plugin? (Really, any error while the connection is attempted)
  }

  return clientAddress
}

/*
 * ------------------------------------
 * UTILS
 * ------------------------------------
 */

/*
 * SWITCHING ASSETS
 */

/**
 * Serialize and send an ILP PREPARE to the upstream connector
 */
export const sendPacket = async (
  uplink: ReadyUplink,
  prepare: IlpPrepare
): Promise<IlpReply> =>
  deserializeIlpReply(
    await uplink.plugin.sendData(serializeIlpPrepare(prepare))
  )

/**
 * Registers a handler for incoming packets not addressed to a specific Stream connection,
 * such as packets sent to ourself
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

/*
 * PLUGIN CONFIGURATION
 */

/** Convert the global max-in-flight amount to the local/native units (base units in plugin) */
export const getNativeMaxInFlight = (
  state: State,
  settlerType: SettlementEngineType
): BigNumber => {
  const { maxInFlightUsd, rateBackend } = state
  const { baseUnit } = getSettler(state)(settlerType)
  return convert(maxInFlightUsd, baseUnit(), rateBackend)
}

export const getPluginBalanceConfig = (maxInFlight: BigNumber) => {
  const maxPrefund = maxInFlight.dp(0, BigNumber.ROUND_CEIL)
  const maxCredit = maxPrefund
    .plus(maxInFlight.times(2)) // TODO Would this fail if we always send max packets, and exchange rate is > 1?
    .dp(0, BigNumber.ROUND_CEIL)

  return {
    maximum: maxCredit,
    settleTo: maxPrefund,
    settleThreshold: maxPrefund
  }
}

export const getPluginMaxPacketAmount = (maxInFlight: BigNumber) =>
  maxInFlight.times(2).toString()

/**
 * ------------------------------------
 * DEPOSITS & WITHDRAWALS
 * ------------------------------------
 */

export type AuthorizeDeposit = (
  params: {
    /** Total amount that will move from layer 1 to layer 2, in units of exchange */
    value: BigNumber
    /** Amount burned/lost as fee as a result of the transaction, in units of exchange */
    fee: BigNumber
  }
) => Promise<boolean>

export type AuthorizeWithdrawal = (
  params: {
    /** Total amount that will move from layer 2 to layer 1, in units of exchange */
    value: BigNumber
    /** Amount burned/lost as fee as a result of the transaction, in units of exchange */
    fee: BigNumber
  }
) => Promise<boolean>

/**
 * ------------------------------------
 * REMOVE UPLINK
 * ------------------------------------
 */

/*
 * DELETING UPLINKS
 * (1) Restore credit
 * (2) Withdraw
 * (3) Disconnect
 * (4) Remove
 */

/** TODO Implement this */
export const remove = () => 3

/**
 * Transfer amount prefunded to connector back to layer 2
 */
export const restoreCredit = (state: State) => async (uplink: ReadyUplink) => {
  // TODO Wait for it to finish settling up?
  await new Promise(r => setTimeout(r, 2000))

  // @ts-ignore
  uplink.plugin._balance.settleThreshold = new BigNumber(-Infinity)

  // Stream prefunded amount back to self
  await streamMoney(state)({
    amount: uplink.availableToDebit$.getValue(),
    source: uplink,
    dest: uplink
  })

  // TODO Wait for it to finish settling up?
  await new Promise(r => setTimeout(r, 2000))
}

/**
 * Gracefully end the session so the uplink can no longer send/receive
 */
export const disconnect = (uplink: ReadyUplink) => {
  // TODO Should this wait for settlements to finish?
  stopStreamServer(uplink.streamServer).catch(err => {
    // TODO Add log for errors!
    console.log(err)
  })
  return uplink.plugin.disconnect()
}

// TODO Move this elsewhere?
export const sumAll = (values: BigNumber[]) =>
  values.reduce((a, b) => a.plus(b))
