import { AssetUnit } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'

export enum SettlementEngineType {
  /** Lightning daeman */
  Lnd = 'lnd',
  /** Machinomy Ethereum unidirectional payment channels */
  Machinomy = 'machinomy',
  /** XRP ledger native payment channels */
  XrpPaychan = 'xrp-paychan'
}

export interface SettlementEngine {
  assetCode: string
  assetScale: number
  baseUnit: (amount?: BigNumber.Value) => AssetUnit
  exchangeUnit: (amount?: BigNumber.Value) => AssetUnit
  remoteConnectors: {
    local: ConnectorList
    testnet: ConnectorList
    mainnet: ConnectorList
  }
}

interface ConnectorList {
  readonly [name: string]: (token: string) => string
}
