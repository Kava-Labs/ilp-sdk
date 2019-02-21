import anyTest, { TestInterface, ExecutionContext } from 'ava'
import 'envkey'
import { SwitchApi, connect, LedgerEnv, ReadyUplinks } from '..'
import { addXrp, addEth, addBtc, testExchange } from './_helpers'

const test = anyTest as TestInterface<SwitchApi>

// Before & after each test, construct and disconnect the API

test.beforeEach(async t => {
  t.context = await connect(process.env.LEDGER_ENV! as LedgerEnv)
})

test.afterEach(async t => t.context.disconnect())

const testAddRemove = (
  createUplink: (api: SwitchApi) => Promise<ReadyUplinks>
) => async (t: ExecutionContext<SwitchApi>) => {

  const uplink = await createUplink(t.context)
  t.true(t.context.state.uplinks.includes(uplink))
  
  await t.context.remove(uplink)
  t.false(t.context.state.uplinks.includes(uplink))
}

test('add then remove btc', testAddRemove(addBtc(1)))
test('add then remove eth', testAddRemove(addEth(1)))
test('add then remove xrp', testAddRemove(addXrp(1)))
