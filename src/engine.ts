import { AssetUnit } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import { LndSettlementEngine } from './settlement/lnd'
import {
  XrpPaychanSettlementEngine,
  closeXrpPaychanEngine
} from './settlement/xrp-paychan'
import { MachinomySettlementEngine } from './settlement/machinomy'

export enum SettlementEngineType {
  /** Lightning daeman */
  Lnd = 'lnd',
  /** Machinomy Ethereum unidirectional payment channels */
  Machinomy = 'machinomy',
  /** XRP ledger native payment channels */
  XrpPaychan = 'xrp-paychan'
}

export interface SettlementEngine {
  readonly settlerType: SettlementEngineType
  readonly assetCode: string
  readonly assetScale: number
  readonly baseUnit: (amount?: BigNumber.Value) => AssetUnit
  readonly exchangeUnit: (amount?: BigNumber.Value) => AssetUnit
  /**
   * Mapping of BTP websocket URIs for remote connectors,
   * specific to the ledger env of the settlement engine
   */
  readonly remoteConnectors: {
    readonly [name: string]: (token: string) => string
  }
}

export type SettlementEngines = (
  | LndSettlementEngine
  | MachinomySettlementEngine
  | XrpPaychanSettlementEngine) &
  SettlementEngine

export const closeEngine = async (settler: SettlementEngines) => {
  switch (settler.settlerType) {
    case SettlementEngineType.XrpPaychan:
      return closeXrpPaychanEngine(settler)
  }
}
