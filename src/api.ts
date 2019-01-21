import { AssetUnit, RateApi } from '@kava-labs/crypto-rate-utils'
import { Uplink } from './uplink'
import { SettlementEngineType, SettlementEngine } from 'settlement'
import * as Lnd from './settlement/lnd/lnd'
import * as Machinomy from './settlement/machinomy/machinomy'
import * as XrpPaychan from 'settlement/xrp-paychan/xrp-paychan'
import { Option, some, none, fromNullable } from 'fp-ts/lib/Option'

// TODO What if the config is for testnet, but you pass mainnet? Should those be mutually exclusive?
// export type Connect = (configOrEnv: any | LedgerEnv) => Promise<IlpSwitch>

export enum LedgerEnv {
  Mainnet = 'mainnet',
  Testnet = 'testnet',
  Local = 'local'
}

// TODO This needs to be a discriminated union in order to work correctly
export type Credential =
  | Lnd.ReadyLndCredential
  | Machinomy.ReadyEthereumCredential
  | XrpPaychan.ReadyXrpCredential

// TODO Add annotations to this
// TODO Make this immutable?
export interface State {
  ledgerEnv: LedgerEnv
  rateBackend: RateApi
  maxInFlightUsd: AssetUnit
  settlers: { [settlerType in SettlementEngineType]: SettlementEngine }
  credentials: Credential[]
  uplinks: Uplink[]
}

export const getSettler = <SettlementEngineT extends SettlementEngine>(
  state: State
) => (settlerType: SettlementEngineType): SettlementEngineT =>
  state.settlers[settlerType] as SettlementEngineT // TODO How can I get safer typing here?

// TODO Can I simplify this to just reference a specific module based on settlerType?
const getCredentialId = (credential: Credential) => {
  switch (credential.settlerType) {
    case SettlementEngineType.Lnd:
      return Lnd.uniqueId(credential)
    case SettlementEngineType.Machinomy:
      return Machinomy.uniqueId(credential)
    case SettlementEngineType.XrpPaychan:
      return XrpPaychan.uniqueId(credential)
  }
}

export const throwErr = (msg?: string) => {
  throw new Error(msg)
}

// TODO Should this throw if the credential doesn't exist!? It should ALWAYS exist!
export const getCredential = <CredentialT extends Credential>(
  state: State,
  settlerType: SettlementEngineType,
  credentialId: string
): CredentialT =>
  state.credentials.filter(
    (cred): cred is CredentialT =>
      cred.settlerType === settlerType && getCredentialId(cred) === credentialId
  )[0] || throwErr()

const startEngine = (settlerType: SettlementEngineType): SettlementEngine => {
  switch (settlerType) {
    case SettlementEngineType.Lnd:
      return Lnd.setupEngine()
    case SettlementEngineType.Machinomy:
      return Machinomy.setupEngine() // TODO Need api utils!
    case SettlementEngineType.XrpPaychan:
      return null // TODO!
  }
}

// TODO By using an array, it forces computation of the unique Id JIT!

// TODO: Connect the API given this list of uplink configs
const connect = async (configs: UplinkConfig[]) => {
  // TODO Why does this ever need to be "looked up"? Kinda ugly. Look into domain modeling more?
  const settlementEngines: {
    [settler in SettlementEngineType]?: SettlementEngine
  } = {}

  const settlementEngines2 = new Map<SettlementEngineType, SettlementEngine>()
  // settlementEngines2.set(SettlementEngineType.Lnd, 2)

  // TODO This will dynamically create the credentials and uplinks from this config
  // TODO Credentials *may* have to be stored within each specific settlement engine?
  // configs
  //   .map
  // (1) Create settlement engine
  // (2) Create credential
  // (3) Create uplinks
}
