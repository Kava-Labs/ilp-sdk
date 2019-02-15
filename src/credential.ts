import { SettlementEngineType } from './engine'
import {
  ValidatedLndCredential,
  ReadyLndCredential,
  Lnd
} from './settlement/lnd/lnd'
import {
  ValidatedXrpSecret,
  ReadyXrpCredential,
  XrpPaychan
} from './settlement/xrp-paychan/xrp-paychan'
import { State } from 'index'

export type ValidatedCredentials = (
  | ValidatedLndCredential
  | ValidatedXrpSecret) & {
  settlerType: SettlementEngineType
}

export type ReadyCredentials = (ReadyLndCredential | ReadyXrpCredential) & {
  settlerType: SettlementEngineType
}

export const setupCredential = (credential: ValidatedCredentials) => {
  switch (credential.settlerType) {
    case SettlementEngineType.Lnd:
      return Lnd.setupCredential(credential)
    case SettlementEngineType.XrpPaychan:
      return XrpPaychan.setupCredential(credential)
  }
}

export const getOrCreateCredential = (state: State) => async (
  credentialConfig: ValidatedCredentials
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
    case SettlementEngineType.XrpPaychan:
      return XrpPaychan.uniqueId(credential)
  }
}

export const closeCredential = (credential: ReadyCredentials) => {
  switch (credential.settlerType) {
    case SettlementEngineType.Lnd:
      return Lnd.closeCredential(credential)
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

export const isThatCredential = (credential: ReadyCredentials) => (
  someCredential: ReadyCredentials
) =>
  someCredential.settlerType === credential.settlerType &&
  getCredentialId(someCredential) === getCredentialId(credential)
