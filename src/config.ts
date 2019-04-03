import { LedgerEnv, State } from '.'
import { CredentialConfigs, credentialToConfig } from './credential'
import { BaseUplinkConfig } from './uplink'
import { open, readFile, writeFile, mkdir, ftruncate } from 'fs'
import { promisify } from 'util'
import { homedir } from 'os'
// import { hash, verify, argon2id } from 'argon2'
// import { randomBytes, createCipheriv } from 'crypto'

// TODO Basic versioning?
// TODO Use ConfigSchema[] to enable testnet + mainnet configs?

export interface ConfigSchema {
  readonly ledgerEnv: LedgerEnv
  readonly credentials: CredentialConfigs[]
  readonly uplinks: BaseUplinkConfig[]
}

const CONFIG_DIR = `${homedir()}/.switch`
export const CONFIG_PATH = `${CONFIG_DIR}/config.json`

export const serializeConfig = (state: State) =>
  JSON.stringify({
    ledgerEnv: state.ledgerEnv,
    uplinks: state.uplinks.map(uplink => uplink.config),
    credentials: state.credentials.map(credentialToConfig)
  })

export const persistConfig = async (fileDescriptor: number, state: State) => {
  await promisify(ftruncate)(fileDescriptor) // r+ mode doesn't overwrite, so first delete file contents
  await promisify(writeFile)(fileDescriptor, serializeConfig(state))
}

/**
 * - Opening the file in "w+" mode truncates/deletes the existing content
 * - Opening the file in "a+" mode doesn't work on Linux, since positional writes are ignored
 *   when the file is opened in append mode, and won't replace the existing content
 * - Opening the file in "r+" mode allows reading and writing, but fails if the file doesn't
 *   exist (race condition). More importantly, it doesn't allow truncating/deleting the file
 */
export const loadConfig = async (): Promise<
  [number, ConfigSchema | undefined]
> => {
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

  // TODO Add *robust* schema validation
  return [
    fileDescriptor,
    content.length === 0 ? undefined : JSON.parse(content)
  ]
}

/**
 * ------------------------------------
 * ENCRYPTION
 * ------------------------------------
 */

/*
const ENCRYPTION_ALGORITHM = 'aes-256-gcm'
const ENCRYPTION_ENCODING = 'utf-8'

const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

const createOutput = async (
  plaintext: string,
  salt: string,
  iv: string
) => ({
  // TODO Should this also include algorithm-related info? argon2id, iteration count, etc?

  salt,
  iv: (await generateSalt()).toString(),
  ciphertext: (await encryptConfig(plaintext)).toString()
})

// TODO the salt should be passed in here
const encryptConfig = async (config: string): Promise<Buffer> => {
  const encryptionKey = await deriveEncryptionKey(password, salt)

  const iv = await randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, encryptionKey, iv)
  const ciphertext = cipher.update(Buffer.from(config))
  return Buffer.concat([ciphertext, cipher.final()])
}

const decryptConfig = async (ciperText: string) => {}

// TODO Salt should be created separately
const deriveEncryptionKey = async (
  password: string,
  salt?: string
): Promise<string> =>
  hash(password, {
    type: argon2id,
    salt: salt ? Buffer.from(salt, 'hex') : await generateSalt()
  })

const generateSalt = (): Promise<Buffer> => promisify(randomBytes)(16)
*/
