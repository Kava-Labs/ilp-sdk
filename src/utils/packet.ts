import { serializeIlpReject } from 'ilp-packet'

const UNREACHABLE_ERROR = {
  code: 'F02',
  message: '',
  triggeredBy: '',
  data: Buffer.alloc(0)
}

// TODO Don't send additional identifying info, per the below, or update to include clientAddress and useful debug info?
// https://github.com/interledgerjs/ilp-protocol-stream/commit/75b9dcd544cec1aa4d1cc357f300429af86736e4

export const defaultDataHandler = async () =>
  serializeIlpReject(UNREACHABLE_ERROR)
export const defaultIlpPrepareHandler = async () => UNREACHABLE_ERROR

export const defaultMoneyHandler = async () => {
  throw new Error('no money handler registered')
}
