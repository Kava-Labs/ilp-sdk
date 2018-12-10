import { serializeIlpReject } from 'ilp-packet'
import { IDataHandler } from './types'

// Only serialize error packets once

export const APPLICATION_ERROR = serializeIlpReject({
  code: 'F99', // Generic application error
  message: '',
  triggeredBy: '',
  data: Buffer.alloc(0)
})

export const UNREACHABLE_ERROR = serializeIlpReject({
  code: 'F02', // Unreachable
  message: '',
  triggeredBy: '',
  data: Buffer.alloc(0)
})

// Intentionally don't send any identifying info here, per:
// https://github.com/interledgerjs/ilp-protocol-stream/commit/75b9dcd544cec1aa4d1cc357f300429af86736e4
export const defaultDataHandler = async () => UNREACHABLE_ERROR
