import anyTest, { TestInterface } from 'ava'
import { SwitchApi, connect, LedgerEnv } from '..'
import { addEth, addXrp, addBtc, testFunding, testExchange } from './_helpers'
import { promisify } from 'util'
import { unlink } from 'fs'
import { CONFIG_PATH } from '../config'

const test = anyTest as TestInterface<SwitchApi>

// Before & after each test, construct and disconnect the API

test.beforeEach(async t => {
  // Delete any existing config
  await promisify(unlink)(CONFIG_PATH).catch(() => Promise.resolve())
  t.context = await connect(process.env.LEDGER_ENV! as LedgerEnv)
})

test.afterEach(async t => t.context.disconnect())

test('deposit & withdraw eth', testFunding(addEth(1)))
test('deposit & withdraw xrp', testFunding(addXrp(1)))

test('xrp -> eth', testExchange(addXrp(1), addEth(1)))
test('xrp -> btc', testExchange(addXrp(1), addBtc(1)))
test('btc -> eth', testExchange(addBtc(1), addEth(1)))
test('btc -> xrp', testExchange(addBtc(1), addXrp(1)))
test('eth -> btc', testExchange(addEth(1), addBtc(1)))
test('eth -> xrp', testExchange(addEth(1), addXrp(1)))
