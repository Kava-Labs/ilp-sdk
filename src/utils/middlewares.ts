import BigNumber from 'bignumber.js'
import {
  deserializeIlpPrepare,
  deserializeIlpReply,
  isFulfill,
  isReject,
  serializeIlpReject
} from 'ilp-packet'
import { DataHandler, Logger, Plugin } from '../types/plugin'
import { MemoryStore } from './store'
import { defaultDataHandler } from './packet'
import { BehaviorSubject } from 'rxjs'
import { sha256 } from '../utils/crypto'

// Almost never use exponential notation
BigNumber.config({ EXPONENTIAL_AT: 1e9 })

export interface PluginWrapperOpts {
  readonly plugin: Plugin
  readonly maxBalance?: BigNumber.Value
  readonly maxPacketAmount: BigNumber.Value
  readonly log: Logger
  readonly assetCode: string
  readonly assetScale: number
  readonly store: MemoryStore
}

// TODO Since this isn't really used as a class anymore, could I just use these as standalone functions
//      existing around a plugin?
//      (How do I ensure that stream only calls these functions, though?)

export class PluginWrapper {
  static readonly version = 2

  // Internal plugin
  private readonly plugin: Plugin
  /* tslint:disable-next-line:readonly-keyword TODO */
  private dataHandler: DataHandler = defaultDataHandler

  /**
   * Amount owed *by us* to our peer for **packets we've sent to them** (outgoing balance)
   * - Positive amount indicates we're indebted to the peer and need to pay them for packets they've already forwarded
   * - Negative amount indicates we've prefunded the peer and have as much credit available to spend
   *
   * TRIGGERS:
   * - Outgoing settlements to peer **decrease** the amount we owe to them
   * - Outgoing PREPARE packets to the peer **increase** the amount we owe to them,
   *   but only *after* we receive a FULFILL packet
   *
   * EFFECTS:
   * - Determines when outgoing settlements to peer occur and for how much
   */
  readonly payableBalance$: BehaviorSubject<BigNumber>

  /**
   * Amount owed *to us* by our peer for **their packets we've forwarded** (incoming balance)
   * - Positive amount indicates our peer is indebted to us for packets we've already forwarded
   * - Negative amount indicates our peer has prefunded us and has as much credit available to spend
   *
   * TRIGGERS:
   * - Incoming settlements from the peer **decrease** the amount they owe to us
   * - Incoming PREPARE packets from the peer immediately **increase** the amount they owe to us,
   *   unless we respond with a REJECT (e.g. we decline to forward it, or it's rejected upstream).
   *
   * EFFECTS:
   * - Determines if an incoming PREPARE is forwarded/cleared
   */
  readonly receivableBalance$: BehaviorSubject<BigNumber>

  /**
   * Positive maximum amount of packets we'll forward on credit before the peer must settle up
   * - Since it's credit extended, if the peer went offline/disappeared, we'd still be owed the money
   */
  private readonly maxBalance: BigNumber

  // Max packet amount
  private readonly maxPacketAmount: BigNumber

  // Services
  private readonly store: MemoryStore
  private readonly log: Logger
  private readonly assetCode: string
  private readonly assetScale: number

  constructor({
    plugin,
    maxBalance = Infinity,
    maxPacketAmount,
    log,
    store,
    assetCode,
    assetScale
  }: PluginWrapperOpts) {
    this.plugin = plugin
    this.plugin.registerDataHandler(data => this.handleData(data))
    this.plugin.registerMoneyHandler(amount => this.handleMoney(amount))

    this.store = store
    this.log = log
    this.assetCode = assetCode
    this.assetScale = assetScale

    /** Payable balance (outgoing/settlement) */
    this.payableBalance$ = new BehaviorSubject(
      new BigNumber(this.store.getSync('payableBalance') || 0)
    )
    this.payableBalance$.subscribe(amount =>
      this.store.putSync('payableBalance', amount.toString())
    )

    /** Receivable balance (incoming/clearing) */
    this.maxBalance = new BigNumber(maxBalance).decimalPlaces(
      0,
      BigNumber.ROUND_FLOOR
    )
    this.receivableBalance$ = new BehaviorSubject(
      new BigNumber(this.store.getSync('receivableBalance') || 0)
    )
    this.receivableBalance$.subscribe(amount =>
      this.store.putSync('receivableBalance', amount.toString())
    )

    /** Max packet amount */
    this.maxPacketAmount = new BigNumber(maxPacketAmount)
      .abs()
      .dp(0, BigNumber.ROUND_FLOOR)
  }

  /*
   * Outgoing packets/settlements (payable balance)
   */

  async sendData(data: Buffer): Promise<Buffer> {
    const next = () => this.plugin.sendData(data)

    const { amount, executionCondition } = deserializeIlpPrepare(data)
    if (amount === '0') {
      return next()
    }

    const response = await next()
    const reply = deserializeIlpReply(response)

    if (isFulfill(reply)) {
      const isValidFulfillment = sha256(reply.fulfillment).equals(
        executionCondition
      )
      if (!isValidFulfillment) {
        this.log.debug('Received FULFILL with invalid fulfillment')
        return serializeIlpReject({
          code: 'F05',
          message: 'fulfillment did not match expected value.',
          triggeredBy: '',
          data: Buffer.alloc(0)
        })
      }

      this.log.debug(
        `Received FULFILL in response to forwarded PREPARE: credited ${this.format(
          amount
        )}`
      )
      this.payableBalance$.next(this.payableBalance$.value.plus(amount))
    }

    return response
  }

  async sendMoney(amount: string): Promise<void> {
    if (parseInt(amount, 10) <= 0) {
      return
    }

    this.log.info(`Settlement triggered for ${this.format(amount)}`)
    this.payableBalance$.next(this.payableBalance$.value.minus(amount))

    this.plugin
      .sendMoney(amount)
      .catch(err => this.log.error('Error during settlement: ', err))
  }

  /*
   * Incoming packets/settlements (receivable balance)
   */

  private async handleMoney(amount: string): Promise<void> {
    if (parseInt(amount, 10) <= 0) {
      return
    }

    const newBalance = this.receivableBalance$.value.minus(amount)
    this.log.debug(
      `Received incoming settlement: credited ${this.format(
        amount
      )}, new balance is ${this.format(newBalance)}`
    )
    this.receivableBalance$.next(newBalance)
  }

  private async handleData(data: Buffer): Promise<Buffer> {
    const next = () => this.dataHandler(data)

    // Ignore 0 amount packets (no middlewares apply, so don't log)
    const { amount } = deserializeIlpPrepare(data)
    if (amount === '0') {
      return next()
    }

    const packetTooLarge = new BigNumber(amount).gt(this.maxPacketAmount)
    if (packetTooLarge) {
      return serializeIlpReject({
        code: 'F08',
        triggeredBy: '',
        message: 'Packet size is too large.',
        data: Buffer.from(
          JSON.stringify({
            receivedAmount: amount,
            maximumAmount: this.maxPacketAmount.toString()
          })
        )
      })
    }

    const newBalance = this.receivableBalance$.value.plus(amount)
    if (newBalance.gt(this.maxBalance)) {
      this.log.debug(
        `Cannot forward PREPARE: cannot debit ${this.format(
          amount
        )}: proposed balance of ${this.format(
          newBalance
        )} exceeds maximum of ${this.format(this.maxBalance)}`
      )
      return serializeIlpReject({
        code: 'T04',
        message: 'Exceeded maximum balance',
        triggeredBy: '',
        data: Buffer.alloc(0)
      })
    }

    this.log.debug(
      `Forwarding PREPARE: Debited ${this.format(
        amount
      )}, new balance is ${this.format(newBalance)}`
    )
    this.receivableBalance$.next(newBalance)

    const response = await next()
    const reply = deserializeIlpReply(response)

    if (isReject(reply)) {
      this.log.debug(`Credited ${this.format(amount)} in response to REJECT`)
      this.receivableBalance$.next(this.receivableBalance$.value.minus(amount))
    }

    return response
  }

  /*
   * Plugin wrapper
   */

  registerDataHandler(handler: DataHandler): void {
    this.dataHandler = handler
  }

  deregisterDataHandler(): void {
    this.dataHandler = defaultDataHandler
  }

  private format(amount: BigNumber.Value): string {
    return `${new BigNumber(amount).shiftedBy(
      -this.assetScale
    )} ${this.assetCode.toLowerCase()}`
  }
}
