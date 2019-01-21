import { IlpPrepare, IlpReply } from 'ilp-packet'
import { Plugin as IlpStreamPlugin } from 'ilp-protocol-stream/src/util/plugin-interface'

export type DataHandler = (data: Buffer) => Promise<Buffer>
export type MoneyHandler = (amount: string) => Promise<void>
export type IlpPrepareHandler = (prepare: IlpPrepare) => Promise<IlpReply>

export { IlpStreamPlugin }

export interface Plugin extends IlpStreamPlugin {
  connect(options?: object): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  sendData(data: Buffer): Promise<Buffer>
  sendMoney(amount: string): Promise<void>
  registerDataHandler(dataHandler: DataHandler): void
  deregisterDataHandler(): void
  registerMoneyHandler(moneyHandler: MoneyHandler): void
  deregisterMoneyHandler(): void
  getAdminInfo?(): Promise<object>
  sendAdminInfo?(info: object): Promise<object>
}

export interface Logger {
  info(...msg: any[]): void
  warn(...msg: any[]): void
  error(...msg: any[]): void
  debug(...msg: any[]): void
  trace(...msg: any[]): void
}
