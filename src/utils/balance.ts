import BigNumber from 'bignumber.js'
import EventEmitter = require('eventemitter3')
import * as IlpPacket from 'ilp-packet'
import { convert } from './convert'
import { IDataHandler, ILogger, IMoneyHandler, IPlugin } from './types'

// Almost never use exponential notation
BigNumber.config({ EXPONENTIAL_AT: 1e9 })

const defaultDataHandler = () => {
  throw new Error('no request handler registered')
}

const defaultMoneyHandler = () => {
  throw new Error('no money handler registered')
}

export interface IBalanceWrapperOpts {
  balance: {
    maximum?: BigNumber.Value
    settleTo?: BigNumber.Value
    settleThreshold?: BigNumber.Value
    minimum?: BigNumber.Value
  }
  plugin: IPlugin
  assetCode: string
  assetScale: number
  log: ILogger
}

export class BalanceWrapper extends EventEmitter implements IPlugin {
  public static readonly version = 2

  private readonly plugin: IPlugin
  private readonly assetCode: string
  private readonly assetScale: number
  private dataHandler: IDataHandler = defaultDataHandler
  private moneyHandler: IMoneyHandler = defaultMoneyHandler

  private readonly maximum: BigNumber
  private readonly settleTo: BigNumber
  private readonly settleThreshold?: BigNumber
  private readonly minimum: BigNumber

  private balance = new BigNumber(0)
  private payoutAmount: BigNumber

  private readonly log: ILogger

  constructor({
    plugin,
    balance: {
      maximum = Infinity,
      settleTo = 0,
      settleThreshold,
      minimum = -Infinity
    },
    log,
    assetScale,
    assetCode
  }: IBalanceWrapperOpts) {
    super()

    this.maximum = new BigNumber(maximum).dp(0, BigNumber.ROUND_FLOOR)
    this.settleTo = new BigNumber(settleTo).dp(0, BigNumber.ROUND_FLOOR)
    this.minimum = new BigNumber(minimum).dp(0, BigNumber.ROUND_CEIL)

    if (settleThreshold) {
      this.settleThreshold = new BigNumber(settleThreshold).dp(
        0,
        BigNumber.ROUND_FLOOR
      )
    }

    // If we’re not prefunding, the amount to settle should be limited by the total packets we’ve fulfilled
    this.payoutAmount = this.settleTo.gt(0)
      ? new BigNumber(Infinity)
      : new BigNumber(0)

    // Validate balance configuration: max >= settleTo >= settleThreshold >= min
    if (this.settleThreshold) {
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
    } else {
      if (!this.maximum.gt(this.minimum)) {
        throw new Error(
          'Invalid balance configuration: maximum balance must be greater than minimum balance'
        )
      }

      this.log.trace(
        `Auto-settlement disabled: plugin is in receive-only mode since no settleThreshold was configured`
      )
    }

    this.plugin = plugin

    this.plugin.registerDataHandler((data: Buffer) => this.handleData(data))
    this.plugin.registerMoneyHandler((amount: string) =>
      this.handleMoney(amount)
    )

    this.plugin.on('connect', () => this.emit('connect'))
    this.plugin.on('disconnect', () => this.emit('disconnect'))
    this.plugin.on('error', (err: Error) => this.emit('error', err))

    this.assetScale = assetScale
    this.assetCode = assetCode

    this.log = log
  }

  public async connect(opts: object) {
    await this.attemptSettle()
    return this.plugin.connect(opts)
  }

  public disconnect() {
    return this.plugin.disconnect()
  }

  public isConnected() {
    return this.plugin.isConnected()
  }

  public async sendData(data: Buffer) {
    const next = () => this.plugin.sendData(data)

    if (data[0] === IlpPacket.Type.TYPE_ILP_PREPARE) {
      const { amount } = IlpPacket.deserializeIlpPrepare(data)

      if (amount === '0') {
        return next()
      }

      const res = await next()

      const packet = IlpPacket.deserializeIlpPacket(res)
      const isFulfill = res[0] === IlpPacket.Type.TYPE_ILP_FULFILL
      const isReject = res[0] === IlpPacket.Type.TYPE_ILP_REJECT

      // Attempt to settle on fulfills and* T04s (to resolve stalemates)
      const attemptSettle =
        isFulfill ||
        (isReject && (packet.data as IlpPacket.IlpReject).code === 'T04')
      if (attemptSettle) {
        try {
          this.subBalance(amount)
        } catch (err) {
          this.log.trace(err.message)
          return IlpPacket.serializeIlpReject({
            code: 'F00',
            message: 'Insufficient funds',
            triggeredBy: '',
            data: Buffer.alloc(0)
          })
        }
        // If the balance change succeeds, also update payout amount
        this.payoutAmount = this.payoutAmount.plus(amount)

        this.attemptSettle()
      }

      return res
    } else {
      return next()
    }
  }

  public async sendMoney() {
    throw new Error(
      'sendMoney is not supported: use balance wrapper for balance configuration'
    )
  }

  public registerDataHandler(handler: IDataHandler) {
    if (this.dataHandler) {
      throw new Error('request handler is already registered')
    }

    this.dataHandler = handler
  }

  public registerMoneyHandler(handler: IMoneyHandler) {
    if (this.moneyHandler) {
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

  private async handleData(data: Buffer) {
    const next = () => this.dataHandler(data)

    if (data[0] === IlpPacket.Type.TYPE_ILP_PREPARE) {
      const { amount } = IlpPacket.deserializeIlpPrepare(data)

      // Ignore 0 amount packets
      if (amount === '0') {
        return next()
      }

      try {
        this.addBalance(amount)
      } catch (err) {
        this.log.trace(err.message)
        return IlpPacket.serializeIlpReject({
          code: 'T04',
          message: 'Exceeded maximum balance',
          triggeredBy: '',
          data: Buffer.alloc(0)
        })
      }

      const res = await next()

      if (res[0] === IlpPacket.Type.TYPE_ILP_REJECT) {
        // Allow this to throw if balance drops below minimum
        this.subBalance(amount)
      } else if (res[0] === IlpPacket.Type.TYPE_ILP_FULFILL) {
        this.attemptSettle()
      }
    }

    return next()
  }

  private handleMoney(amount: string) {
    const next = () => this.moneyHandler(amount)

    // Allow this to throw if balance drops below minimum
    this.subBalance(amount)
    return next()
  }

  private async attemptSettle(): Promise<void> {
    // Don't attempt settlement if there's no configured settle threshold ("receive only" mode)
    if (!this.settleThreshold) {
      return
    }

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
    return `${convert(amount, 0, this.assetScale)} ${this.assetCode}`
  }
}
