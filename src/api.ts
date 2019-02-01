import {
  AssetUnit,
  RateApi,
  connectCoinCap,
  usd
} from '@kava-labs/crypto-rate-utils'
import { ReadyUplink, connectUplink } from './uplink'
import { SettlementEngineType, SettlementEngine } from './settlement'
import * as Lnd from './settlement/lnd/lnd'
// import * as Machinomy from './settlement/machinomy/machinomy'
import * as XrpPaychan from './settlement/xrp-paychan/xrp-paychan'
import { generateToken } from './utils/crypto'
import { streamMoney } from './services/switch'

// TODO Should every mutation to state be queued so there's no race conditions?
//      (e.g. creating multiple settlement engines simultaneously, and simply easier to reason about)
//      Another advantage of using Rx to manage state: *possibly* easier mapping to external API?

export const getSettler = <T extends SettlementEngineType>(state: State) => (
  settlerType: T
): State['settlers'][T] => state.settlers[settlerType]

const getSettlerModule = (settlerType: SettlementEngineType) =>
  ({
    [SettlementEngineType.Lnd]: Lnd,
    [SettlementEngineType.XrpPaychan]: XrpPaychan
  }[settlerType])

const setupCredential = (credential: ValidatedCredentials) => {
  switch (credential.settlerType) {
    case SettlementEngineType.Lnd:
      return Lnd.setupCredential(credential)
    case SettlementEngineType.XrpPaychan:
      return XrpPaychan.setupCredential(credential)
  }
}

const uniqueId = (credential: ReadyCredentials) => {
  switch (credential.settlerType) {
    case SettlementEngineType.Lnd:
      return Lnd.uniqueId(credential)
    case SettlementEngineType.XrpPaychan:
      return XrpPaychan.uniqueId(credential)
  }
}

const closeCredential = (credential: ReadyCredentials) => {
  switch (credential.settlerType) {
    case SettlementEngineType.Lnd:
      return Lnd.closeCredential(credential)
    case SettlementEngineType.XrpPaychan:
      return XrpPaychan.closeCredential()
  }
}

export const connect = async (ledgerEnv: LedgerEnv) => {
  // TODO Default/initial state

  let state: State = {
    ledgerEnv,
    rateBackend: await connectCoinCap(),
    maxInFlightUsd: usd(0.1),
    settlers: {},
    credentials: [],
    uplinks: []
  }

  // TODO Change the discriminant so it's all "SettlementEngineType" or the union
  const configure = async (
    cred: ValidatedCredentials
  ): Promise<ReadyUplink> => {
    const settlerModule = getSettlerModule(cred.settlerType)

    // TODO Get the settler (create it if it doesn't exist)
    let settler = state.settlers[cred.settlerType]
    if (!settler) {
      settler = await settlerModule.setupEngine(state.ledgerEnv)
      state.settlers[cred.settlerType] = settler
    }

    let readyCredential = await setupCredential(cred)(state)
    const credentialId = uniqueId(readyCredential)

    // Check if the same the credential already exists
    // If not, just use that
    const existingCredential = state.credentials.filter(
      (someCredential): someCredential is typeof readyCredential =>
        someCredential.settlerType === cred.settlerType.toLowerCase() &&
        uniqueId(someCredential) === credentialId
    )[0]
    if (existingCredential) {
      await closeCredential(readyCredential)
      readyCredential = existingCredential
    } else {
      state.credentials.push(readyCredential)
    }

    const authToken = await generateToken()
    const createServerUri = settler.remoteConnectors['Kava Labs']
    const serverUri = createServerUri(authToken)
    // const serverUriNoToken = createServerUri('')

    const alreadyExists = state.uplinks.some(
      uplink =>
        uplink.settlerType === cred.settlerType.toLowerCase() &&
        uplink.credentialId === credentialId &&
        false
      // TODO Add back serverUri check (must exist on uplink)
      // serverUriNoToken === uplink.serverUri
    )
    if (alreadyExists) {
      throw new Error('Cannot create duplicate uplink')
    }

    const uplink = await connectUplink(state)(readyCredential)({
      settlerType: SettlementEngineType.Lnd,
      plugin: {
        btp: {
          serverUri,
          authToken
        },
        store: {}
      },
      credentialId // TODO Is this necessary if it can be generated?
    })
    state.uplinks.push(uplink)

    return uplink
  }

  // TODO Export deposit, withdrawal, switch (etc)

  return {
    // TODO Lol don't do this
    state,

    configure,
    streamMoney: streamMoney(state)
  }
}

export enum LedgerEnv {
  Mainnet = 'mainnet',
  Testnet = 'testnet',
  Local = 'local'
}

export interface ValidatedCredential {
  settlerType: SettlementEngineType
}

export type ValidatedCredentials = (
  | Lnd.ValidatedLndCredential
  | XrpPaychan.ValidatedXrpSecret) &
  ValidatedCredential

export interface ReadyCredential {
  settlerType: SettlementEngineType // TODO
}

// TODO This needs to be a discriminated union in order to work correctly (e.g. settlerType within)
export type ReadyCredentials = (
  | Lnd.ReadyLndCredential
  // | Machinomy.ReadyEthereumCredential
  | XrpPaychan.ReadyXrpCredential) &
  ReadyCredential

// TODO Add comments to this
// TODO Make this immutable?
export interface State {
  readonly ledgerEnv: LedgerEnv
  readonly rateBackend: RateApi
  readonly maxInFlightUsd: AssetUnit
  settlers: {
    [SettlementEngineType.Lnd]?: Lnd.LndSettlementEngine
    [SettlementEngineType.XrpPaychan]?: XrpPaychan.XrpPaychanSettlementEngine
  }
  credentials: ReadyCredentials[]
  uplinks: ReadyUplink[]
}
