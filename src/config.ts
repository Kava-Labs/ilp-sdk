import { LedgerEnv, State } from '.'
import { CredentialConfigs, credentialToConfig } from './credential'
import { BaseUplinkConfig } from './uplink'
import { open, readFile, writeFile, mkdir, ftruncate } from 'fs'
import { promisify } from 'util'
import { homedir } from 'os'
import { generateEncryptionKey, decrypt } from 'symmetric-encrypt'

export interface ConfigSchema {
  readonly credentials: CredentialConfigs[]
  readonly uplinks: BaseUplinkConfig[]
}

export type MultiConfigSchema = {
  readonly [LedgerEnv.Mainnet]?: ConfigSchema
  readonly [LedgerEnv.Testnet]?: ConfigSchema
  readonly [LedgerEnv.Local]?: ConfigSchema
}

const CONFIG_DIR = `${homedir()}/.switch`
export const CONFIG_PATH = `${CONFIG_DIR}/config.json`

export const loadConfig = async (
  password?: string
): Promise<[number, MultiConfigSchema]> => {
  const [descriptor, contents] = await loadFile()

  // TODO Add stronger schema validation!

  if (contents.length === 0) {
    return [descriptor, {}]
  }

  const parsed = JSON.parse(contents)

  // Handle v0.3-0.4 configs, supporting only a single environment
  if (parsed.ledgerEnv) {
    return [
      descriptor,
      {
        [parsed.ledgerEnv]: parsed
      }
    ]
  }
  // Handle encrypted, multi-environment configs
  else if (parsed.ciphertext) {
    if (!password) {
      throw new Error('Config requires a password to decrypt')
    }

    const decrypted = await decrypt(password, parsed)
    return [descriptor, JSON.parse(decrypted)]
  }
  // Handle unencrypted, multi-environment configs
  else {
    return [descriptor, parsed]
  }
}

/**
 * - Opening the file in "w+" mode truncates/deletes the existing content
 * - Opening the file in "a+" mode doesn't work on Linux, since positional writes are ignored
 *   when the file is opened in append mode, and won't replace the existing content
 * - Opening the file in "r+" mode allows reading and writing, but fails if the file doesn't
 *   exist (race condition). More importantly, it doesn't allow truncating/deleting the file
 */
export const loadFile = async (): Promise<[number, string]> => {
  await promisify(mkdir)(CONFIG_DIR).catch(err => {
    if (err.code === 'EEXIST') return
    else throw err
  })

  const fileDescriptor = await promisify(open)(CONFIG_PATH, 'r+').catch(err => {
    if (err.code === 'ENOENT') {
      return promisify(open)(CONFIG_PATH, 'w+')
    } else {
      throw err
    }
  })

  const content = await promisify(readFile)(fileDescriptor, {
    encoding: 'utf8'
  })

  return [fileDescriptor, content]
}

export const serializeConfig = (state: State) => ({
  [state.ledgerEnv]: {
    uplinks: state.uplinks.map(uplink => uplink.config),
    credentials: state.credentials.map(credentialToConfig)
  }
})

export const prepareEncryption = async (
  fileDescriptor: number,
  password?: string
): Promise<(contents: string) => Promise<void>> => {
  const encrypt = password ? await generateEncryptionKey(password) : undefined

  return async (contents: string) => {
    const parsedContents = encrypt
      ? JSON.stringify(await encrypt(contents))
      : contents

    await promisify(ftruncate)(fileDescriptor) // r+ mode doesn't overwrite, so first delete file contents
    await promisify(writeFile)(fileDescriptor, parsedContents)
  }
}
