import BigNumber from 'bignumber.js'
import {
  deserializeIlpPrepare,
  deserializeIlpReply,
  isFulfill,
  isReject,
  serializeIlpReject
} from 'ilp-packet'
import { DataHandler, Logger, MoneyHandler, Plugin } from '../types/plugin'
import { MemoryStore } from './store'
import { defaultDataHandler, defaultMoneyHandler } from './packet'
import { BehaviorSubject } from 'rxjs'

// Almost never use exponential notation
BigNumber.config({ EXPONENTIAL_AT: 1e9 })

export interface PluginWrapperOpts {
  plugin: Plugin
  prefundTo?: BigNumber.Value
  maxBalance?: BigNumber.Value
  maxPacketAmount?: BigNumber.Value
  log: Logger
  assetCode: string
  assetScale: number
  store?: MemoryStore
}

export class PluginWrapper implements Plugin {
  static readonly version = 2

  // Internal plugin
  private readonly plugin: Plugin
  private dataHandler: DataHandler = defaultDataHandler
  private moneyHandler: MoneyHandler = defaultMoneyHandler

  /**
   * Amount owed *by us* to our peer for **our packets they've forwarded** (outgoing balance)
   * - Positive amount indicates we're indebted to the peer and need to pay them for packets they're already forwarded
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
   * Positive amount to prefund, which decreases the payable/outgoing balance
   * - If peer is not extending us very little/no credit, we can still send
   *   packets by prefunding
   */
  private readonly prefundTo: BigNumber
  /**
   * Should any outgoing settlements be triggered?
   * - If settlement is disabled, balances will still be correctly accounted for
   *   so settlements can proceed if it's later re-enabled
   */
  isSettlementEnabled = true

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
   * - Determines if an incoming ILP PREPARE is forwarded/cleared
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
    prefundTo = 0,
    maxBalance = Infinity,
    maxPacketAmount = Infinity,
    log,
    store,
    assetCode,
    assetScale
  }: PluginWrapperOpts) {
    this.plugin = plugin
    this.plugin.registerDataHandler(data => this.handleData(data))
    this.plugin.registerMoneyHandler(amount => this.handleMoney(amount))

    this.store = store || new MemoryStore()
    this.log = log
    this.assetCode = assetCode
    this.assetScale = assetScale

    /** Payable balance (outgoing/settlement) */
    this.prefundTo = new BigNumber(prefundTo).dp(0, BigNumber.ROUND_FLOOR)
    this.payableBalance$ = new BehaviorSubject(
      new BigNumber(this.store.getSync('payableBalance') || 0)
    )
    this.payableBalance$.subscribe(amount =>
      this.store.putSync('payableBalance', amount.toString())
    )

    /** Receivable balance (incoming/clearing) */
    this.maxBalance = new BigNumber(maxBalance).dp(0, BigNumber.ROUND_FLOOR)
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

    const { amount } = deserializeIlpPrepare(data)
    if (amount === '0') {
      return next()
    }

    const response = await next()
    const reply = deserializeIlpReply(response)

    if (isFulfill(reply)) {
      this.log.debug(
        `Received FULFILL in response to forwarded PREPARE: credited ${this.format(
          amount
        )}`
      )
      this.payableBalance$.next(this.payableBalance$.value.plus(amount))
    }

    // Attempt to settle on fulfills *and* T04s (to resolve stalemates)
    const shouldSettle =
      isFulfill(reply) || (isReject(reply) && reply.code === 'T04')
    if (shouldSettle) {
      this.tryToSettle()
    }

    return response
  }

  private tryToSettle() {
    if (!this.isSettlementEnabled) {
      return
    }

    const budget = this.prefundTo.plus(this.payableBalance$.value)
    if (budget.lte(0)) {
      return
    }

    this.log.info(`Settlement triggered for ${this.format(budget)}`)
    this.payableBalance$.next(this.payableBalance$.value.minus(budget))

    this.plugin
      .sendMoney(budget.toString())
      .catch(err => this.log.error(`Error during settlement: ${err.message}`))
  }

  /** Enable outgiong settlements to the peer */
  enableSettlement() {
    this.isSettlementEnabled = true
  }

  /** Disable/prevent any subsequent outgoing settlements to peer from occuring */
  disableSettlement() {
    this.isSettlementEnabled = false
  }

  /*
   * Incoming packets/settlements (receivable balance)
   */

  private handleMoney(amount: string) {
    const next = () => this.moneyHandler(amount)

    if (new BigNumber(amount).isZero()) {
      return next()
    }

    const newBalance = this.receivableBalance$.value.minus(amount)
    this.log.debug(
      `Received incoming settlement: credited ${this.format(
        amount
      )}, new balance is ${this.format(newBalance)}`
    )
    this.receivableBalance$.next(newBalance)

    return next()
  }

  private async handleData(data: Buffer): Promise<Buffer> {
    const next = () => this.dataHandler(data)

    // Ignore 0 amount packets (no middlewares apply)
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
    } else {
      this.tryToSettle()
    }

    return response
  }

  /*
   * Plugin wrapper
   */

  async connect(opts?: object) {
    await this.plugin.connect(opts)
    this.tryToSettle() // TODO Should this be await-ed?
  }

  disconnect() {
    return this.plugin.disconnect()
  }

  isConnected() {
    return this.plugin.isConnected()
  }

  async sendMoney() {
    throw new Error(
      'sendMoney is not supported: use balance wrapper for balance configuration'
    )
  }

  registerDataHandler(handler: DataHandler) {
    if (this.dataHandler !== defaultDataHandler) {
      throw new Error('request handler is already registered')
    }

    this.dataHandler = handler
  }

  registerMoneyHandler(handler: MoneyHandler) {
    if (this.moneyHandler !== defaultMoneyHandler) {
      throw new Error('money handler is already registered')
    }

    this.moneyHandler = handler
  }

  deregisterDataHandler() {
    this.dataHandler = defaultDataHandler
  }

  deregisterMoneyHandler() {
    this.moneyHandler = defaultMoneyHandler
  }

  /* Utils */

  private format(amount: BigNumber.Value) {
    return `${new BigNumber(amount).shiftedBy(
      -this.assetScale
    )} ${this.assetCode.toLowerCase()}`
  }
}
