import { convert } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import { IlpFulfill, isFulfill, isReject } from 'ilp-packet'
import { Uplink } from '../uplink'
import { Reader } from 'oer-utils'
import { generateSecret, sha256 } from '../utils/crypto'
import createLogger from '../utils/log'
import { APPLICATION_ERROR } from '../utils/packet'

const log = createLogger('switch-api:stream')

/** End stream if no packets are successfully fulfilled within this interval */
const IDLE_TIMEOUT = 10000

/** Amount of time in the future when packets should expire */
const EXPIRATION_WINDOW = 2000

export interface StreamMoneyOpts {
  /** Amount of money to be sent over stream, in units of exchange */
  amount: BigNumber
  /** Send assets via the given source ledger/plugin */
  source: Uplink
  /** Receive assets via the given destination ledger/plugin */
  dest: Uplink
  /**
   * Maximum percentage of slippage allowed. If the per-packet exchange rate
   * drops below the price oracle's rate minus this slippage,
   * the packet will be rejected
   */
  slippage?: BigNumber.Value
}

/**
 * TODO ALL THE DEPENDENCIES
 *
 * SOURCE UPLINK:
 * - asset code
 * - asset scale / exchangeUnit / baseUnit
 * - availableCredit
 * - sendPacket() => (requires plugin)
 *
 * DEST UPLINK:
 * - asset code
 * - base unit
 * - registerPacketHandler() => (requires plugin)
 *    - sets streamClientHandler within closure for connecting uplink
 *           - Alternative: registerPacketHandler(uplink) =>
 *                  Internally, deregisters the root plugin packet handler, and then re-registers it with the new one?
 *                  The stream client/server handlers would be properties on the Uplink data structure
 * - clientAddress
 */

export const streamMoney = async ({
  amount,
  source,
  dest,
  slippage = 0.01
}: StreamMoneyOpts): Promise<void> => {
  // TODO Add guards to throw error if there's insufficient capacity!
  // Weird cases to handle though: streaming credit off of connector & sending packet to open eth channel

  const amountToSend = convert(source.exchangeUnit(amount), source.baseUnit())

  /**
   * Why no test packets?
   * 1) While sending BIG packets provide a more precise exchange rate,
   *    if we lose that precision with normal-sized packets due to rounding
   *    anyways, it doesn't matter!
   * 2) Default packet size is based on prefund amount/credit with connector
   * 3) Packet size will automatically be reduced as F08 errors are encountered
   * 4) We assume the connector extends 0 credit
   *
   * But what about getting the exchange rate?
   * - We'd rather hold the connector's rate accountable to our
   *   own price oracle, rather than simply getting a quote from the
   *   connector and ensuring it stays consistent (like in Stream).
   * - So, we compare the exchange rate of each packet to our price oracle,
   *   and use that to determine whether to fulfill it.
   */

  log.debug(
    `starting streaming exchange from ${source.assetCode} -> ${dest.assetCode}`
  )

  // If no packets get through for 10 seconds, kill the stream
  let timeout: number
  const bumpIdle = () => {
    timeout = Date.now() + IDLE_TIMEOUT
  }
  bumpIdle()

  let prepareCount = 0
  let fulfillCount = 0
  let totalFulfilled = new BigNumber(0)
  let maxPacketAmount = new BigNumber(Infinity)

  const sendPacket = async (): Promise<void> => {
    const isFailing = Date.now() > timeout
    if (isFailing) {
      log.error('stream timed out: no packets fulfilled within idle window.')
      throw new Error() // Stream failed
    }

    const remainingAmount = amountToSend.minus(totalFulfilled)
    if (remainingAmount.lte(0)) {
      return // Stream ended successfully
    }

    if (source.availableCredit.lte(0)) {
      await new Promise(r => setTimeout(r, 5)) // Wait 5 ms to see if additional credit is available
      return sendPacket()
    }

    const packetAmount = BigNumber.min(
      source.availableCredit,
      remainingAmount,
      maxPacketAmount
    )

    const packetNum = (prepareCount += 1)

    const fulfillment = await generateSecret()
    const executionCondition = sha256(fulfillment)
    const fulfillPacket: IlpFulfill = {
      fulfillment,
      data: Buffer.alloc(0)
    }

    // Ensure the exchange rate of this packet is within the slippage bounds
    const acceptExchangeRate = (
      sourceAmount: BigNumber.Value,
      destAmount: BigNumber.Value
    ) =>
      convert(source.baseUnit(sourceAmount), dest.baseUnit(), rateApi)
        .times(new BigNumber(1).minus(slippage))
        .integerValue(BigNumber.ROUND_DOWN)
        .lt(destAmount)

    const correctCondition = (someCondition: Buffer) =>
      executionCondition.equals(someCondition)

    dest.registerPacketHandler(
      async ({ executionCondition: someCondition, amount: destAmount }) =>
        acceptExchangeRate(packetAmount, destAmount) &&
        correctCondition(someCondition)
          ? fulfillPacket
          : APPLICATION_ERROR
    )

    log.debug(`sending packet ${packetNum} for ${packetAmount}`)
    const response = await source.sendPacket({
      destination: dest.clientAddress,
      amount: packetAmount.toString(),
      executionCondition,
      data: Buffer.alloc(0),
      expiresAt: new Date(Date.now() + EXPIRATION_WINDOW)
    })

    if (isReject(response)) {
      const { code, data } = response
      log.debug(`packet ${packetNum} rejected with ${code}`)

      // Handle "amount too large" errors
      if (code === 'F08') {
        const reader = Reader.from(data)
        // TODO This is slow. Switch to Long per oer-utils update?
        const foreignReceivedAmount = reader.readUInt64BigNum()
        const foreignMaxPacketAmount = reader.readUInt64BigNum()

        /**
         * Since the data in the reject are in units we're not familiar with,
         * we can determine the exchange rate via (source amount / dest amount),
         * then convert the foreign max packet amount into native units
         */
        const newMaxPacketAmount = packetAmount
          .times(foreignMaxPacketAmount)
          .dividedToIntegerBy(foreignReceivedAmount)

        // As we encounter more F08s, max packet amount should never increase!
        if (newMaxPacketAmount.gte(packetAmount)) {
          log.error(
            'unexpected amount too large error: sent less than the max packet amount'
          )
        } else if (newMaxPacketAmount.lt(packetAmount)) {
          log.debug(
            `reducing packet amount from ${packetAmount} to ${maxPacketAmount}`
          )
          maxPacketAmount = newMaxPacketAmount
        }
      }
    } else if (isFulfill(response)) {
      log.debug(
        `packet ${packetNum} fulfilled for source amount ${packetAmount}`
      )
      bumpIdle()

      totalFulfilled = totalFulfilled.plus(packetAmount)
      fulfillCount += 1
    }

    dest.deregisterPacketHandler()
    return sendPacket()
  }

  return sendPacket().finally(() => {
    dest.deregisterPacketHandler()
    log.debug(
      `stream ended. ${fulfillCount} packets fulfilled of ${prepareCount} total packets`
    )
  })
}
