import { SettlementEngineType } from './engine'
import {
  ValidatedLndCredential,
  ReadyLndCredential,
  Lnd
} from './settlement/lnd'
import {
  UnvalidatedXrpSecret,
  ValidatedXrpSecret,
  XrpPaychan
} from './settlement/xrp-paychan'
import { State } from '.'
import {
  Machinomy,
  ReadyEthereumCredential,
  ValidatedEthereumPrivateKey
} from './settlement/machinomy'

export type CredentialConfigs = (
  | ValidatedLndCredential
  | ValidatedEthereumPrivateKey
  | UnvalidatedXrpSecret) & {
  settlerType: SettlementEngineType
}

export type ReadyCredentials = (
  | ReadyLndCredential
  | ReadyEthereumCredential
  | ValidatedXrpSecret) & {
  settlerType: SettlementEngineType
}

export const setupCredential = (credential: CredentialConfigs) => {
  switch (credential.settlerType) {
    case SettlementEngineType.Lnd:
      return Lnd.setupCredential(credential)
    case SettlementEngineType.Machinomy:
      return Machinomy.setupCredential(credential)
    case SettlementEngineType.XrpPaychan:
      return XrpPaychan.setupCredential(credential)
  }
}

// TODO Should this also check the settlerType of the credential? Or could there be a hash/unique id?
export const getCredential = (state: State) => <
  TReadyCredential extends ReadyCredentials
>(
  credentialId: string
) =>
  state.credentials.find(
    (someCredential): someCredential is TReadyCredential =>
      getCredentialId(someCredential) === credentialId
  )

export const getOrCreateCredential = (state: State) => async (
  credentialConfig: CredentialConfigs
): Promise<[ReadyCredentials, State]> => {
  const readyCredential = await setupCredential(credentialConfig)(state)
  const credentialId = getCredentialId(readyCredential)

  const existingCredential = state.credentials.filter(
    isThatCredentialId(credentialId, credentialConfig.settlerType)
  )[0]
  if (existingCredential) {
    await closeCredential(readyCredential)
    return [existingCredential, state]
  } else {
    const newState = {
      ...state,
      credentials: [...state.credentials, readyCredential]
    }
    return [readyCredential, newState]
  }
}

export const getCredentialId = (credential: ReadyCredentials) => {
  switch (credential.settlerType) {
    case SettlementEngineType.Lnd:
      return Lnd.uniqueId(credential)
    case SettlementEngineType.Machinomy:
      return Machinomy.uniqueId(credential)
    case SettlementEngineType.XrpPaychan:
      return XrpPaychan.uniqueId(credential)
  }
}

export const closeCredential = (credential: ReadyCredentials) => {
  switch (credential.settlerType) {
    case SettlementEngineType.Lnd:
      return Lnd.closeCredential(credential)
    case SettlementEngineType.Machinomy:
      return Machinomy.closeCredential(credential)
    case SettlementEngineType.XrpPaychan:
      return XrpPaychan.closeCredential(credential)
  }
}

export const isThatCredentialId = <TReadyCredential extends ReadyCredentials>(
  credentialId: string,
  settlerType: SettlementEngineType
) => (someCredential: ReadyCredentials): someCredential is TReadyCredential =>
  someCredential.settlerType === settlerType &&
  getCredentialId(someCredential) === credentialId

export const isThatCredential = <TReadyCredential extends ReadyCredentials>(
  credential: ReadyCredentials
) => (someCredential: ReadyCredentials): someCredential is TReadyCredential =>
  someCredential.settlerType === credential.settlerType &&
  getCredentialId(someCredential) === getCredentialId(credential)
