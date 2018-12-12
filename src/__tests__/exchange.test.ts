import {
  connectCoinCap,
  convert,
  RateApi,
  usd
} from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'

import {
  Btc as BtcLedger,
  Eth as EthLedger,
  Ledger,
  Xrp as XrpLedger
} from '..'

import anyTest, { TestInterface } from 'ava'
import 'envkey'
import { performance } from 'perf_hooks'
import { streamMoney } from '../utils/stream'

process.env.LEDGER_ENV = process.env.LEDGER_ENV || 'testnet'

BigNumber.config({ EXPONENTIAL_AT: 1e9 }) // Almost never use exponential notation

const test = anyTest as TestInterface<{
  rateApi: RateApi
}>

type CreateLedger = (rateBackend: RateApi) => Ledger

const Eth = (rateBackend: RateApi) =>
  new EthLedger({
    ethereumPrivateKey: process.env.ETH_PRIVATE_KEY_CLIENT_1,
    rateBackend
  })

const Xrp = (rateBackend: RateApi) =>
  new XrpLedger({
    xrpSecret: process.env.XRP_SECRET_CLIENT_1,
    rateBackend
  })

const Btc = (rateBackend: RateApi) =>
  new BtcLedger({
    lndPubKey: process.env.LIGHTNING_LND_IDENTITY_PUBKEY_CLIENT_1,
    lndHost: process.env.LIGHTNING_LND_HOST_CLIENT_1,
    tlsCert: process.env.LIGHTNING_TLS_CERT_PATH_CLIENT_1,
    macaroon: process.env.LIGHTNING_MACAROON_PATH_CLIENT_1,
    rateBackend
  })

test.before(async t => {
  t.context.rateApi = await connectCoinCap()
})

const RECEIVE_AMOUNT_USD = 2

// TODO Eliminate testName?
const exchange = async (
  createSource: CreateLedger,
  createDest: CreateLedger,
  testName: string
) =>
  test(testName, async t => {
    const rateApi = t.context.rateApi
    const source = createSource(rateApi)
    const dest = createDest(rateApi)

    await Promise.all([source.connect(), dest.connect()])

    let actualReceived = new BigNumber(0)

    const doneSending = (received: BigNumber) =>
      convert(dest.baseUnit(received), usd(), rateApi).gt(RECEIVE_AMOUNT_USD)

    const shouldFulfill = (
      sourceAmount: BigNumber,
      destAmount: BigNumber
    ): boolean => {
      const minDestAmount = convert(
        source.baseUnit(sourceAmount),
        dest.baseUnit(),
        rateApi
      )
        .times(0.98) // TODO min slippage !
        .integerValue(BigNumber.ROUND_DOWN)

      // TODO Add logs here for the specific errors
      const willFulfill =
        destAmount.gte(minDestAmount) && !doneSending(actualReceived)
      if (willFulfill) {
        actualReceived = actualReceived.plus(destAmount)
      }

      return willFulfill
    }

    const nextPacketAmount = (maxPacketAmount: BigNumber) =>
      doneSending(actualReceived) ? new BigNumber(0) : maxPacketAmount

    // TODO Handle the unhandled rejections from XRP (why!?)
    // await t.notThrowsAsync(async () => {
    const start = performance.now()
    await streamMoney({ source, dest, shouldFulfill, nextPacketAmount })
    t.log(`time: ${performance.now() - start} ms`)
    // })

    t.true(actualReceived.gte(RECEIVE_AMOUNT_USD))

    await Promise.all([source.disconnect(), dest.disconnect()])
  })

// Run the actual tests for each trading pair
exchange(Eth, Xrp, 'eth -> xrp')
exchange(Eth, Btc, 'eth -> btc')
exchange(Xrp, Btc, 'xrp -> btc')
exchange(Xrp, Eth, 'xrp -> eth')
exchange(Btc, Eth, 'btc -> eth')
exchange(Btc, Xrp, 'btc -> xrp')
