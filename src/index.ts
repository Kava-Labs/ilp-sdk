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
  AuthorizeWithdrawal,
  BaseUplinks,
  ReadyUplinks,
  closeUplink
} from './uplink'
import {
  SettlementEngineType,
  SettlementEngine,
  SettlementEngines
} from './settlement'
import {
  Lnd,
  LndSettlementModule,
  ReadyLndCredential,
  LndSettlementEngine,
  ValidatedLndCredential,
  closeCredential
} from './settlement/lnd/lnd' // TODO Change these to import module & types
import {
  XrpPaychan,
  XrpPaychanSettlementModule,
  ReadyXrpCredential,
  XrpPaychanSettlementEngine,
  ValidatedXrpSecret
} from './settlement/xrp-paychan/xrp-paychan' // TODO Change these to import module & types
import { generateToken, generateSecret } from './utils/crypto'
import { streamMoney } from './services/switch'
import BigNumber from 'bignumber.js'

type SettlementModule2<
  TSettlerType
> = TSettlerType extends SettlementEngineType.Lnd
  ? Lnd.LndSettlementModule
  : TSettlerType extends SettlementEngineType.XrpPaychan
  ? XrpPaychan.XrpPaychanSettlementModule
  : never

// type SettlementModule3<
//   SettlementEngineType.Lnd
// > = Lnd.LndSettlementModule

export const getSettlementModule = <T extends SettlementEngineType>(
  settlerType: T
) =>
  ({
    [SettlementEngineType.Lnd]: Lnd.settlementModule,
    [SettlementEngineType.XrpPaychan]: XrpPaychan.settlementModule
  }[settlerType])

// export const getSettlementModule2 = <T extends SettlementEngineType>(
//   settlerType: T
// ): T extends SettlementEngineType.Lnd
//   ? Lnd.LndSettlementModule
//   : T extends SettlementEngineType.XrpPaychan
//   ? XrpPaychan.XrpPaychanSettlementModule
//   : never => {
//   switch (settlerType) {
//     case SettlementEngineType.Lnd:
//       return Lnd.settlementModule
//     case SettlementEngineType.XrpPaychan:
//       return XrpPaychan.settlementModule
//   }
// }
// ({
//   [SettlementEngineType.Lnd]: Lnd.settlementModule,
//   [SettlementEngineType.XrpPaychan]: XrpPaychan.settlementModule
// }[settlerType])

type NarrowSettlerType<
  Union,
  Tag extends SettlementEngineType
> = Union extends {
  settlerType: Tag
}
  ? Union
  : never

// type TagWithKey<TagName extends string, T> = {
//   [K in keyof T]: { [_ in TagName]: K } & T[K]
// }

export const getOrCreateSettler = async <T extends SettlementEngineType>(
  state: State,
  settlerType: T
) => {
  const settler: SettlementEngine = await getSettlementModule(
    settlerType
  ).setupEngine(state.ledgerEnv)
  state.settlers[settlerType] = settler
  return settler
}

export type SettlementModules = LndSettlementModule | XrpPaychanSettlementModule // TODO The actual type should have deposit defined!

export type SettlementModule<
  TSettlerType extends SettlementEngineType,
  /** Settlements engines */
  TSettlementEngine extends SettlementEngine,
  /** Credentials */
  TValidatedCredential extends ValidatedCredentials,
  TReadyCredential extends ReadyCredentials,
  /** Uplinks */
  // TODO Do the specific types for uplinks themselves actually matter, or is it really just the credential types?
  TBaseUplink extends BaseUplinks,
  TReadyUplink extends ReadyUplinks
> = {
  // TODO?
  settlerType: TSettlerType

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
  ) => (config: BaseUplinkConfig) => Promise<TBaseUplink>

  readonly deposit?: (
    uplink: TReadyUplink
  ) => (
    state: State
  ) => (opts: {
    amount: BigNumber
    authorize: AuthorizeDeposit
  }) => Promise<void>

  readonly withdraw?: (
    uplink: TReadyUplink
  ) => (state: State) => (authorize: AuthorizeWithdrawal) => Promise<void>
}

export const connect = async (ledgerEnv: LedgerEnv) => {
  let state: State = {
    ledgerEnv,
    rateBackend: await connectCoinCap(),
    maxInFlightUsd: usd(0.05),
    settlers: {},
    credentials: [],
    uplinks: []
  }

  // TODO Add functionality to connect existing uplinks based on config
  //      (unnecessary/backburner until persistence is added)

  // TODO Change the discriminant so it's all "SettlementEngineType" or the union
  const add = async <
    TSettlerType extends SettlementEngineType,
    /** Settlements engines */
    TSettlementEngine extends SettlementEngine,
    /** Credentials */
    TValidatedCredential extends ValidatedCredentials,
    TReadyCredential extends ReadyCredentials,
    /** Uplinks */
    TUplinkConfig extends BaseUplinkConfig
  >(
    // TODO Are these necessary?
    // TBaseUplink extends BaseUplinks,
    // TReadyUplink extends TBaseUplink & ReadyUplinks
    settlementModule: SettlementModule<
      TSettlerType,
      TSettlementEngine,
      TValidatedCredential,
      TReadyCredential,
      // TUplinkConfig,
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

    const config: BaseUplinkConfig = {
      // settlerType: SettlementEngineType.Lnd,
      settlerType, // TODO!
      stream: {
        serverSecret: await generateSecret()
      },
      plugin: {
        btp: {
          serverUri,
          authToken
        },
        store: {}
      }
    }

    const baseUplink = await settlementModule.connectUplink(state)(
      readyCredential
    )(config)
    const uplink = await connectUplink(state)(baseUplink)(config)
    state.uplinks.push(uplink)

    return uplink
  }

  const deposit = async ({
    uplink,
    ...opts
  }: {
    uplink: ReadyUplinks
    amount: BigNumber
    authorize: AuthorizeDeposit
  }): Promise<void> => {
    // Find the uplink in the internal state by its credentialId
    const internalUplink = state.uplinks.filter(
      someUplink =>
        someUplink.credentialId === uplink.credentialId &&
        someUplink.settlerType === uplink.settlerType
    )[0]
    if (!internalUplink) {
      return
    }

    const internalDeposit = (() => {
      switch (internalUplink.settlerType) {
        case SettlementEngineType.Lnd:
          return
        case SettlementEngineType.XrpPaychan:
          return XrpPaychan.deposit(internalUplink)
      }
    })()

    if (internalDeposit) {
      await internalDeposit(state)(opts)
    }
  }

  const withdraw = async ({
    uplink,
    authorize
  }: {
    uplink: ReadyUplinks
    authorize: AuthorizeWithdrawal
  }) => {
    // TODO
    const internalUplink = state.uplinks.filter(findUplinkPredicate(uplink))[0]
    if (!internalUplink) {
      return
    }

    const internalWithdraw = (() => {
      switch (internalUplink.settlerType) {
        case SettlementEngineType.Lnd:
          return
        case SettlementEngineType.XrpPaychan:
          return XrpPaychan.withdraw(internalUplink)
      }
    })()

    if (internalWithdraw) {
      await internalWithdraw(state)(authorize)
    }
  }

  // TODO Create a composite "id" for uplinks based on serverUri, settlerType & credentialId?

  const findUplinkPredicate = (uplink: ReadyUplinks) => (
    someUplink: ReadyUplinks
  ) =>
    someUplink.credentialId === uplink.credentialId &&
    someUplink.settlerType === uplink.settlerType

  const findCredentialPredicate = (credentialId: string) => (
    someCredential: ReadyCredentials
  ) => someCredential.settlerType === credential.settlerType
  // TODO TODO TODO Also check that the id of the credential is correct!

  const remove = async (uplink: ReadyUplinks) => {
    const internalUplink = state.uplinks.filter(findUplinkPredicate(uplink))[0]
    if (!internalUplink) {
      return
    }

    // Remove the uplink
    await closeUplink(internalUplink)
    state.uplinks = state.uplinks.filter(findUplinkPredicate(uplink))

    // Remove the credential
    // TODO Abstract this!
    const internalCredential = state.credentials.filter(
      findCredentialPredicate(internalUplink.credentialId)
    )[0]
    await closeCredential(internalCredential)

    // TODO Close engine, if there aren't any other credentials that rely on it
  }

  const closeCredential = (credential: ReadyCredentials) => {
    switch (credential.settlerType) {
      case SettlementEngineType.Lnd:
        return Lnd.closeCredential(credential)
      case SettlementEngineType.XrpPaychan:
        return XrpPaychan.closeCredential(credential)
    }
  }

  // TODO Add "closeEngine" to specific settlement modules
  const closeEngine = (settler: SettlementEngines) => {
    switch (settler.settlerType) {
      case SettlementEngineType.Lnd:
        return
      case SettlementEngineType.XrpPaychan:
        return
    }
  }

  const disconnect = async () => {
    await Promise.all(state.uplinks.map(closeUplink))
    await Promise.all(state.credentials.map(closeCredential))
    await Promise.all(
      Object.values(state.settlers)
        .filter((engine): engine is SettlementEngines => !!engine)
        .map(closeEngine)
    )
  }

  // TODO Should disconnecting the API prevent other operations from occuring?

  // TODO Export deposit, withdrawal, switch (etc)

  return {
    state,
    // TODO add & deposit; withdraw & remove are not bundled -- they can be invoked together from the front-end
    add,
    deposit,
    withdraw,
    remove,
    switch: streamMoney(state),
    disconnect
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
  | ValidatedLndCredential
  | ValidatedXrpSecret) &
  ValidatedCredential

export interface ReadyCredential {
  settlerType: SettlementEngineType // TODO
}

// TODO This needs to be a discriminated union in order to work correctly (e.g. settlerType within)
export type ReadyCredentials = (
  | ReadyLndCredential
  // | Machinomy.ReadyEthereumCredential
  | ReadyXrpCredential) &
  ReadyCredential

export interface State {
  readonly ledgerEnv: LedgerEnv
  readonly rateBackend: RateApi
  readonly maxInFlightUsd: AssetUnit
  settlers: {
    [SettlementEngineType.Lnd]?: LndSettlementEngine
    [SettlementEngineType.XrpPaychan]?: XrpPaychanSettlementEngine
  }
  credentials: ReadyCredentials[]
  uplinks: ReadyUplinks[]
}
