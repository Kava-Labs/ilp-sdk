import { SettlementEngineType } from './engine'
import {
  ValidatedLndCredential,
  ReadyLndCredential,
  Lnd,
  configFromLndCredential
} from './settlement/lnd'
import {
  UnvalidatedXrpSecret,
  ValidatedXrpSecret,
  XrpPaychan,
  configFromXrpCredential
} from './settlement/xrp-paychan'
import { State } from '.'
import {
  Machinomy,
  ReadyEthereumCredential,
  ValidatedEthereumPrivateKey,
  configFromEthereumCredential
} from './settlement/machinomy'

export type CredentialConfigs = (
  | ValidatedLndCredential
  | ValidatedEthereumPrivateKey
  | UnvalidatedXrpSecret) & {
  readonly settlerType: SettlementEngineType
}

export type ReadyCredentials = (
  | ReadyLndCredential
  | ReadyEthereumCredential
  | ValidatedXrpSecret) & {
  readonly settlerType: SettlementEngineType
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

// TODO Should this also check the settlerType of the credential? Or could there be a hash/uniqueId?
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
): Promise<ReadyCredentials> => {
  const readyCredential = await setupCredential(credentialConfig)(state)
  const credentialId = getCredentialId(readyCredential)

  const existingCredential = state.credentials.filter(
    isThatCredentialId(credentialId, credentialConfig.settlerType)
  )[0]
  if (existingCredential) {
    await closeCredential(readyCredential)
    return existingCredential
  } else {
    state.credentials = [...state.credentials, readyCredential]
    return readyCredential
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

export const closeCredential = async (credential: ReadyCredentials) => {
  switch (credential.settlerType) {
    case SettlementEngineType.Lnd:
      return Lnd.closeCredential(credential)
    case SettlementEngineType.Machinomy:
      return
    case SettlementEngineType.XrpPaychan:
      return
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

export const credentialToConfig = (
  credential: ReadyCredentials
): CredentialConfigs => {
  switch (credential.settlerType) {
    case SettlementEngineType.Lnd:
      return configFromLndCredential(credential)
    case SettlementEngineType.Machinomy:
      return configFromEthereumCredential(credential)
    case SettlementEngineType.XrpPaychan:
      return configFromXrpCredential(credential)
  }
}
