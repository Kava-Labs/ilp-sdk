import axios from 'axios'
import BigNumber from 'bignumber.js'
import { randomBytes } from 'crypto'
import EventEmitter = require('eventemitter3')
import * as IlpPacket from 'ilp-packet'
import {
  MemoryStore,
  Store as IStore
} from 'ilp-plugin-ethereum/build/utils/store'
import { fetch } from 'ilp-protocol-ildcp'
import * as IlpStream from 'ilp-protocol-stream'
import { Plugin as IStreamPlugin } from 'ilp-protocol-stream/src/util/plugin-interface'
import { promisify } from 'util'
import { IDataHandler, IPlugin } from './utils/types'

// TODO Remove this
process.env.LEDGER_ENV = 'testnet'

// Intentionally don't send any identifying info here, per:
// https://github.com/interledgerjs/ilp-protocol-stream/commit/75b9dcd544cec1aa4d1cc357f300429af86736e4
const defaultDataHandler = async () =>
  IlpPacket.serializeIlpReject({
    code: 'F02', // Unreachable
    data: Buffer.alloc(0),
    message: '',
    triggeredBy: ''
  })

// Use the async version to prevent blocking the event loop:
// https://nodejs.org/en/docs/guides/dont-block-the-event-loop/#blocking-the-event-loop-node-core-modules
const generateSecret = async () => promisify(randomBytes)(32)

export interface IInvoice {
  readonly destinationAccount: string
  readonly sharedSecret: Buffer
  readonly amount: BigNumber
}

export interface IContinueStream {
  readonly exchangeRate: BigNumber
  readonly streamMoney: () => Promise<void>
}

export abstract class Ledger extends EventEmitter {
  public abstract readonly assetCode: string
  public abstract readonly assetScale: number
  public abstract readonly remoteConnectors: {
    readonly testnet: {
      readonly [name: string]: string
    }
    readonly mainnet: {
      readonly [name: string]: string
    }
  }

  protected abstract readonly maxInFlight: BigNumber

  protected plugin?: IPlugin
  protected readonly store: IStore = new MemoryStore()

  protected streamServer?: IlpStream.Server
  protected streamClientHandler: IDataHandler = defaultDataHandler
  protected streamServerHandler: IDataHandler = defaultDataHandler

  /**
   * Connect a plugin, prefund it, and create it to receive payments
   * @param serverUri Uri and secret of the server to connect over BTP
   */
  public async connect(serverUri: string): Promise<void> {
    const streamSecret = await generateSecret()

    const plugin = await this.createPlugin(serverUri)
    await plugin.connect()

    // TODO Should the Stream server expose the sourceAddress directly?
    // - Should this set the assetScale / assetCode on this ledger?
    // - What if it's different from the configured assetScale / assetCode? Fail?
    const { clientAddress } = await fetch((data: Buffer) =>
      plugin.sendData(data)
    )

    plugin.registerDataHandler(async (data: Buffer) => {
      let prepare: IlpPacket.IlpPrepare
      try {
        prepare = IlpPacket.deserializeIlpPrepare(data)
      } catch (err) {
        // If packet is malformed/not a prepare, route to Stream server for error handling
        return this.streamServerHandler(data)
      }

      const localAddressParts = prepare.destination
        .replace(clientAddress + '.', '')
        .split('.')
      if (localAddressParts.length === 0 || !localAddressParts[0]) {
        // Connection ID exists in the ILP address, so route to Stream server
        return this.streamServerHandler(data)
      } else {
        // ILP address is for the root plugin, so route to Stream sending connection
        return this.streamClientHandler(data)
      }
    })

    // Setup a STREAM server for receiving
    this.streamServer = await IlpStream.createServer({
      idleTimeout: 360000, // Destroy connection after 6 minutes of inactivity
      plugin: this.wrapStreamPlugin(plugin, {
        deregisterDataHandler: () => {
          this.streamServerHandler = defaultDataHandler
        },
        registerDataHandler: handler => {
          this.streamServerHandler = handler
        }
      }),
      receiveOnly: true,
      serverSecret: streamSecret
    })

    this.streamServer.on('connection', (conn: IlpStream.Connection) => {
      conn.on('stream', (stream: IlpStream.DataAndMoneyStream) => {
        stream.setReceiveMax(Infinity)
      })
    })

    if (typeof this.setupPlugin === 'function') {
      return this.setupPlugin()
    }

    this.plugin = plugin
  }

  /**
   * Generate credentials to accept incoming payments from a new connection
   * @param amount Amount to send to the Stream server
   */
  public createInvoice(amount: BigNumber): IInvoice {
    if (!this.streamServer) {
      throw new Error('Stream server is not connected')
    }

    return {
      amount,
      ...this.streamServer.generateAddressAndSecret()
    }
  }

  /**
   * Exchange assets directly between this ledger and the given receiving ledger
   * @param ledger Instance of the receiving ledger
   * @param amount Amount to send in base units of sending ledger
   */
  public async exchange({
    ledger,
    amount
  }: {
    readonly ledger: Ledger
    readonly amount: BigNumber
  }): Promise<IContinueStream> {
    try {
      const invoice = ledger.createInvoice(amount)

      // TODO Do fx/use backend to see if the exchnage rate is reasonable, then continue

      return this.startStream(invoice)
    } catch (err) {
      throw new Error('TODO')
    }
  }

  /**
   * Send payments to given SPSP receiver
   * @param receiver Payment pointer or URL for SPSP endpoint
   */
  public async pay(
    receiver: string,
    amount: BigNumber
  ): Promise<IContinueStream> {
    const endpoint = new URL(
      receiver.startsWith('$') ? 'https://' + receiver.substring(1) : receiver
    )

    try {
      const { data } = await axios(endpoint.href, {
        headers: {
          accept: 'application/spsp4+json, application/spsp+json'
        }
      })

      const invoice: IInvoice = {
        destinationAccount: data.destination_account,
        sharedSecret: Buffer.from(data.shared_secret, 'base64'),
        amount
      }

      return this.startStream(invoice)
    } catch (err) {
      throw new Error('TODO')
    }
  }

  public async disconnect() {
    if (this.streamServer) {
      // If an exchange just occured, wait for settlements to finish
      await new Promise(r => setTimeout(r, 3000))

      this.streamServer.removeAllListeners()
      this.streamServer.close()
    }

    if (this.plugin) {
      return this.plugin.disconnect()
    }
  }

  protected abstract createPlugin(serverUri: string): Promise<IPlugin>

  // TODO Should this exist, or not?
  protected setupPlugin(): Promise<void> {
    return Promise.resolve()
  }

  protected abstract destroyPlugin(plugin: IPlugin): Promise<void>

  protected async startStream({
    destinationAccount,
    sharedSecret,
    amount
  }: IInvoice): Promise<IContinueStream> {
    if (!this.plugin) {
      throw new Error('TODO')
    }

    const plugin = this.wrapStreamPlugin(this.plugin, {
      // Register handlers so we can do our own routing
      registerDataHandler: handler => {
        this.streamClientHandler = handler
      },
      deregisterDataHandler: () => {
        this.streamClientHandler = defaultDataHandler
      },
      // Overwrite disconnect so the plugin stays connected after this connection is closed
      disconnect() {
        return Promise.resolve()
      }
    })

    // Setup the sender (Stream client)
    const conn = await IlpStream.createConnection({
      plugin,
      destinationAccount,
      sharedSecret,
      slippage: 0.02, // Max of 2% fluxuation in exchange rate
      idleTimeout: 360000 // Destroy connection after 6 minutes of inactivity
    })

    const stream = conn.createStream()

    return {
      exchangeRate: new BigNumber(conn.minimumAcceptableExchangeRate),
      streamMoney: async () => {
        await Promise.race([
          stream.sendTotal(amount, {
            timeout: 360000
          }),
          new Promise(resolve => stream.on('end', resolve))
        ])

        stream.removeAllListeners()
        conn.removeAllListeners()

        // Since the stream server is still alive, for exchanges, later settlements from connector will still be accepted
        return conn.destroy()
      }
    }
  }

  private wrapStreamPlugin(
    plugin: IPlugin,
    custom: Partial<IStreamPlugin>
  ): IStreamPlugin {
    return {
      connect: plugin.connect,
      disconnect: plugin.disconnect,
      isConnected: plugin.isConnected,
      sendData: plugin.sendData,
      registerDataHandler: plugin.registerDataHandler,
      deregisterDataHandler: plugin.deregisterDataHandler,
      ...custom
    }
  }
}
