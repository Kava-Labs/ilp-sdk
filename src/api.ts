import {
  AssetUnit,
  RateApi,
  connectCoinCap,
  usd
} from '@kava-labs/crypto-rate-utils'
import {
  ReadyUplink,
  connectUplink,
  BaseUplinkConfig,
  BaseUplink,
  AuthorizeDeposit,
  AuthorizeWithdrawal
} from './uplink'
import { SettlementEngineType, SettlementEngine } from './settlement'
import * as Lnd from './settlement/lnd/lnd'
import * as XrpPaychan from './settlement/xrp-paychan/xrp-paychan'
import { generateToken } from './utils/crypto'
import { streamMoney } from './services/switch'
import BigNumber from 'bignumber.js'

// TODO Should every mutation to state be queued so there's no race conditions?
//      (e.g. creating multiple settlement engines simultaneously, and simply easier to reason about)
//      Another advantage of using Rx to manage state: *possibly* easier mapping to external API?

export const getSettlementModule = (settlerType: SettlementEngineType) =>
  ({
    [SettlementEngineType.Lnd]: Lnd.settlementModule,
    [SettlementEngineType.XrpPaychan]: XrpPaychan.settlementModule
  }[settlerType])

// export const getSettler = <T extends SettlementEngineType>(state: State) => (
//   settlerType: T
// ): State['settlers'][T] => state.settlers[settlerType]

export const getOrCreateSettler = async <T extends SettlementEngineType>(
  state: State,
  settlerType: T
) => {
  const settler: SettlementEngine =
    // state.settlers[settlerType] ||
    await getSettlementModule(settlerType).setupEngine(state.ledgerEnv)
  state.settlers[settlerType] = settler
  return settler
}

// TODO All of these methods should be on a unique, settlement engine -esque interface (with many generics)

export type SettlementModules =
  | Lnd.LndSettlementModule
  | XrpPaychan.XrpPaychanSettlementModule

export interface SettlementModule<
  /** Settlements engines */
  TSettlerType extends SettlementEngineType, // TODO Is this necessary?
  TSettlementEngine extends SettlementEngine,
  /** Credentials */
  TValidatedCredential extends ValidatedCredential,
  TReadyCredential extends ReadyCredential,
  /** Uplinks */
  TUplinkConfig extends BaseUplinkConfig,
  TBaseUplink extends BaseUplink,
  TReadyUplink extends TBaseUplink & ReadyUplink
> {
  /** Settlement engine */

  readonly setupEngine: (ledgerEnv: LedgerEnv) => Promise<TSettlementEngine>

  /** Credentials */

  readonly setupCredential: (
    opts: TValidatedCredential
  ) => (state: State) => Promise<TReadyCredential>

  readonly uniqueId: (cred: TReadyCredential) => string

  readonly closeCredential: (cred: TReadyCredential) => Promise<void>

  /** Uplinks */

  readonly connectUplink: (
    state: State
  ) => (
    cred: TReadyCredential
  ) => (config: TUplinkConfig) => Promise<TBaseUplink>

  readonly deposit?: (
    state: State
  ) => (
    uplink: TReadyUplink
  ) => (opts: {
    amount: BigNumber
    authorize: AuthorizeDeposit
  }) => Promise<void>

  readonly withdraw?: (
    state: State
  ) => (
    uplink: TReadyUplink
  ) => (authorize: AuthorizeWithdrawal) => Promise<void>
}

type GetCredential<
  TSettlementModule extends SettlementModules
> = TSettlementModule extends SettlementModule<
  infer A,
  infer B,
  infer C,
  infer D,
  infer E,
  infer F,
  infer G
>
  ? C
  : never

type GetSettlerType<
  TSettlementModule extends SettlementModules
> = TSettlementModule extends SettlementModule<
  infer A,
  infer B,
  infer C,
  infer D,
  infer E,
  infer F,
  infer G
>
  ? A
  : never

// const getSettlementModule = <T extends SettlementModules>(
//   // cred: GetCredential<T>
//   settlerType: GetSettlerType<T>
// ): T => {
//   switch (settlerType) {
//     case SettlementEngineType.Lnd:
//       return Lnd.settlementModule
//     case SettlementEngineType.XrpPaychan:
//       return XrpPaychan.settlementModule
//   }
// }

// const getSettlerModule = (settlerType: SettlementEngineType) =>
//   ({
//     [SettlementEngineType.Lnd]: Lnd,
//     [SettlementEngineType.XrpPaychan]: XrpPaychan
//   }[settlerType])

// const setupCredential = (credential: ValidatedCredentials) => {
//   switch (credential.settlerType) {
//     case SettlementEngineType.Lnd:
//       return Lnd.setupCredential(credential)
//     case SettlementEngineType.XrpPaychan:
//       return XrpPaychan.setupCredential(credential)
//   }
// }

// const uniqueId = (credential: ReadyCredentials) => {
//   switch (credential.settlerType) {
//     case SettlementEngineType.Lnd:
//       return Lnd.uniqueId(credential)
//     case SettlementEngineType.XrpPaychan:
//       return XrpPaychan.uniqueId(credential)
//   }
// }

// const closeCredential = (credential: ReadyCredentials) => {
//   switch (credential.settlerType) {
//     case SettlementEngineType.Lnd:
//       return Lnd.closeCredential(credential)
//     case SettlementEngineType.XrpPaychan:
//       return XrpPaychan.closeCredential()
//   }
// }

export type ValidatedCredentials2<
  T extends SettlementModules
> = T extends Lnd.LndSettlementModule
  ? Lnd.ValidatedLndCredential
  : T extends XrpPaychan.XrpPaychanSettlementModule
  ? XrpPaychan.ValidatedXrpSecret
  : never

export const connect = async (ledgerEnv: LedgerEnv) => {
  // TODO Default/initial state

  let state: State = {
    ledgerEnv,
    rateBackend: await connectCoinCap(),
    maxInFlightUsd: usd(0.05),
    settlers: {},
    credentials: [],
    uplinks: []
  }

  // TODO Add functionality to connect existing uplinks ...

  // TODO Change the discriminant so it's all "SettlementEngineType" or the union
  const configure = async <
    /** Settlements engines */
    TSettlerType extends SettlementEngineType, // TODO Is this necessary?
    TSettlementEngine extends SettlementEngine,
    /** Credentials */
    TValidatedCredential extends ValidatedCredentials,
    TReadyCredential extends ReadyCredentials,
    /** Uplinks */
    TUplinkConfig extends BaseUplinkConfig,
    TBaseUplink extends BaseUplink,
    TReadyUplink extends TBaseUplink & ReadyUplink
  >(
    settlementModule: SettlementModule<
      TSettlerType,
      TSettlementEngine,
      TValidatedCredential,
      TReadyCredential,
      TUplinkConfig,
      TBaseUplink,
      TReadyUplink
    >,
    // | Lnd.LndSettlementModule
    // | XrpPaychan.XrpPaychanSettlementModule,
    // cred: ThenArg<ReturnType<T['setupEngine']>> */
    // cred: ValidatedCredential & { settlerType: T }
    // cred: GetCredential<T>
    cred: TValidatedCredential
  ): Promise<ReadyUplink> => {
    // const settlerModule = getSettlerModule(cred.settlerType)
    // const settlementModule = getSettlementModule<T>(cred)

    // TODO Get the settler (create it if it doesn't exist)
    let settler = state.settlers[cred.settlerType]
    if (!settler) {
      settler = await settlementModule.setupEngine(state.ledgerEnv)
      state.settlers[cred.settlerType] = settler
    }

    let readyCredential: TReadyCredential = await settlementModule.setupCredential(
      cred
    )(state)
    const credentialId = settlementModule.uniqueId(readyCredential)

    // Check if the same the credential already exists
    // If not, just use that
    const existingCredential = state.credentials
      .filter(
        (someCredential): someCredential is TReadyCredential =>
          someCredential.settlerType === cred.settlerType
      )
      .filter(
        someCredential =>
          settlementModule.uniqueId(someCredential) === credentialId
      )[0]
    if (existingCredential) {
      await settlementModule.closeCredential(readyCredential)
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
        uplink.settlerType === cred.settlerType &&
        uplink.credentialId === credentialId &&
        false
      // TODO Add back serverUri check (must exist on uplink)
      // serverUriNoToken === uplink.serverUri
    )
    if (alreadyExists) {
      throw new Error('Cannot create duplicate uplink')
    }

    const config = {
      // settlerType: SettlementEngineType.Lnd,
      settlerType, // TODO!
      plugin: {
        btp: {
          serverUri,
          authToken
        },
        store: {}
      }
      // credentialId // TODO Is this necessary if it can be generated?
    }

    // TODO Fix this wtf lol
    const baseUplink = await settlementModule.connectUplink(state)(
      readyCredential
    )(config)
    const uplink = await connectUplink(state)(baseUplink)()
    state.uplinks.push(uplink)

    return uplink
  }

  // TODO
  // (1) Withdraw (if applicable)
  // (2) Disconnect (call in uplink.ts)
  // (3) Remove
  const remove = () => {
    // TODO !
  }

  // TODO Fix this!
  const deposit = XrpPaychan.deposit(state)

  // TODO Export deposit, withdrawal, switch (etc)

  return {
    // TODO Lol don't do this
    state,
    deposit,
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
