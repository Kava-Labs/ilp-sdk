import BigNumber from 'bignumber.js'
import { createHmac, randomBytes } from 'crypto'
import { promisify } from 'util'

export enum IUnit {
  // Ether
  Eth = 18,
  Gwei = 9,
  Wei = 0,

  // Bitcoin
  Btc = 9,
  Satoshi = 0,

  // XRP
  Xrp = 6,
  Drop = 0,
  XrpBase = -3
}

export const convert = (
  num: BigNumber.Value,
  from: IUnit,
  to: IUnit
): BigNumber => new BigNumber(num).shiftedBy(from - to)

// TODO make this a more generic utils file

export const hmac = (key: string | Buffer, message: string | Buffer) =>
  createHmac('sha256', key)
    .update(message)
    .digest()

// TODO rename this, or add "btp+wss://" in connector list?
// TODO allow both random and non-random secrets
export const serverUri = async (hostPort: string) =>
  `btp+wss://:${base64url(await promisify(randomBytes)(32))}@${hostPort}`

export const base64url = (buf: Buffer) =>
  buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
