import { convert } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import { IlpFulfill, isFulfill, isReject } from 'ilp-packet'
import {
  sendPacket,
  deregisterPacketHandler,
  registerPacketHandler,
  ReadyUplinks
} from '../uplink'
import { Reader } from 'oer-utils'
import { generateSecret, sha256 } from '../utils/crypto'
import createLogger from '../utils/log'
import { APPLICATION_ERROR } from '../utils/packet'
import { State } from '..'
import { getOrCreateEngine } from '../engine'

const log = createLogger('switch-api:stream')

BigNumber.config({ EXPONENTIAL_AT: 1e9 }) // Almost never use exponential notation

/** End stream if no packets are successfully fulfilled within this interval */
const IDLE_TIMEOUT = 10000

/** Amount of time in the future when packets should expire */
const EXPIRATION_WINDOW = 5000

/**
 * Send money between the two upinks, with the total untrusted
 * amount bounded by the given maxInFlightUsd
 *
 * @param amount Total (maximum) amount to send, in units of exchange of source uplink
 * @param source Source uplink to send outgoing money
 * @param dest Destination uplink to receive incoming money
 * @param slippage Maximum per-packet slippage from latest exchange rate as decimal
 */
export const streamMoney = (state: State) => async ({
  amount,
  source,
  dest,
  slippage = 0.01
}: {
  /** Amount of money to be sent over stream, in units of exchange */
  amount: BigNumber
  /** Send assets via the given source ledger/plugin */
  source: ReadyUplinks
  /** Receive assets via the given destination ledger/plugin */
  dest: ReadyUplinks
  /**
   * Maximum percentage of slippage allowed. If the per-packet exchange rate
   * drops below the price oracle's rate minus this slippage,
   * the packet will be rejected
   */
  slippage?: BigNumber.Value
}): Promise<void> => {
  // TODO The state must be updated with the new settlers!
  const [sourceSettler, state1] = await getOrCreateEngine(
    state,
    source.settlerType
  )
  const [destSettler, state2] = await getOrCreateEngine(state, dest.settlerType)

  const amountToSend = convert(
    sourceSettler.exchangeUnit(amount),
    sourceSettler.baseUnit()
  )

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

  // TODO Move this to uplink.ts so it's more abstracted
  const format = (amount: BigNumber) =>
    `${convert(
      sourceSettler.baseUnit(amount),
      sourceSettler.exchangeUnit()
    )} ${sourceSettler.assetCode.toLowerCase()}`

  log.debug(
    `starting streaming exchange from ${sourceSettler.assetCode} -> ${
      destSettler.assetCode
    }`
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

  const trySendPacket = async (): Promise<any> => {
    // TODO Add error for "poor exchange rate" if every (?) error within window was due to an exchange rate problem?
    const isFailing = Date.now() > timeout
    if (isFailing) {
      log.error('stream timed out: no packets fulfilled within idle window')
      return Promise.reject()
    }

    const remainingAmount = amountToSend.minus(totalFulfilled)
    if (remainingAmount.isZero()) {
      return log.info(
        `stream succeeded: total amount of ${format(
          amountToSend
        )} was fulfilled`
      )
    } else if (remainingAmount.isNegative()) {
      return log.info(
        `stream sent too much: ${format(
          remainingAmount.negated()
        )} more was fulfilled above the requested amount of ${format(
          amountToSend
        )}`
      )
    }

    const availableToSend = source.availableToSend$.getValue()
    const remainingToSend = convert(
      sourceSettler.baseUnit(remainingAmount),
      sourceSettler.exchangeUnit()
    )
    if (remainingToSend.gt(availableToSend)) {
      log.error(
        `stream failed: insufficient outgoing capacity to fulfill remaining amount of ${format(
          remainingAmount
        )}`
      )
      return Promise.reject()
    }

    const availableToReceive = dest.availableToReceive$.getValue()
    const remainingToReceive = convert(
      sourceSettler.baseUnit(remainingAmount),
      destSettler.exchangeUnit(),
      state.rateBackend
    )
    if (remainingToReceive.gt(availableToReceive)) {
      log.error(
        `stream failed: insufficient incoming capacity to fulfill remaining amount of ${format(
          remainingAmount
        )}`
      )
      return Promise.reject()
    }

    let packetAmount = BigNumber.min(
      source.maxInFlight,
      remainingAmount,
      maxPacketAmount
    )

    // Distribute the remaining amount to send such that the per-packet amount is approximately equal
    const remainingNumPackets = remainingAmount
      .dividedBy(packetAmount)
      .decimalPlaces(0, BigNumber.ROUND_CEIL)
    packetAmount = remainingAmount
      .dividedBy(remainingNumPackets)
      .decimalPlaces(0, BigNumber.ROUND_CEIL)

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
      new BigNumber(destAmount).gte(
        convert(
          sourceSettler.baseUnit(sourceAmount),
          destSettler.baseUnit(),
          state.rateBackend
        )
          .times(new BigNumber(1).minus(slippage))
          .integerValue(BigNumber.ROUND_CEIL)
      )

    const correctCondition = (someCondition: Buffer) =>
      executionCondition.equals(someCondition)

    registerPacketHandler(
      async ({ executionCondition: someCondition, amount: destAmount }) =>
        acceptExchangeRate(packetAmount, destAmount) && // TODO Respond with F04: insufficient destination amount instead?
        correctCondition(someCondition) // TODO Respond with F06: unexpected payment instead?
          ? fulfillPacket
          : APPLICATION_ERROR
    )(dest)

    log.debug(`sending packet ${packetNum} for ${packetAmount}`)
    const response = await sendPacket(source, {
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
            `reducing packet amount from ${packetAmount} to ${newMaxPacketAmount}`
          )
          maxPacketAmount = newMaxPacketAmount
        }
      }
    } else if (isFulfill(response)) {
      log.debug(
        `packet ${packetNum} fulfilled for source amount ${format(
          packetAmount
        )}`
      )
      bumpIdle()

      totalFulfilled = totalFulfilled.plus(packetAmount)
      fulfillCount += 1
    }

    deregisterPacketHandler(dest)
    return trySendPacket()
  }

  return trySendPacket().finally(() => {
    deregisterPacketHandler(dest)
    log.debug(
      `stream ended: ${fulfillCount} packets fulfilled of ${prepareCount} total packets`
    )
  })
}
