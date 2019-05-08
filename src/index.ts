import {
  AssetUnit,
  connectCoinCap,
  RateApi,
  usd
} from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import {
  closeCredential,
  CredentialConfigs,
  credentialToConfig,
  getCredential,
  getOrCreateCredential,
  isThatCredentialId,
  ReadyCredentials,
  setupCredential
} from './credential'
import { closeEngine, SettlementEngineType } from './engine'
import { streamMoney } from './services/switch'
import { Lnd, LndSettlementEngine } from './settlement/lnd'
import { Machinomy, MachinomySettlementEngine } from './settlement/machinomy'
import {
  XrpPaychan,
  XrpPaychanSettlementEngine
} from './settlement/xrp-paychan'
import {
  AuthorizeDeposit,
  AuthorizeWithdrawal,
  BaseUplinkConfig,
  closeUplink,
  connectUplink,
  createUplink,
  depositToUplink,
  getBaseBalance,
  isThatUplink,
  ReadyUplinks,
  withdrawFromUplink
} from './uplink'

type ThenArg<T> = T extends Promise<infer U> ? U : T
export type IlpSdk = ThenArg<ReturnType<typeof connect>>

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
  readonly settlers: {
    // [settlerType: keyof typeof SettlementEngineType]: SettlementEngines
    readonly [SettlementEngineType.Lnd]: LndSettlementEngine
    readonly [SettlementEngineType.Machinomy]: MachinomySettlementEngine
    readonly [SettlementEngineType.XrpPaychan]: XrpPaychanSettlementEngine
  }
  /* tslint:disable-next-line:readonly-keyword TODO */
  credentials: ReadyCredentials[]
  /* tslint:disable-next-line:readonly-keyword TODO */
  uplinks: ReadyUplinks[]
}

export interface ConfigSchema {
  readonly credentials: CredentialConfigs[]
  readonly uplinks: BaseUplinkConfig[]
}

export const connect = async (
  ledgerEnv: LedgerEnv = LedgerEnv.Testnet,
  config?: ConfigSchema
) => {
  const state: State = {
    ledgerEnv,
    rateBackend: await connectCoinCap(),
    maxInFlightUsd: usd(0.1),
    settlers: {
      [SettlementEngineType.Lnd]: await Lnd.setupEngine(ledgerEnv),
      [SettlementEngineType.Machinomy]: await Machinomy.setupEngine(ledgerEnv),
      [SettlementEngineType.XrpPaychan]: await XrpPaychan.setupEngine(ledgerEnv)
    },
    credentials: [],
    uplinks: []
  }

  if (config) {
    state.credentials = await Promise.all<ReadyCredentials>(
      config.credentials.map(cred => setupCredential(cred)(state))
    )

    // TODO Handle error cases if the uplinks fail to connect
    state.uplinks = await Promise.all(
      config.uplinks.map(uplinkConfig => {
        // TODO What if, for some reason, the credential doesn't exist?
        const cred = getCredential(state)(uplinkConfig.credentialId)
        return connectUplink(state)(cred!)(uplinkConfig)
      })
    )
  }

  // TODO Create a composite "id" for uplinks based on serverUri, settlerType & credentialId?

  return {
    state,

    async add(credentialConfig: CredentialConfigs): Promise<ReadyUplinks> {
      const readyCredential = await getOrCreateCredential(state)(
        credentialConfig
      )
      const readyUplink = await createUplink(state)(readyCredential)
      state.uplinks = [...state.uplinks, readyUplink] // TODO What if the uplink is a duplicate? (throws?)
      return readyUplink
    },

    async deposit({
      uplink,
      amount,
      authorize = () => Promise.resolve()
    }: {
      readonly uplink: ReadyUplinks
      readonly amount: BigNumber
      readonly authorize?: AuthorizeDeposit
    }): Promise<void> {
      const internalUplink = state.uplinks.filter(isThatUplink(uplink))[0]
      const internalDeposit = depositToUplink(internalUplink)
      return (
        internalDeposit &&
        internalDeposit(state)({
          amount,
          authorize
        })
      )
    },

    async withdraw({
      uplink,
      authorize = () => Promise.resolve()
    }: {
      readonly uplink: ReadyUplinks
      readonly authorize?: AuthorizeWithdrawal
    }): Promise<void> {
      const internalUplink = state.uplinks.filter(isThatUplink(uplink))[0]
      const internalWithdraw = withdrawFromUplink(internalUplink)
      if (internalWithdraw) {
        const checkWithdraw = () =>
          internalUplink.totalReceived$.value.isZero() &&
          internalUplink.totalSent$.value.isZero()
            ? Promise.resolve()
            : Promise.reject()

        return internalWithdraw(authorize).then(checkWithdraw, checkWithdraw)
      }
    },

    async remove(uplink: ReadyUplinks): Promise<void> {
      // Remove the uplink
      const internalUplink = state.uplinks.find(isThatUplink(uplink))
      if (!internalUplink) {
        return
      }
      await closeUplink(internalUplink)
      state.uplinks = state.uplinks.filter(el => !isThatUplink(uplink)(el))

      // Remove the credential
      const credentialsToClose = state.credentials.filter(
        isThatCredentialId(internalUplink.credentialId, uplink.settlerType)
      )
      await Promise.all(credentialsToClose.map(closeCredential))

      state.credentials = state.credentials.filter(
        someCredential => !credentialsToClose.includes(someCredential)
      )
    },

    streamMoney: streamMoney(state),

    getBaseBalance: getBaseBalance(state),

    serializeConfig(): ConfigSchema {
      return {
        uplinks: this.state.uplinks.map(uplink => uplink.config),
        credentials: this.state.credentials.map(credentialToConfig)
      }
    },

    // TODO Should disconnecting the API prevent other operations from occuring? (they may not work anyways)
    async disconnect(): Promise<void> {
      await Promise.all(state.uplinks.map(closeUplink))
      await Promise.all(state.credentials.map(closeCredential))
      await Promise.all(Object.values(state.settlers).map(closeEngine))
    }
  }
}
