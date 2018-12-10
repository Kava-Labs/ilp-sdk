import { createHash, createHmac, randomBytes } from 'crypto'
import { promisify } from 'util'

export const hmac = (key: string | Buffer, message: string | Buffer) =>
  createHmac('sha256', key)
    .update(message)
    .digest()

export const sha256 = (preimage: string | Buffer) =>
  createHash('sha256')
    .update(preimage)
    .digest()

// Use the async version to prevent blocking the event loop:
// https://nodejs.org/en/docs/guides/dont-block-the-event-loop/#blocking-the-event-loop-node-core-modules
export const generateSecret = () => promisify(randomBytes)(32)

export const base64url = (buffer: Buffer) =>
  buffer
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')

export const generateToken = async () => base64url(await generateSecret())
