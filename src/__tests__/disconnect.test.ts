import anyTest, { TestInterface, ExecutionContext } from 'ava'
import 'envkey'
import { SwitchApi, connect, LedgerEnv, ReadyUplinks } from '..'
import { addXrp, addEth, addBtc, testExchange } from './_helpers'
import BigNumber from 'bignumber.js'

const test = anyTest as TestInterface<SwitchApi>

// Before & after each test, construct and disconnect the API

test.beforeEach(async t => {
  t.context = await connect(process.env.LEDGER_ENV! as LedgerEnv)
})

test('after connect', async t => {
  await t.notThrowsAsync(t.context.disconnect())
})

test('after add eth', async t => {
  const uplink = await addEth(1)(t.context)
  await t.notThrowsAsync(t.context.disconnect())
})

test('after deposit eth', async t => {
  const uplink = await addEth(1)(t.context)
  const openAmount = new BigNumber(0.01)
  await t.context.deposit({
    uplink,
    amount: openAmount,
    authorize: () => Promise.resolve()
  })
  await t.notThrowsAsync(t.context.disconnect())
})

test('after withdraw eth', async t => {
  const uplink = await addEth(1)(t.context)
  const openAmount = new BigNumber(0.01)
  await t.context.deposit({
    uplink,
    amount: openAmount,
    authorize: () => Promise.resolve()
  })
  await t.context.withdraw({ uplink, authorize: () => Promise.resolve() })
  await t.notThrowsAsync(t.context.disconnect())
})

// TODO test the other assets
// TODO maybe refactor the helpers to include a generic deposit method
