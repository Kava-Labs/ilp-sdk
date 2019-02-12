import { AssetUnit } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import { LndSettlementEngine } from './lnd/lnd'
import { XrpPaychanSettlementEngine } from './xrp-paychan/xrp-paychan'

export enum SettlementEngineType {
  /** Lightning daeman */
  Lnd = 'lnd',
  /** Machinomy Ethereum unidirectional payment channels */
  // Machinomy = 'machinomy',
  /** XRP ledger native payment channels */
  XrpPaychan = 'xrp-paychan'
}

export interface SettlementEngine {
  settlerType: SettlementEngineType // TODO

  assetCode: string
  assetScale: number
  baseUnit: (amount?: BigNumber.Value) => AssetUnit
  exchangeUnit: (amount?: BigNumber.Value) => AssetUnit
  /**
   * Mapping of BTP websocket URIs for remote connectors,
   * specific to the ledger env of the settlement engine
   */
  remoteConnectors: {
    readonly [name: string]: (token: string) => string
  }
}

export type SettlementEngines = LndSettlementEngine | XrpPaychanSettlementEngine
