import { serializeIlpReject } from 'ilp-packet'

/**
 * Only serialize error packets once
 */

// TODO Remove this?
export const APPLICATION_ERROR = {
  code: 'F99', // Generic application error
  message: '',
  triggeredBy: '',
  data: Buffer.alloc(0)
}

export const APPLICATION_ERROR_SERIALIZED = serializeIlpReject(
  APPLICATION_ERROR
)

export const UNREACHABLE_ERROR = {
  code: 'F02',
  message: '',
  triggeredBy: '',
  data: Buffer.alloc(0)
}

export const UNREACHABLE_ERROR_SERIALIZED = serializeIlpReject(
  UNREACHABLE_ERROR
)

// Intentionally don't send any identifying info here, per:
// https://github.com/interledgerjs/ilp-protocol-stream/commit/75b9dcd544cec1aa4d1cc357f300429af86736e4
export const defaultDataHandler = async () => UNREACHABLE_ERROR_SERIALIZED
export const defaultIlpPrepareHandler = async () => UNREACHABLE_ERROR

export const defaultMoneyHandler = async () => {
  throw new Error('no money handler registered')
}
