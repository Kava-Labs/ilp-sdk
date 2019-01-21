import { fetch as fetchAssetDetails } from 'ilp-protocol-ildcp'
import {
  deserializeIlpPrepare,
  deserializeIlpReply,
  IlpReply,
  serializeIlpPrepare,
  IlpPrepare,
  serializeIlpReply
} from 'ilp-packet'
import { Plugin, DataHandler, IlpPrepareHandler } from 'types/plugin'
import { defaultDataHandler, defaultIlpPrepareHandler } from 'utils/packet'
import BigNumber from 'bignumber.js'
import BtpPlugin from 'ilp-plugin-btp'
import { SettlementEngineType, SettlementEngine } from 'settlement'
import * as Lnd from 'settlement/lnd/lnd'
import * as Machinomy from 'settlement/machinomy/machinomy'
import * as XrpPaychan from 'settlement/xrp-paychan/xrp-paychan'
import { SimpleStore } from 'utils/store'
// import { ApiUtils } from './api'
import { convert } from '@kava-labs/crypto-rate-utils'

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

// TODO Config object...
export type CreateUplink = (config: object) => InternalUplink

// TODO Can I temporarily combine this with an uplink so they're essentially the same thing?

// TODO What else **really** need to be exposed on the ledger? Anything?
export interface Ledger {
  // TODO
  assetCode: string
  assetScale: number
}

export type Uplink = (
  | Lnd.LndUplink
  | Machinomy.MachinomyUplink
  | XrpPaychan.XrpPaychanUplink) & {
  credentialId: string
}

// TODO This should be renamed to "Uplink" !
// TODO Every "other" uplink should extend this generic interface
export interface NewUplink {
  settler: SettlementEngineType

  /** Handle incoming packets from the endpoint sending money or trading */
  streamClientHandler: IlpPrepareHandler
  /** Handle incoming packets from the endpoint receiving money from other parties */
  streamServerHandler: DataHandler

  plugin: Plugin

  clientAddress: String
}

/** Remove the key of type K from type T */
type Without<T, K> = Pick<T, Exclude<keyof T, K>>
export type UnverifiedUplink = Without<NewUplink, 'clientAddress'>

/** Handle incoming packets */

// TODO Add the plugin when I construct this!
// const initialUplink: UnverifiedUplink = {
//   streamClientHandler: defaultIlpPrepareHandler,
//   streamServerHandler: defaultDataHandler
// }

// To deregister, pass no handler
const setServerHandler = (uplink: NewUplink) => (
  streamServerHandler: DataHandler = defaultDataHandler
) => ({
  ...uplink,
  streamServerHandler
})

// To deregister, pass no handler
const setClientHandler = (uplink: NewUplink) => (
  streamClientHandler: IlpPrepareHandler = defaultIlpPrepareHandler
) => ({
  ...uplink,
  streamClientHandler
})

// EFFECT: registers the handlers on the plugin itself
// (To be pure, does this need to be invoked every* time the handlers are set?)
export const resetHandlers = (
  plugin: Plugin,
  clientAddress: string,
  streamServerHandler: DataHandler = defaultDataHandler,
  streamClientHandler: IlpPrepareHandler = defaultIlpPrepareHandler
) => {
  plugin.deregisterDataHandler()
  plugin.registerDataHandler(async (data: Buffer) => {
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
  uplink: UnverifiedUplink
): Promise<NewUplink> => {
  // Confirm our peer is compatible with the configuration of this uplink
  const { assetCode, assetScale, clientAddress } = await fetchAssetDetails(
    data => uplink.plugin.sendData(data)
  )

  // TODO Refactor to use Maybe<Uplink>
  const incompatiblePeer =
    assetCode !== settler.assetCode || assetScale !== settler.assetScale
  if (incompatiblePeer) {
    throw new Error()
  }

  return {
    ...uplink,
    clientAddress
  }
}

export const isConnected = (uplink: NewUplink) => uplink.plugin.isConnected()

// GETTER
export type AvailableToDebit<UplinkType> = (uplink: UplinkType) => BigNumber
const availableToDebit = (uplink: NewUplink): BigNumber => {
  switch (uplink.settler) {
    case SettlementEngineType.Lnd:
      return // TODO
    case SettlementEngineType.Machinomy:
      return // TODO
    case SettlementEngineType.XrpPaychan:
      return // TODO
  }
}

// GETTER
export type TotalReceived<UplinkType> = (uplink: UplinkType) => BigNumber
const totalReceived = (uplink: NewUplink): BigNumber => {
  switch (uplink.settler) {
    case SettlementEngineType.Lnd:
      return Lnd.totalReceived(uplink)
    case SettlementEngineType.Machinomy:
      return // TODO
    case SettlementEngineType.XrpPaychan:
      return // TODO
  }
}

// GETTER
export type AvailableToSend<UplinkType> = (uplink: UplinkType) => BigNumber
const availableToSend = (uplink: Uplink): BigNumber => {
  switch (uplink.settler) {
    case SettlementEngineType.Lnd:
      return Lnd.availableToSend(uplink)
    case SettlementEngineType.Machinomy:
      return Machinomy.availbleToSend(uplink)
    case SettlementEngineType.XrpPaychan:
      return XrpPaychan.availableToSend(uplink)
  }
}

// GETTER
export const interledgerBalance = (uplink: NewUplink): BigNumber =>
  availableToDebit(uplink)
    .plus(totalReceived(uplink))
    .plus(availableToSend(uplink))

// EFFECT
export const sendPacket = (uplink: NewUplink) => async (
  prepare: IlpPrepare
): Promise<IlpReply> =>
  deserializeIlpReply(
    await uplink.plugin.sendData(serializeIlpPrepare(prepare))
  )

// EFFECT
export const disconnect = (uplink: NewUplink) => {
  // TODO Should this wait for settlements to finish?
  stopStreamServer(uplink.streamServer)
  return uplink.plugin.disconnect()
}

// EFFECT
export const restoreCredit = async (uplink: NewUplink) => {
  /** Disconnect the actual plugin first so the packets aren't sent to two connections */
  await uplink.plugin.disconnect()

  /**
   * Stream prefunded amount back to self
   * - Since the plugin will auto-settle up, a new plugin must be instantiated
   */
  const btpPlugin = new BtpPlugin({ server }) // TODO Expose this!
  await btpPlugin.connect()

  // TODO Fix this!
  await streamMoney({
    amount: uplink.availableCredit,
    source: uplink,
    dest: uplink
  })

  await btpPlugin.disconnect()
}

/**
 * Build the ledger-specific uplink, and decorate it with generic functionality
 */

// TODO Temporary types!
type MachinomyUplinkConfig = { baz: 'adsklfjakldsfj' }
type XrpPaychanUplinkConfig = { foo: 'mehakldjf' }

export type UplinkConfig = (
  | Lnd.LndUplinkConfig
  | MachinomyUplinkConfig
  | XrpPaychanUplinkConfig) & {
  settlerType: SettlementEngineType
  plugin: {
    btp: {
      serverUri: string
      authToken: string
    }
    store: SimpleStore
  }
}

// TODO How can I related the type of the config to the settlement engine type?
const connectUplink = <CredentialType, UplinkType>(
  credential: CredentialType
) => (config: UplinkConfig): UplinkType => {
  switch (config.settlerType) {
    case SettlementEngineType.Lnd:
      return Lnd.connectUplink(credential)(config)
    case SettlementEngineType.Machinomy:
      return Machinomy.connectUplink()
    case SettlementEngineType.XrpPaychan:
      return XrpPaychan.connectUplink()
  }
}

// TODO This should be `connectUplink`, not `createUplink` -- that's what it does!
export const createUplink = async (config: UplinkConfig) => {
  // TODO What is decorated on the uplink other than a plugin? A plugin account? (even that can be loaded async!)
  const plugin = uplink.plugin
  await plugin.connect()
}

/**
 * TODO Order of operations when removing/deleting uplinks:
 *
 * TODO restoreCredit needs to occur before withdrawal (e.g., eth) -- but -- how to do so if the plugin is disconnected? (yuuuuuccccccck..... )
 * 1) restoreCredit() --- this *should* be eliminated!
 * 2) withdraw()
 * 3) disconnect() -- this ideally shouldn't be exposed!
 * 4) remove()
 */

/**
 * Shared plugin balance/max packet config utils
 */

/** Convert the global max-in-flight amount to the local/native units (base units in plugin) */
export const getNativeMaxInFlight = (
  { maxInFlightUsd, rateBackend }: ApiUtils,
  { baseUnit }: SettlementEngine
): BigNumber => convert(maxInFlightUsd, baseUnit(), rateBackend)

export const getPluginBalanceConfig = (maxInFlight: BigNumber) => {
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

export const getPluginMaxPacketAmount = (maxInFlight: BigNumber) =>
  maxInFlight.times(2).toString()
