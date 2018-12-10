import BigNumber from 'bignumber.js'
// TODO Figure out this eventemitter type incompatability madness
// import { EventEmitter } from 'events'
import EventEmitter3 from 'eventemitter3'
import { IlpPrepare, IlpReply } from 'ilp-packet'
import { Plugin } from 'ilp-protocol-stream/src/util/plugin-interface'
// import { EventEmitter2 } from 'eventemitter2'

export type IDataHandler = (data: Buffer) => Promise<Buffer>
export type IMoneyHandler = (amount: string) => Promise<void>

export interface IPlugin extends Plugin, EventEmitter3<any> {
  connect(options?: object): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  sendData(data: Buffer): Promise<Buffer>
  sendMoney(amount: string): Promise<void>
  registerDataHandler(dataHandler: IDataHandler): void
  deregisterDataHandler(): void
  registerMoneyHandler(moneyHandler: IMoneyHandler): void
  deregisterMoneyHandler(): void
  getAdminInfo?(): Promise<object>
  sendAdminInfo?(info: object): Promise<object>
}

export interface ILogger {
  info(...msg: any[]): void
  warn(...msg: any[]): void
  error(...msg: any[]): void
  debug(...msg: any[]): void
  trace(...msg: any[]): void
}

// LPI v3 for performance improvements

export type DataHandler3 = (prepare: IlpPrepare) => Promise<IlpReply>
export type MoneyHandler3 = (amount: BigNumber) => Promise<void>

export interface IPlugin3 {
  connect(options?: object): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  sendData(prepare: IlpPrepare): Promise<IlpReply>
  sendMoney(amount: BigNumber): Promise<void>
  registerDataHandler(dataHandler: DataHandler3): void
  deregisterDataHandler(): void
  registerMoneyHandler(moneyHandler: MoneyHandler3): void
  deregisterMoneyHandler(): void
}

// TODO ^ I should rename this "PluginWrapper" and "PluginWrapperDataHandler"
// ...that's just super confusing
// (or, for IL-DCP requests and such, maybe expose the internal plugin and bypass the wrapper?)

// TODO !!!!! Instead, the v3 plugin should just expose sendData (IlpPrepare) & registerDataHandler
// that map to the normal plugin -- performance benefit without the confusion?
