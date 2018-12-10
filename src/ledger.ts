import { AssetUnit, convert, RateApi, usd } from '@kava-labs/crypto-rate-utils'
import axios from 'axios'
import BigNumber from 'bignumber.js'
import EventEmitter from 'eventemitter3'
import {
  deserializeIlpPrepare,
  deserializeIlpReply,
  IlpPrepare,
  IlpReply,
  serializeIlpPrepare,
  serializeIlpReply
} from 'ilp-packet'
import {
  MemoryStore,
  Store as IStore
} from 'ilp-plugin-ethereum/build/utils/store' // TODO Can I eliminate this? Antipattern
import { fetch } from 'ilp-protocol-ildcp'
import * as IlpStream from 'ilp-protocol-stream'
import { Plugin as IStreamPlugin } from 'ilp-protocol-stream/src/util/plugin-interface'
import { generateSecret, generateToken } from './utils/crypto'
import { defaultDataHandler } from './utils/packet'
import { DataHandler3, IDataHandler, IPlugin, IPlugin3 } from './utils/types'

// TODO Ledgers should probably expose a method to format a unit/BigNum
// as some of its native currency

// TODO LEDGER_ENV is inconsistent with envkeys!
// TODO Remove this? Should this be a config option? Where else is it used?
process.env.LEDGER_ENV = 'local'

export interface ILedgerOpts {
  readonly rateBackend: RateApi
}

export interface IInvoice {
  readonly destinationAccount: string
  readonly sharedSecret: Buffer
}

export interface IContinueStream {
  readonly exchangeRate: BigNumber
  readonly streamMoney: (amount: BigNumber) => Promise<void>
}

interface IConnectorList {
  readonly [name: string]: (token: string) => string
}

interface IldcpInfo {
  clientAddress: string
  assetScale: number
  assetCode: string
}

export abstract class Ledger extends EventEmitter {
  /** Unit used as the base of the plugin, for conversions */
  public abstract readonly baseUnit: (amount?: BigNumber.Value) => AssetUnit
  /** Unit of exchange, for conversions */
  public abstract readonly exchangeUnit: (amount?: BigNumber.Value) => AssetUnit
  public abstract readonly remoteConnectors: {
    readonly local: IConnectorList
    readonly testnet: IConnectorList
    readonly mainnet: IConnectorList
  }

  protected plugin?: IPlugin3
  protected readonly store: IStore = new MemoryStore()

  protected streamServer?: IlpStream.Server
  protected streamClientHandler: DataHandler3
  protected streamServerHandler: IDataHandler = defaultDataHandler

  protected readonly rateBackend: RateApi

  protected ildcpInfo: IldcpInfo

  constructor({ rateBackend }: ILedgerOpts) {
    super()

    this.rateBackend = rateBackend
  }

  public get maxInFlight(): BigNumber {
    return convert(usd(0.1), this.baseUnit(), this.rateBackend)
  }

  public get clientAddress(): string {
    return this.ildcpInfo.clientAddress
  }

  public get assetCode(): string {
    return this.ildcpInfo.assetCode
  }

  public get assetScale(): number {
    return this.ildcpInfo.assetScale
  }

  /** Send packets through this plugin */
  public sendData(data: IlpPrepare): Promise<IlpReply> {
    return this.plugin.sendData(data)
  }

  /**
   * Handle incoming packets without a connection tag
   * (e.g. for exchanges, and not receiving via Stream server)
   */
  public registerDataHandler(handler: DataHandler3): void {
    this.streamClientHandler = handler
  }

  /**
   * Connect a plugin, prefund it, and enable incoming payments
   * @param serverUri Full uri (scheme, secret, host, port) of the server to connect over BTP
   */
  public async connect(serverUri?: string): Promise<void> {
    const createBtpUri = this.remoteConnectors[
      process.env.LEDGER_ENV as 'local' | 'test' | 'live' // TODO this is actually wrong lol
    ]['Kava Labs']
    serverUri = serverUri || createBtpUri(await generateToken())

    const plugin = await this.createPlugin(serverUri)
    await plugin.connect()

    /**
     * TODO
     * 1. Submit PR to Stream to expose sourceAccount on server
     * 2. Move data & money handler registration to after stream server
     * 3. Use serverAccount on server as the clientAddress for routing
     * 4. Check to make sure assetScale / assetCode is the same as the configured ledger
     */

    this.ildcpInfo = await fetch(async (data: Buffer) =>
      serializeIlpReply(await plugin.sendData(deserializeIlpPrepare(data)))
    )

    plugin.registerMoneyHandler(async amount => {
      this.emit('moneyIn', amount)
    })

    plugin.registerDataHandler(async (prepare: IlpPrepare) => {
      const hasConnectionTag = prepare.destination
        .replace(this.ildcpInfo.clientAddress, '')
        .split('.')
        .some(a => !!a)
      if (hasConnectionTag) {
        // Connection ID exists in the ILP address, so route to Stream server
        // TODO !
        return deserializeIlpReply(
          await this.streamServerHandler(serializeIlpPrepare(prepare))
        )
      } else {
        // ILP address is for the root plugin, so route to Stream sending connection
        return this.streamClientHandler(prepare)
      }
    })

    // Setup a STREAM server for receiving
    // TODO This should be persisted, so we can still accept payments without exchanging new secrets
    // const streamSecret = await generateSecret()
    // this.streamServer = await IlpStream.createServer({
    //   idleTimeout: 360000, // Destroy connection after 6 minutes of inactivity
    //   plugin: this.wrapStreamPlugin(this.plugin, {
    //     registerDataHandler: handler => {
    //       this.streamServerHandler = handler
    //     },
    //     deregisterDataHandler: () => {
    //       this.streamServerHandler = defaultDataHandler
    //     }
    //   }),
    //   receiveOnly: true,
    //   serverSecret: streamSecret
    // })

    // this.streamServer.on('connection', (conn: IlpStream.Connection) => {
    //   conn.on('stream', (stream: IlpStream.DataAndMoneyStream) => {
    //     stream.setReceiveMax(Infinity)
    //   })
    // })

    this.plugin = plugin

    await this.setupPlugin()
  }

  /**
   * Exchange assets directly between this ledger and the given receiving ledger
   * @param destination Instance of the receiving ledger
   */
  // public async exchange({ streamServer }: Ledger): Promise<IContinueStream> {
  //   if (!streamServer) {
  //     throw new Error('Stream server is not connected')
  //   }

  //   // TODO Generate my own random connection tag?

  //   const invoice = streamServer.generateAddressAndSecret()
  //   return this.startStream(invoice)
  // }

  /**
   * Send payments to given SPSP receiver
   * @param receiver Payment pointer or URL for SPSP endpoint
   */
  // public async pay(receiver: string): Promise<IContinueStream> {
  //   const endpoint = new URL(
  //     receiver.startsWith('$') ? 'https://' + receiver.substring(1) : receiver
  //   )

  //   const { data } = await axios(endpoint.href, {
  //     headers: {
  //       accept: 'application/spsp4+json, application/spsp+json'
  //     }
  //   })

  //   return this.startStream({
  //     destinationAccount: data.destination_account,
  //     sharedSecret: Buffer.from(data.shared_secret, 'base64')
  //   })
  // }

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

  protected abstract createPlugin(serverUri: string): Promise<IPlugin3>

  protected setupPlugin(): Promise<void> {
    return Promise.resolve()
  }

  protected abstract destroyPlugin(plugin: IPlugin): Promise<void>

  // TODO Since I'm not streaming with stream anymore... can I eliminate this?
  // protected async startStream({
  //   destinationAccount,
  //   sharedSecret
  // }: IInvoice): Promise<IContinueStream> {
  //   if (!this.plugin) {
  //     throw new Error('Ledger must be connected before streaming money')
  //   }

  //   const plugin = this.wrapStreamPlugin(this.plugin, {
  //     // Register handlers so we can do our own routing
  //     registerDataHandler: handler => {
  //       this.streamClientHandler = handler
  //     },
  //     deregisterDataHandler: () => {
  //       this.streamClientHandler = defaultDataHandler
  //     },
  //     // Overwrite disconnect so the plugin stays connected after this connection is closed
  //     disconnect() {
  //       return Promise.resolve()
  //     }
  //   })

  //   // Setup the sender (Stream client)
  //   const conn = await IlpStream.createConnection({
  //     plugin,
  //     destinationAccount,
  //     sharedSecret,
  //     slippage: 0.02, // Max of 2% fluxuation in exchange rate
  //     idleTimeout: 360000 // Destroy connection after 6 minutes of inactivity
  //   })

  //   const stream = conn.createStream()

  //   return {
  //     exchangeRate: new BigNumber(conn.minimumAcceptableExchangeRate),
  //     streamMoney: async (amount: BigNumber) => {
  //       await stream.sendTotal(amount, {
  //         timeout: 360000
  //       })

  //       // TODO hook into destination ledger
  //       // Wait 500ms for packets to finish processing
  //       await new Promise(r => setTimeout(r, 500))

  //       stream.removeAllListeners()
  //       conn.removeAllListeners()

  //       // Since the stream server is still alive, for exchanges, later settlements from connector will still be accepted
  //       return conn.end()
  //     }
  //   }
  // }

  private wrapStreamPlugin(
    plugin: IPlugin,
    custom: Partial<IStreamPlugin>
  ): IStreamPlugin {
    return {
      connect() {
        return plugin.connect()
      },
      disconnect() {
        return plugin.disconnect()
      },
      isConnected() {
        return plugin.isConnected()
      },
      sendData(data: Buffer) {
        return plugin.sendData(data)
      },
      registerDataHandler(handler: IDataHandler) {
        return plugin.registerDataHandler(handler)
      },
      deregisterDataHandler() {
        return plugin.deregisterDataHandler()
      },
      ...custom
    }
  }
}
