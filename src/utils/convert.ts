import BigNumber from 'bignumber.js'
import { createHmac } from 'crypto'

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

// TODO Move this somewhere else? Where is it used?
export const hmac = (key: string | Buffer, message: string | Buffer) =>
  createHmac('sha256', key)
    .update(message)
    .digest()
