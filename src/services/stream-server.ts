import * as IlpStream from 'ilp-protocol-stream'
import { generateSecret } from 'utils/crypto'
import { Plugin, DataHandler } from 'utils/types'
import { defaultDataHandler } from 'utils/packet'

import createLogger from '../utils/log'
const log = createLogger(`switch-api:stream-service`)

// TODO The composition *might* be simpler if this doesn't take in an uplink,
// since then I have to define all the complicated intermediary states
export const startStreamServer = async (
  plugin: Plugin,
  registerDataHandler: (streamServerHandler: DataHandler) => void,
  streamSecret?: Buffer
): Promise<IlpStream.Server> => {
  streamSecret = streamSecret || (await generateSecret())
  const deregisterDataHandler = () => registerDataHandler(defaultDataHandler)

  const streamServer = await IlpStream.createServer({
    idleTimeout: 360000, // Destroy connection after 6 minutes of inactivity
    plugin: {
      // TODO Is the `this` context correct?
      ...plugin,
      disconnect: () => Promise.resolve(), // Don't let Stream disconnect the plugin
      registerDataHandler,
      deregisterDataHandler
    },
    receiveOnly: true, // TODO Finally, fix receiveOnly mode!
    serverSecret: streamSecret
  })

  // TODO Fix this: we love money,
  // but we also don't want randos to exhaust our payment bandwidth!
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
