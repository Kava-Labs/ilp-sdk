import { EventEmitter } from 'events'
import { Plugin } from 'ilp-protocol-stream/src/util/plugin-interface'

export type IDataHandler = (data: Buffer) => Promise<Buffer>
export type IMoneyHandler = (amount: string) => Promise<void>

export interface IPlugin extends Plugin, EventEmitter {
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
