import * as IlpStream from 'ilp-protocol-stream'
import { Plugin, DataHandler, IlpStreamPlugin } from '../types/plugin'
import { defaultDataHandler } from '../utils/packet'

export const startStreamServer = async (
  plugin: Plugin,
  registerDataHandler: (streamServerHandler: DataHandler) => void,
  streamSecret: Buffer
): Promise<IlpStream.Server> => {
  const streamServer = await IlpStream.createServer({
    idleTimeout: 360000, // Destroy connection after 6 minutes of inactivity
    plugin: wrapStreamPlugin(plugin, registerDataHandler),
    receiveOnly: true, // TODO Finally, fix receiveOnly mode!
    serverSecret: streamSecret
  })

  /**
   * TODO Fix this: we love money, but we also don't want randos to exhaust our payment bandwidth! Alternatively:
   * (1) Slowly increment receive max as money is received, but only slowly, so we don't fulfill the full amount
   * (2) Max packet amount to kinda enforce limits? (but only per-packet)
   */
  streamServer.on('connection', (conn: IlpStream.Connection) =>
    conn.on('stream', (stream: IlpStream.DataAndMoneyStream) =>
      stream.setReceiveMax(Infinity)
    )
  )

  return streamServer
}

export const stopStreamServer = (server: IlpStream.Server): Promise<void> => {
  server.removeAllListeners()
  return server.close()
}

export const wrapStreamPlugin = (
  plugin: Plugin,
  registerDataHandler: (handler: DataHandler) => void
): IlpStreamPlugin => ({
  connect(): Promise<void> {
    return plugin.connect()
  },
  disconnect(): Promise<void> {
    // Don't let Stream disconnect the plugin
    return Promise.resolve()
  },
  isConnected(): boolean {
    return plugin.isConnected()
  },
  sendData(data): Promise<Buffer> {
    return plugin.sendData(data)
  },
  registerDataHandler(handler): void {
    registerDataHandler(handler)
  },
  deregisterDataHandler(): void {
    registerDataHandler(defaultDataHandler)
  }
})
