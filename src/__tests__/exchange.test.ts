import anyTest, { TestInterface, ExecutionContext } from 'ava'
import { IlpSdk, connect, LedgerEnv, ReadyUplinks } from '..'
import { addEth, addXrp, addBtc, createFundedUplink, addDai } from './helpers'
import {
  convert,
  exchangeQuantity,
  exchangeUnit
} from '@kava-labs/crypto-rate-utils'
import { performance } from 'perf_hooks'
import { usdAsset, getAssetScale } from '../assets'
require('envkey')

const test = anyTest as TestInterface<IlpSdk>

// Before & after each test, construct and disconnect the API

test.beforeEach(async t => {
  t.context = await connect(process.env.LEDGER_ENV! as LedgerEnv)
})

// TODO Turn this into a generic helper
test.afterEach(async t => t.context.disconnect())

export const testExchange = (
  createSource: (api: IlpSdk) => Promise<ReadyUplinks>,
  createDest: (api: IlpSdk) => Promise<ReadyUplinks>
) => async (t: ExecutionContext<IlpSdk>) => {
  const api = t.context
  const { state, streamMoney } = api

  const [sourceUplink, destUplink] = await Promise.all([
    createFundedUplink(api)(createSource),
    createFundedUplink(api)(createDest)
  ])

  // TODO Without this pause, Lnd -> Lnd will fail
  await new Promise(r => setTimeout(r, 3000))

  const initialSourceBalance = sourceUplink.balance$.value
  const initialDestBalance = destUplink.balance$.value

  const amountToSend = convert(
    exchangeQuantity(usdAsset, 2),
    exchangeUnit(sourceUplink.asset),
    state.rateBackend
  ).amount.decimalPlaces(getAssetScale(sourceUplink.asset))

  const start = performance.now()
  await t.notThrowsAsync(
    streamMoney({
      amount: amountToSend,
      source: sourceUplink,
      dest: destUplink
    })
  )
  t.log(`time: ${performance.now() - start} ms`)

  // TODO Wait up to 2 seconds for the final settlements to come in
  await new Promise(r => setTimeout(r, 2000))

  const finalSourceBalance = sourceUplink.balance$.value
  t.true(
    initialSourceBalance.minus(amountToSend).isEqualTo(finalSourceBalance),
    'source balance accurately represents the amount that was sent'
  )

  const estimatedReceiveAmount = convert(
    exchangeQuantity(sourceUplink.asset, amountToSend),
    exchangeUnit(destUplink.asset),
    state.rateBackend
  ).amount

  const estimatedDestFinalBalance = initialDestBalance.plus(
    estimatedReceiveAmount
  )

  const finalDestBalance = destUplink.balance$.value
  t.true(
    finalDestBalance.isGreaterThan(estimatedDestFinalBalance.times(0.99)) &&
      finalDestBalance.isLessThan(estimatedDestFinalBalance.times(1.01)),
    'destination balance accounts for the amount that was sent, with margin for exchange rate fluctuations'
  )
}

test('xrp -> eth', testExchange(addXrp(), addEth()))
test('xrp -> btc', testExchange(addXrp(), addBtc()))
test('xrp -> xrp', testExchange(addXrp(), addXrp(2)))

test('btc -> eth', testExchange(addBtc(), addEth()))
test('btc -> xrp', testExchange(addBtc(), addXrp()))
test('btc -> btc', testExchange(addBtc(), addBtc(2)))

test('eth -> btc', testExchange(addEth(), addBtc()))
test('eth -> xrp', testExchange(addEth(), addXrp()))
test('eth -> eth', testExchange(addEth(), addEth(2)))

// Since DAI and ETH are similar, only perform a subset of pairs for DAI
test('btc -> dai', testExchange(addBtc(), addDai()))
test('dai -> xrp', testExchange(addDai(), addXrp()))
test('dai -> dai', testExchange(addDai(), addDai(2)))
