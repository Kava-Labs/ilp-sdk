import anyTest, { TestInterface } from 'ava'
import 'envkey'
import { SwitchApi, connect, LedgerEnv, ReadyUplinks } from '..'
import { addXrp, addEth, addBtc, testExchange } from './_helpers'

const test = anyTest as TestInterface<SwitchApi>

// Before & after each test, construct and disconnect the API

test.beforeEach(async t => {
  t.context = await connect(process.env.LEDGER_ENV! as LedgerEnv)
})

test.afterEach(async t => t.context.disconnect())

test('xrp -> xrp different credentials', testExchange(addXrp(1), addXrp(2)))
test('eth -> eth different credentials', testExchange(addEth(1), addEth(2)))
test('btc -> btc different credentials', testExchange(addBtc(2), addBtc(1)))
