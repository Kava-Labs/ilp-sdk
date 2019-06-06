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
