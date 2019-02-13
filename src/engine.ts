import { AssetUnit } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import { LndSettlementEngine, Lnd } from './settlement/lnd/lnd'
import {
  XrpPaychanSettlementEngine,
  XrpPaychan
} from './settlement/xrp-paychan/xrp-paychan'
import { State, LedgerEnv } from '.'
import { Machinomy } from './settlement/machinomy/machinomy'

export enum SettlementEngineType {
  /** Lightning daeman */
  Lnd = 'lnd',
  /** Machinomy Ethereum unidirectional payment channels */
  Machinomy = 'machinomy',
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

// TODO Add "closeEngine" to specific settlement modules
export const closeEngine = (settler: SettlementEngines) => {
  switch (settler.settlerType) {
    case SettlementEngineType.Lnd:
      return
    case SettlementEngineType.XrpPaychan:
      return
  }
}

export const createEngine = (ledgerEnv: LedgerEnv) => async (
  settlerType: SettlementEngineType
): Promise<SettlementEngines> => {
  switch (settlerType) {
    case SettlementEngineType.Lnd:
      return Lnd.setupEngine(ledgerEnv)
    case SettlementEngineType.Machinomy:
      return Machinomy.setupEngine(ledgerEnv)
    case SettlementEngineType.XrpPaychan:
      return XrpPaychan.setupEngine(ledgerEnv)
  }
}
