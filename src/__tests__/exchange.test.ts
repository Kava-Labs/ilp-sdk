import anyTest, { TestInterface, ExecutionContext } from 'ava'
import { SwitchApi, connect, LedgerEnv, ReadyUplinks } from '..'
import { addEth, addXrp, addBtc, createFundedUplink } from './helpers'
import { promisify } from 'util'
import { unlink } from 'fs'
import { CONFIG_PATH } from '../config'
import { convert, usd } from '@kava-labs/crypto-rate-utils'
import { performance } from 'perf_hooks'
require('envkey')

const test = anyTest as TestInterface<SwitchApi>

// Before & after each test, construct and disconnect the API

// TODO Turn this into a generic helper
test.beforeEach(async t => {
  // Delete any existing config
  await promisify(unlink)(CONFIG_PATH).catch(() => Promise.resolve())
  t.context = await connect(process.env.LEDGER_ENV! as LedgerEnv)
})

// TODO Turn this into a generic helper
test.afterEach(async t => t.context.disconnect())

export const testExchange = (
  createSource: (api: SwitchApi) => Promise<ReadyUplinks>,
  createDest: (api: SwitchApi) => Promise<ReadyUplinks>
) => async (t: ExecutionContext<SwitchApi>) => {
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

  const sourceSettler = state.settlers[sourceUplink.settlerType]
  const destSettler = state.settlers[destUplink.settlerType]

  const amountToSend = convert(
    usd(2),
    sourceSettler.exchangeUnit(),
    state.rateBackend
  ).decimalPlaces(sourceSettler.assetScale)
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
    sourceSettler.exchangeUnit(amountToSend),
    destSettler.exchangeUnit(),
    state.rateBackend
  )
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
test('btc -> eth', testExchange(addBtc(), addEth()))
test('btc -> xrp', testExchange(addBtc(), addXrp()))
test('eth -> btc', testExchange(addEth(), addBtc()))
test('eth -> xrp', testExchange(addEth(), addXrp()))
test('xrp -> xrp', testExchange(addXrp(), addXrp(2)))
test('eth -> eth', testExchange(addEth(), addEth(2)))
test('btc -> btc', testExchange(addBtc(), addBtc(2)))
