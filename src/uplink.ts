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
import { SettlementEngineType, SettlementEngine } from './settlement'
import * as Lnd from './settlement/lnd/lnd'
// import * as Machinomy from 'settlement/machinomy/machinomy'
import * as XrpPaychan from './settlement/xrp-paychan/xrp-paychan'
import { SimpleStore } from './utils/store'
import { convert } from '@kava-labs/crypto-rate-utils'
import { State, getSettler } from './api'
import { BehaviorSubject, zip, combineLatest } from 'rxjs'
import { startStreamServer, stopStreamServer } from './services/stream-server'
import { generateSecret } from './utils/crypto'
import { Server as StreamServer } from 'ilp-protocol-stream'
import { streamMoney } from './services/switch'
import { map, tap, distinctUntilChanged, first } from 'rxjs/operators'
import createLogger from './utils/log'

export const getSettlerModule = (settlerType: SettlementEngineType) => {
  // return Lnd
  // TODO Add this back (to support everything)!
  switch (settlerType) {
    case SettlementEngineType.Lnd:
      return Lnd
    // case SettlementEngineType.Machinomy:
    //   return Machinomy
    case SettlementEngineType.XrpPaychan:
      return XrpPaychan
  }
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
   * Amount of *money* our peer has in layer 2,
   * immediately available for our peer to send to us
   */
  readonly incomingCapacity$: BehaviorSubject<BigNumber>
  /**
   * Amount of *credit* our peer *is* indebted to us,
   * immediately available for us to spend from
   *
   * - Essentially, the amount prefunded at any moment in time
   */
  readonly availableToDebit$: BehaviorSubject<BigNumber>
  /**
   * Amount of *credit* our peer *should be* indebted to us
   * after we've settled up with them (settleTo)
   */
  readonly idleAvailableToDebit: BigNumber
  /**
   * Amount of *credit* we *are* extending to our peer,
   * immediately available for our peer to spend from
   *
   * TODO "our peer to spend from" isn't true/the best description
   */
  readonly availableToCredit$: BehaviorSubject<BigNumber>
  /**
   * Amount of *credit* that we *should be* extending to our peer
   * after they've settled up with us (max balance - settleTo)
   */
  readonly idleAvailableToCredit: BigNumber
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
// interface BaseMachinomyUplink extends BaseUplink {
//   foo: 'bar'
// }
// interface BaseXrpPaychanUplink extends BaseUplink {
//   bar: 'baz'
// }

export type ReadyUplink = (
  | Lnd.LndBaseUplink
  // | BaseMachinomyUplink
  | XrpPaychan.XrpPaychanBaseUplink) & {
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

// TODO ALOT needs to be fixed here!
export const connectUplink = (state: State) => (credential: any) => async (
  config: any
): Promise<ReadyUplink> => {
  // TODO Fix this code to make it more agnostic!
  const settler = getSettler(state)(credential.settlerType)! // TODO !
  const module = getSettlerModule(credential.settlerType)

  // @ts-ignore TODO
  const settlerUplink = await module.connectUplink(state)(credential)(config)

  const {
    plugin,
    outgoingCapacity$,
    incomingCapacity$,
    availableToDebit$,
    availableToCredit$,
    totalReceived$
  } = settlerUplink

  // Register a money handler, because, apparently otherwise it will error?
  plugin.registerMoneyHandler(() => Promise.resolve())

  // Connect the plugin & confirm the upstream connector is using the correct asset
  await plugin.connect()
  const clientAddress = await verifyUpstreamAssetDetails(settler)(plugin)

  // Setup internal packet handlers and routing

  // TODO Make sure these handlers are mapped correctly, since they are mutated (yuck!)
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

  const log = createLogger(`ilp:test:${settler.assetCode}`)

  // TODO Better explanation here?
  // TODO Is this correct? Previously I just used `combineLatest` and `sumAll`
  // TODO If availableToDebit changes, outgoing capacity ALWAYS changes! (but if outgoing capacity changes -- e.g. deposit -- prefund won't necessarily change)
  const availableToSend$ = new BehaviorSubject(new BigNumber(0))
  /**
   * Since a change in that amount prefunded to the connector also
   * likely changes the outgoing capacity, use zip
   */
  combineLatest(outgoingCapacity$, availableToDebit$)
    .pipe(
      tap(vals => {
        // TODO Temporary! Remove this!
        // log.info(`OUTGOING CAPACITY:  ${vals[0]}`)
        // log.info(`AVAILABLE TO DEBIT: ${vals[1]}`)
      }),
      sumAll()
    )
    .subscribe(availableToSend$)

  // Calculate available balance
  const balance$ = new BehaviorSubject(new BigNumber(0))
  combineLatest(availableToSend$, totalReceived$)
    .pipe(sumAll())
    .subscribe(balance$)

  balance$.subscribe(amount => {
    log.info('BALANCE: ', amount.toString())
  })

  const availableToReceive$ = new BehaviorSubject(new BigNumber(0))
  combineLatest(incomingCapacity$, availableToCredit$)
    .pipe(sumAll())
    .subscribe({
      next: val => {
        availableToReceive$.next(val)
      },
      complete: () => {
        availableToReceive$.complete()
      },
      error: err => {
        availableToReceive$.error(err)
      }
    })

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
  const { baseUnit } = getSettler(state)(settlerType)! // TODO !
  return convert(maxInFlightUsd, baseUnit(), rateBackend).dp(
    0,
    BigNumber.ROUND_DOWN
  )
}

// TODO Can I elimiante this?
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

// TODO Can I eliminate this?
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
  // Wait for outgoing settlements to finish/be topped up
  // TODO Add timeout?
  await uplink.availableToDebit$
    .pipe(first(val => val.gte(uplink.idleAvailableToDebit)))
    .toPromise()

  // TODO What if each uplink exposed a function to turn off/prevent settlements?
  // @ts-ignore
  uplink.plugin._balance.settleThreshold = new BigNumber(-Infinity)

  // Stream prefunded amount back to self
  await streamMoney(state)({
    amount: uplink.availableToDebit$.getValue(),
    source: uplink,
    dest: uplink
  })

  // Ensure to credit is remaining on the connector
  // TODO Add timeout?
  await uplink.availableToDebit$.pipe(first(val => val.isZero())).toPromise()
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

// TODO Move this elsewhere? (common rxjs operators etc)

export const sumAll = () =>
  map((values: BigNumber[]) => values.reduce((a, b) => a.plus(b)))

export const distinctBigNum = distinctUntilChanged(
  (prev: BigNumber, cur: BigNumber) => prev.eq(cur)
)

// TODO Remove these?

// TODO Add timeout/failure case?
export const readyToDebit = (uplink: ReadyUplink): Promise<BigNumber> =>
  uplink.availableToDebit$
    .pipe(first(val => val.gte(uplink.idleAvailableToDebit)))
    .toPromise()

// TODO Add timeout/failure case?
export const readyToCredit = (uplink: ReadyUplink): Promise<BigNumber> =>
  uplink.availableToCredit$
    .pipe(first(val => val.gte(uplink.idleAvailableToCredit)))
    .toPromise()
