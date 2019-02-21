import {
  AssetUnit,
  RateApi,
  connectCoinCap,
  usd
} from '@kava-labs/crypto-rate-utils'
import {
  BaseUplinkConfig,
  AuthorizeDeposit,
  AuthorizeWithdrawal,
  BaseUplinks,
  ReadyUplinks,
  closeUplink,
  depositToUplink,
  isThatUplink,
  withdrawFromUplink,
  createUplink
} from './uplink'
import {
  closeEngine,
  SettlementEngineType,
  SettlementEngine,
  SettlementEngines,
  createEngine
} from './engine'
import { LndSettlementModule, LndSettlementEngine } from './settlement/lnd'
import {
  XrpPaychanSettlementModule,
  XrpPaychanSettlementEngine
} from './settlement/xrp-paychan'
import { streamMoney } from './services/switch'
import BigNumber from 'bignumber.js'
import {
  ReadyCredentials,
  getOrCreateCredential,
  closeCredential,
  isThatCredentialId,
  CredentialConfigs
} from './credential'
import { MachinomySettlementEngine } from 'settlement/machinomy'

export type SettlementModules = LndSettlementModule | XrpPaychanSettlementModule

// TODO Is this really necessarily, or could I rename them all to, e.g., "setupXrpCredential" ?
export type SettlementModule<
  TSettlerType extends SettlementEngineType,
  /** Settlements engines */
  TSettlementEngine extends SettlementEngine,
  /** Credentials */
  TValidatedCredential extends CredentialConfigs,
  TReadyCredential extends ReadyCredentials,
  /** Uplinks */
  // TODO Do the specific types for uplinks themselves actually matter, or is it really just the credential types?
  TBaseUplink extends BaseUplinks,
  TReadyUplink extends ReadyUplinks
> = {
  // settlerType: TSettlerType
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
    cred: TReadyCredential
  ) => (state: State) => (config: BaseUplinkConfig) => Promise<TBaseUplink>
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

export const connect = async (ledgerEnv: LedgerEnv = LedgerEnv.Testnet) => {
  let state: State = {
    ledgerEnv,
    rateBackend: await connectCoinCap(),
    maxInFlightUsd: usd(0.1),
    settlers: {
      // TODO Fix the settlement engine creation ... this is bad
      [SettlementEngineType.Lnd]: await createEngine(ledgerEnv)(
        SettlementEngineType.Lnd
      ),
      [SettlementEngineType.Machinomy]: (await createEngine(ledgerEnv)(
        SettlementEngineType.Machinomy
      )) as MachinomySettlementEngine,
      [SettlementEngineType.XrpPaychan]: (await createEngine(ledgerEnv)(
        SettlementEngineType.XrpPaychan
      )) as XrpPaychanSettlementEngine
    },
    credentials: [],
    uplinks: []
  }

  // TODO Add functionality to connect existing uplinks based on config
  //      (unnecessary/backburner until persistence is added)

  const add = async (
    credentialConfig: CredentialConfigs
  ): Promise<ReadyUplinks> => {
    const readyCredential = await getOrCreateCredential(state)(credentialConfig)
    const readyUplink = await createUplink(state)(readyCredential)
    state.uplinks = [...state.uplinks, readyUplink] // TODO What if the uplink is a duplicate? (throws?)
    return readyUplink
  }

  const deposit = async ({
    uplink,
    ...opts
  }: {
    uplink: ReadyUplinks
    amount: BigNumber
    authorize: AuthorizeDeposit
  }): Promise<void> => {
    const internalUplink = state.uplinks.filter(isThatUplink(uplink))[0]
    const internalDeposit = depositToUplink(internalUplink)
    return internalDeposit && internalDeposit(state)(opts)
  }

  const withdraw = async ({
    uplink,
    authorize
  }: {
    uplink: ReadyUplinks
    authorize: AuthorizeWithdrawal
  }) => {
    const internalUplink = state.uplinks.filter(isThatUplink(uplink))[0]
    const internalWithdraw = withdrawFromUplink(internalUplink)
    return internalWithdraw && internalWithdraw(state)(authorize)
  }

  // TODO Create a composite "id" for uplinks based on serverUri, settlerType & credentialId?

  const remove = async (uplink: ReadyUplinks) => {
    // Remove the uplink
    const internalUplink = state.uplinks.find(isThatUplink(uplink))
    if (!internalUplink) {
      return
    }
    await closeUplink(internalUplink)
    state.uplinks = state.uplinks.filter(el => !isThatUplink(uplink)(el))

    // Remove the credential
    const credentials = state.credentials.filter(
      isThatCredentialId(internalUplink.credentialId, uplink.settlerType)
    )
    await Promise.all(credentials.map(closeCredential))
    state.credentials = state.credentials.filter(c => !credentials.includes(c))

    // TODO Close engine, if there aren't any other credentials that rely on it
  }

  const disconnect = async () => {
    await Promise.all(state.uplinks.map(closeUplink))
    await Promise.all(state.credentials.map(closeCredential))
    await Promise.all(
      Object.values(state.settlers)
        .filter((a): a is SettlementEngines => !!a) // TODO !
        .map(closeEngine)
    )
  }

  // TODO Should disconnecting the API prevent other operations from occuring? (they may not work anyways)

  return {
    state,
    add,
    deposit,
    withdraw,
    remove,
    streamMoney: streamMoney(state),
    disconnect
  }
}

type ThenArg<T> = T extends Promise<infer U> ? U : T
export type SwitchApi = ThenArg<ReturnType<typeof connect>>

export enum LedgerEnv {
  Mainnet = 'mainnet',
  Testnet = 'testnet',
  Local = 'local'
}

export { SettlementEngineType, ReadyUplinks }

export interface State {
  readonly ledgerEnv: LedgerEnv
  readonly rateBackend: RateApi
  readonly maxInFlightUsd: AssetUnit
  // TODO Is this simpler as an array and filter? Hard to get the types right
  settlers: {
    // [settlerType: keyof typeof SettlementEngineType]: SettlementEngines
    [SettlementEngineType.Lnd]: LndSettlementEngine
    [SettlementEngineType.Machinomy]: MachinomySettlementEngine
    [SettlementEngineType.XrpPaychan]: XrpPaychanSettlementEngine
  }
  credentials: ReadyCredentials[]
  uplinks: ReadyUplinks[]
}
