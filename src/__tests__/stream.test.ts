import anyTest, { TestInterface } from 'ava'
import { SwitchApi, connect, LedgerEnv } from '..'
import { addEth, addXrp, addBtc, testFunding, testExchange } from './_helpers'

const test = anyTest as TestInterface<SwitchApi>

// Before & after each test, construct and disconnect the API

test.beforeEach(async t => {
  t.context = await connect(process.env.LEDGER_ENV! as LedgerEnv)
})

test.afterEach(async t => t.context.disconnect())

test('eth deposits & withdrawals', testFunding(addEth(1)))
test('xrp deposits & withdrawals', testFunding(addXrp(1)))

test('xrp -> eth', testExchange(addXrp(1), addEth(1)))
test('xrp -> btc', testExchange(addXrp(1), addBtc(1)))
test('btc -> eth', testExchange(addBtc(1), addEth(1)))
test('btc -> xrp', testExchange(addBtc(1), addXrp(1)))
test('eth -> btc', testExchange(addEth(1), addBtc(1)))
test('eth -> xrp', testExchange(addEth(1), addXrp(1)))
