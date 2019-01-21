import BigNumber from 'bignumber.js'
import EventEmitter from 'eventemitter3'
import {
  deserializeIlpPrepare,
  deserializeIlpReply,
  isFulfill,
  isReject,
  serializeIlpReject
} from 'ilp-packet'
import { DataHandler, Logger, MoneyHandler, Plugin } from './types'
import { MemoryStore } from './store'
import { defaultDataHandler, defaultMoneyHandler } from './packet'

// Almost never use exponential notation
BigNumber.config({ EXPONENTIAL_AT: 1e9 })

export interface IWrapperOpts {
  plugin: Plugin
  log: Logger
  assetCode: string
  assetScale: number
  store?: MemoryStore
  maxPacketAmount?: BigNumber.Value
  balance?: {
    maximum?: BigNumber.Value
    settleTo?: BigNumber.Value
    settleThreshold?: BigNumber.Value
    minimum?: BigNumber.Value
  }
}

export class PluginWrapper implements Plugin {
  static readonly version = 2

  // Internal plugin
  private readonly plugin: Plugin
  private dataHandler: DataHandler = defaultDataHandler
  private moneyHandler: MoneyHandler = defaultMoneyHandler

  // Balance
  private readonly maximum: BigNumber
  private readonly settleTo: BigNumber
  private readonly settleThreshold: BigNumber
  private readonly minimum: BigNumber

  // Max packet amount
  private readonly maxPacketAmount: BigNumber

  // Services
  private readonly store: MemoryStore
  private readonly log: Logger
  private readonly assetCode: string
  private readonly assetScale: number

  constructor({
    plugin,
    balance: {
      maximum = Infinity,
      settleTo = 0,
      settleThreshold = -Infinity,
      minimum = -Infinity
    } = {},
    maxPacketAmount = Infinity,
    log,
    store,
    assetCode,
    assetScale
  }: IWrapperOpts) {
    this.store = store || new MemoryStore()
    this.log = log
    this.assetCode = assetCode
    this.assetScale = assetScale

    this.maximum = new BigNumber(maximum).dp(0, BigNumber.ROUND_FLOOR)
    this.settleTo = new BigNumber(settleTo).dp(0, BigNumber.ROUND_FLOOR)
    this.settleThreshold = new BigNumber(settleThreshold).dp(
      0,
      BigNumber.ROUND_FLOOR
    )
    this.minimum = new BigNumber(minimum).dp(0, BigNumber.ROUND_CEIL)

    // Validate balance configuration: max >= settleTo >= settleThreshold >= min
    if (!this.maximum.gte(this.settleTo)) {
      throw new Error(
        'Invalid balance configuration: maximum balance must be greater than or equal to settleTo'
      )
    }
    if (!this.settleTo.gte(this.settleThreshold)) {
      throw new Error(
        'Invalid balance configuration: settleTo must be greater than or equal to settleThreshold'
      )
    }
    if (!this.settleThreshold.gte(this.minimum)) {
      throw new Error(
        'Invalid balance configuration: settleThreshold must be greater than or equal to minimum balance'
      )
    }

    this.maxPacketAmount = new BigNumber(maxPacketAmount)
      .abs()
      .dp(0, BigNumber.ROUND_FLOOR)

    this.plugin = plugin

    this.plugin.registerDataHandler(data => this.handleData(data))
    this.plugin.registerMoneyHandler(amount => this.handleMoney(amount))
  }

  async connect(opts?: object) {
    await this.plugin.connect(opts)
    return this.attemptSettle().catch(err =>
      this.log.error(`Failed to settle: ${err.message}`)
    )
  }

  disconnect() {
    return this.plugin.disconnect()
  }

  isConnected() {
    return this.plugin.isConnected()
  }

  async sendData(data: Buffer): Promise<Buffer> {
    const next = () => this.plugin.sendData(data)

    const { amount } = deserializeIlpPrepare(data)
    if (amount === '0') {
      return next()
    }

    const response = await next()
    const reply = deserializeIlpReply(response)

    if (isFulfill(reply)) {
      try {
        this.subBalance(amount)
        // If the balance change succeeds, also update payout amount
        this.payoutAmount = this.payoutAmount.plus(amount)
      } catch (err) {
        this.log.trace(`Failed to fulfill response to PREPARE: ${err.message}`)
        return serializeIlpReject({
          code: 'F00',
          message: 'Insufficient funds',
          triggeredBy: '',
          data: Buffer.alloc(0)
        })
      }
    }

    // Attempt to settle on fulfills and* T04s (to resolve stalemates)
    const shouldSettle =
      isFulfill(reply) || (isReject(reply) && reply.code === 'T04')
    if (shouldSettle) {
      this.attemptSettle().catch(err =>
        this.log.error(`Failed to settle: ${err.message}`)
      )
    }

    return response
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

  private async handleData(data: Buffer): Promise<Buffer> {
    const next = () => this.dataHandler(data)

    // Ignore 0 amount packets
    const { amount } = deserializeIlpPrepare(data)
    if (amount === '0') {
      return next()
    }

    if (new BigNumber(amount).gt(this.maxPacketAmount)) {
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

    try {
      this.addBalance(amount)
    } catch (err) {
      this.log.trace(err.message)
      return serializeIlpReject({
        code: 'T04',
        message: 'Exceeded maximum balance',
        triggeredBy: '',
        data: Buffer.alloc(0)
      })
    }

    const response = await next()
    const reply = deserializeIlpReply(response)
    if (isReject(reply)) {
      // Allow this to throw if balance drops below minimum
      this.subBalance(amount)
    } else {
      this.attemptSettle().catch(err =>
        this.log.error(`Failed to settle: ${err.message}`)
      )
    }

    return response
  }

  private handleMoney(amount: string) {
    const next = () => this.moneyHandler(amount)

    // Allow this to throw if balance drops below minimum
    this.subBalance(amount)
    return next()
  }

  private async attemptSettle(): Promise<void> {
    // Don't attempt settlement if there's no configured settle threshold ("receive only" mode)
    const shouldSettle = this.settleThreshold.gt(this.balance)
    if (!shouldSettle) {
      return
    }

    // The amount to settle should be limited by the total packets we've fulfilled
    let amount = this.settleTo.plus(this.payoutAmount)
    if (amount.lte(0)) {
      return
    }

    try {
      this.addBalance(amount)
      this.payoutAmount = this.payoutAmount.minus(amount)
    } catch (err) {
      // This should never happen, since the constructor verifies maximum >= settleTo
      return this.log.error(
        `Critical settlement error: incorrectly exceeded max balance`
      )
    }

    this.log.info(`Settlement triggered for ${this.format(amount)}`)

    try {
      return this.plugin.sendMoney(amount.toString())
    } catch (err) {
      this.log.error(`Error during settlement: ${err.message}`)
    }
  }

  /*
   * Load initial balances from the store
   * Automatically save balance updates to the store
   */

  get balance() {
    return new BigNumber(this.store.getSync('balance') || 0)
  }

  set balance(amount: BigNumber) {
    this.store.putSync('balance', amount.toString())
  }

  get payoutAmount() {
    return new BigNumber(this.store.getSync('payoutAmount') || 0)
  }

  set payoutAmount(amount: BigNumber) {
    this.store.putSync('payoutAmount', amount.toString())
  }

  private addBalance(amount: BigNumber.Value) {
    if (new BigNumber(amount).isZero()) {
      return
    }

    const newBalance = this.balance.plus(amount)
    if (newBalance.gt(this.maximum)) {
      throw new Error(
        `Cannot debit ${this.format(amount)}: proposed balance of ${this.format(
          newBalance
        )} exceeds maximum of ${this.format(this.maximum)}`
      )
    }

    this.log.trace(
      `Debited ${this.format(amount)}: new balance is ${this.format(
        newBalance
      )}`
    )
    this.balance = newBalance
  }

  private subBalance(amount: BigNumber.Value) {
    if (new BigNumber(amount).isZero()) {
      return
    }

    const newBalance = this.balance.minus(amount)
    if (newBalance.lt(this.minimum)) {
      throw new Error(
        `Cannot credit ${this.format(
          amount
        )}: proposed balance of ${this.format(
          newBalance
        )} is below minimum of ${this.format(this.minimum)}`
      )
    }

    this.log.trace(
      `Credited ${this.format(amount)}: new balance is ${this.format(
        newBalance
      )}`
    )
    this.balance = newBalance
  }

  private format(amount: BigNumber.Value) {
    return `${new BigNumber(amount).shiftedBy(
      -this.assetScale
    )} ${this.assetCode.toLowerCase()}`
  }
}
