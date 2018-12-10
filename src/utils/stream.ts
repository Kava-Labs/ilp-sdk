import BigNumber from 'bignumber.js'
import { IlpReply, isFulfill, isReject } from 'ilp-packet'
import { Reader } from 'oer-utils'
import { Ledger } from '..'
import { generateSecret, sha256 } from './crypto'
// import {
//   APPLICATION_ERROR,
//   defaultDataHandler,
//   UNREACHABLE_ERROR
// } from './packet'

import createLogger from 'ilp-logger'
const log = createLogger('switch-api:stream')

/** End stream if no packets are successfully fulfilled within this interval */
const IDLE_TIMEOUT = 30000

/** Interval between sending each packet in flight */
const INFLIGHT_DELAY = 5 // TODO?

/** Amount of time in the future when packets should expire */
const EXPIRATION_WINDOW = 10000

// TODO Should this be the default money handler? Do we want to log that we got a packet every time?
// (e.g. what if someone is DoS us? then, it might be useful! or bad?)
const throwUnreachable = () => {
  log.error(`rejecting packet with unrecognized condition`)
  return {
    code: 'F02', // Unreachable
    message: '',
    triggeredBy: '',
    data: Buffer.alloc(0)
  }
}

export interface IStreamMoneyOpts {
  /**
   * Send assets via the given source ledger/plugin
   * - Plugin must be connected
   */
  source: Ledger
  /**
   * Receive assets via the given destination ledger/plugin
   * - Plugin must be connected
   */
  dest: Ledger
  /**
   * Given an exchange rate for a PREPARE packet, determine if it should be fulfilled
   * - Track amount sent and amount fulfilled in order to stop streaming
   * - Calculate per-packet exchange rate to ensure it doesn't drop too low
   */
  shouldFulfill: (sourceAmount: BigNumber, destAmount: BigNumber) => boolean
  /**
   * Determine the amount of the subsequent packet to send
   * - If 0 is returned, the stream will end
   * - Allows for a precise amount to be sent (rather than only multiples
   *   of the max packet amount)
   */
  nextPacketAmount: (maxPacketAmount: BigNumber) => BigNumber
}

// TODO add try-catch(es) to handle errors?

// TODO Should I refactor this as a while loop or recursive function?

/**
 * Why no test packets?
 * 1) While sending BIG packets provide a more precise exchange rate,
 *    if we lose that precision with normal-sized packets due to rounding
 *    anyways, it doesn't matter!
 * 2) Default packet size is reasonable and compatible with prefund amount
 * 3) Packet size will automatically be reduced as F08 errors are encountered
 * 4) We assume the connector extends 0 credit
 */

export const streamMoney = ({
  source,
  dest,
  shouldFulfill,
  nextPacketAmount
}: IStreamMoneyOpts): Promise<void> =>
  new Promise(resolve => {
    log.debug(
      `starting streaming exchange from ${source.assetCode} -> ${
        dest.assetCode
      }`
    )

    // TODO Rename to "nextPacketAmount" ? Different from sourceAmount, which is scoped to a single packet
    let packetAmount = source.maxInFlight

    // TODO This will get larger and larger over time -- that's bad
    // Handle packets sent to the destination plugin
    const handlers: {
      [executionCondition: string]: (destAmount: BigNumber) => IlpReply
    } = {}
    dest.registerDataHandler(async ({ executionCondition, amount }) => {
      const handlePrepare = handlers[executionCondition.toString('hex')]
      return handlePrepare
        ? handlePrepare(new BigNumber(amount))
        : throwUnreachable()
    })

    let idleTimer: NodeJS.Timeout
    let streamer: NodeJS.Timeout

    const endStream = () => {
      // Don't send any more packets
      clearInterval(streamer)
      // Remove idle timer
      clearTimeout(idleTimer)
      // Remove handler & reject any subsequent packets that are already in flight
      dest.registerDataHandler(async () => ({
        code: 'F02', // Unreachable
        message: '',
        triggeredBy: '',
        data: Buffer.alloc(0)
      }))

      log.debug(`stream ended. ${packetCount} packets sent`)
      resolve()
    }

    // Setup idle timer to automatically end the stream if no packets are getting through
    const bumpIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(endStream, IDLE_TIMEOUT)
    }
    bumpIdle()

    /**
     * Sent packets at a regular interval to keep as many in flight as possible
     * - After a settlement is credited, the waiting time until the next packet
     *   is forwarded *should* be less than the sending interval (5ms)
     * - If sending packets one at a time, that waiting time can be as high
     *   as the roundtrip latency between two nodes (100+ ms)
     */
    let packetCount = 0
    streamer = setInterval(async () => {
      const sourceAmount = nextPacketAmount(packetAmount)
      if (sourceAmount.lte(0)) {
        return endStream()
      }

      const packetNum = (packetCount += 1)
      const fulfillment = await generateSecret()
      const executionCondition = sha256(fulfillment)

      // Setup a handler to fulfill this specific packet
      const handlePrepare = (destAmount: BigNumber): IlpReply =>
        shouldFulfill(sourceAmount, destAmount)
          ? {
              fulfillment,
              data: Buffer.alloc(0)
            }
          : {
              code: 'F99', // Generic application error
              message: '',
              triggeredBy: '',
              data: Buffer.alloc(0)
            }
      handlers[executionCondition.toString('hex')] = handlePrepare

      log.debug(`sending packet ${packetNum} for ${sourceAmount}`)
      const response = await source.sendData({
        destination: dest.clientAddress,
        amount: sourceAmount.toString(),
        executionCondition,
        data: Buffer.alloc(0),
        expiresAt: new Date(Date.now() + EXPIRATION_WINDOW)
      })

      // Remove handler after a response is returned (e.g. if rejected)
      delete handlers[executionCondition.toString('hex')]

      if (isReject(response)) {
        const { code, data } = response
        log.debug(`packet ${packetNum} rejected with ${code}`)

        // Handle "amount too large" errors
        if (code === 'F08') {
          const reader = Reader.from(data)
          // TODO This is slow. Try to find a faster way?
          const foreignReceivedAmount = reader.readUInt64BigNum()
          const foreignMaxPacketAmount = reader.readUInt64BigNum()

          /**
           * Since the data in the reject are in units we're not familiar with,
           * we can determine the exchange rate via (source amount / dest amount),
           * then convert the foreign max packet amount into native units
           */
          const maxPacketAmount = sourceAmount
            .times(foreignMaxPacketAmount)
            .dividedToIntegerBy(foreignReceivedAmount)

          // As we encounter more F08s, max packet amount should never increase!
          if (maxPacketAmount.gte(sourceAmount)) {
            log.error(
              'unexpected amount too large error: sent less than the max packet amount'
            )
          } else if (maxPacketAmount.lt(packetAmount)) {
            log.debug(
              `reducing packet amount from ${packetAmount} to ${maxPacketAmount}`
            )
            packetAmount = maxPacketAmount
          }
        }
      } else if (isFulfill(response)) {
        log.debug(
          `packet ${packetNum} fulfilled for source amount ${sourceAmount}`
        )
        bumpIdle()
      }
    }, INFLIGHT_DELAY)
  })
