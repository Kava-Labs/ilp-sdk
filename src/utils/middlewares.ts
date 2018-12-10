import BigNumber from 'bignumber.js'
import EventEmitter from 'eventemitter3'
import {
  deserializeIlpPrepare,
  deserializeIlpReply,
  IlpPrepare,
  IlpReply,
  isFulfill,
  isReject,
  serializeIlpPrepare,
  serializeIlpReply
} from 'ilp-packet'
import { IldcpResponse } from 'ilp-protocol-ildcp'
import {
  DataHandler3,
  ILogger,
  IPlugin,
  IPlugin3,
  MoneyHandler3
} from './types'

// Almost never use exponential notation
BigNumber.config({ EXPONENTIAL_AT: 1e9 })

// TODO Change this to F02 + log?
const defaultDataHandler = () => {
  throw new Error('no request handler registered')
}

// TODO Change this to F02 + log?
const defaultMoneyHandler = () => {
  throw new Error('no money handler registered')
}

export interface IWrapperOpts {
  plugin: IPlugin
  log: ILogger
  ildcpInfo: IldcpResponse
  maxPacketAmount?: BigNumber.Value
  balance?: {
    maximum?: BigNumber.Value
    settleTo?: BigNumber.Value
    settleThreshold?: BigNumber.Value
    minimum?: BigNumber.Value
  }
}

export class PluginWrapper extends EventEmitter implements IPlugin3 {
  public static readonly version = 3

  // Internal plugin
  private readonly plugin: IPlugin
  private dataHandler: DataHandler3 = defaultDataHandler
  private moneyHandler: MoneyHandler3 = defaultMoneyHandler

  // Balance
  private readonly enableBalance: boolean
  private readonly maximum: BigNumber
  private readonly settleTo: BigNumber
  private readonly settleThreshold: BigNumber
  private readonly minimum: BigNumber
  private balance = new BigNumber(0)
  private payoutAmount: BigNumber

  // Max packet amount
  private readonly maxPacketAmount: BigNumber

  // Logging
  private readonly log: ILogger
  private readonly ildcpInfo: IldcpResponse

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
    ildcpInfo
  }: IWrapperOpts) {
    super()

    this.log = log // TODO create a logger here

    this.maximum = new BigNumber(maximum).dp(0, BigNumber.ROUND_FLOOR)
    this.settleTo = new BigNumber(settleTo).dp(0, BigNumber.ROUND_FLOOR)
    this.settleThreshold = new BigNumber(settleThreshold).dp(
      0,
      BigNumber.ROUND_FLOOR
    )
    this.minimum = new BigNumber(minimum).dp(0, BigNumber.ROUND_CEIL)

    this.enableBalance =
      this.maximum.eq(Infinity) && this.settleThreshold.eq(-Infinity)

    // If we’re not prefunding, the amount to settle should be limited by the total packets we’ve fulfilled
    this.payoutAmount = this.settleTo.gt(0)
      ? new BigNumber(Infinity)
      : new BigNumber(0)

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

    this.plugin.registerDataHandler(async (data: Buffer) =>
      serializeIlpReply(await this.handleData(deserializeIlpPrepare(data)))
    )
    this.plugin.registerMoneyHandler((amount: string) =>
      this.handleMoney(new BigNumber(amount))
    )

    this.plugin.on('connect', () => this.emit('connect'))
    this.plugin.on('disconnect', () => this.emit('disconnect'))
    this.plugin.on('error', (err: Error) => this.emit('error', err))

    this.ildcpInfo = ildcpInfo
  }

  public async connect(opts: object) {
    await this.plugin.connect(opts)
    return this.attemptSettle()
  }

  public disconnect() {
    return this.plugin.disconnect()
  }

  public isConnected() {
    return this.plugin.isConnected()
  }

  public async sendData(prepare: IlpPrepare): Promise<IlpReply> {
    const next = async () =>
      deserializeIlpReply(
        await this.plugin.sendData(serializeIlpPrepare(prepare))
      )

    const { amount } = prepare
    if (amount === '0') {
      return next()
    }

    const reply = await next()

    if (isFulfill(reply)) {
      try {
        this.subBalance(amount)
        // If the balance change succeeds, also update payout amount
        this.payoutAmount = this.payoutAmount.plus(amount)
      } catch (err) {
        this.log.trace(`Failed to fulfill response to PREPARE: ${err.message}`)
        return {
          code: 'F00',
          message: 'Insufficient funds',
          triggeredBy: this.ildcpInfo.clientAddress,
          data: Buffer.alloc(0)
        }
      }
    }

    // Attempt to settle on fulfills and* T04s (to resolve stalemates)
    const shouldSettle =
      isFulfill(reply) || (isReject(reply) && reply.code === 'T04')
    if (shouldSettle) {
      this.attemptSettle()
    }

    return reply
  }

  public async sendMoney() {
    throw new Error(
      'sendMoney is not supported: use balance wrapper for balance configuration'
    )
  }

  public registerDataHandler(
    handler: (parsedPrepare: IlpPrepare) => Promise<IlpReply>
  ) {
    if (this.dataHandler !== defaultDataHandler) {
      throw new Error('request handler is already registered')
    }

    this.dataHandler = handler
  }

  public registerMoneyHandler(handler: (amount: BigNumber) => Promise<void>) {
    if (this.moneyHandler !== defaultMoneyHandler) {
      throw new Error('money handler is already registered')
    }

    this.moneyHandler = handler
  }

  public deregisterDataHandler() {
    this.dataHandler = defaultDataHandler
  }

  public deregisterMoneyHandler() {
    this.moneyHandler = defaultMoneyHandler
  }

  private async handleData(prepare: IlpPrepare): Promise<IlpReply> {
    const next = () => this.dataHandler(prepare)

    // Ignore 0 amount packets
    const { amount } = prepare
    if (amount === '0') {
      return next()
    }

    if (new BigNumber(amount).gt(this.maxPacketAmount)) {
      return {
        code: 'F08',
        triggeredBy: this.ildcpInfo.clientAddress,
        message: 'Packet size is too large.',
        data: Buffer.from(
          JSON.stringify({
            receivedAmount: amount,
            maximumAmount: this.maxPacketAmount.toString()
          })
        )
      }
    }

    try {
      this.addBalance(amount)
    } catch (err) {
      this.log.trace(err.message)
      return {
        code: 'T04',
        message: 'Exceeded maximum balance',
        triggeredBy: this.ildcpInfo.clientAddress,
        data: Buffer.alloc(0)
      }
    }

    const reply = await next()
    if (isReject(reply)) {
      // Allow this to throw if balance drops below minimum
      this.subBalance(amount)
    } else {
      this.attemptSettle()
    }

    return reply
  }

  private handleMoney(amount: BigNumber) {
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

    let amount = this.settleTo.minus(this.balance)
    if (amount.lte(0)) {
      // This should never happen, since the constructor verifies that settleTo >= settleThreshold
      return this.log.error(
        `Critical settlement error: settle threshold incorrectly triggered`
      )
    }

    // If we're not prefunding, the amount should be limited by the total packets we've fulfilled
    // If we're prefunding, the payoutAmount is infinity, so it doesn't affect the amount to settle
    amount = BigNumber.min(amount, this.payoutAmount)
    if (amount.lte(0)) {
      return
    }

    try {
      this.addBalance(amount)
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

  private addBalance(amount: BigNumber.Value) {
    if (!this.enableBalance) {
      return
    }

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
    if (!this.enableBalance) {
      return
    }

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
      -this.ildcpInfo.assetScale
    )} ${this.ildcpInfo.assetCode.toLowerCase()}`
  }
}
