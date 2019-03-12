import { promisify } from 'util'
import { unlink } from 'fs'
import anyTest, { TestInterface, ExecutionContext } from 'ava'
import 'envkey'
import { SwitchApi, connect, LedgerEnv, ReadyUplinks } from '..'
import { CONFIG_PATH } from '../config'
import { addEth, addXrp, createFundedUplink } from './helpers'

const test = anyTest as TestInterface<SwitchApi>

// Before & after each test, construct and disconnect the API

test.beforeEach(async t => {
  // Delete any existing config
  await promisify(unlink)(CONFIG_PATH).catch(() => Promise.resolve())
  t.context = await connect(process.env.LEDGER_ENV! as LedgerEnv)
})

test.afterEach(async t => {
  await t.context.disconnect()
})

const testWithdrawWithoutDeposit = (
  createUplink: (api: SwitchApi) => Promise<ReadyUplinks>
) => async (t: ExecutionContext<SwitchApi>) => {
  const uplink = await createFundedUplink(t.context)(createUplink)

  await t.notThrowsAsync(
    t.context.withdraw({ uplink, authorize: () => Promise.resolve() })
  )
}

const testDoubleWithdraw = (
  createUplink: (api: SwitchApi) => Promise<ReadyUplinks>
) => async (t: ExecutionContext<SwitchApi>) => {
  const uplink = await createFundedUplink(t.context)(createUplink)
  await t.context.withdraw({ uplink, authorize: () => Promise.resolve() })

  await t.notThrowsAsync(
    t.context.withdraw({ uplink, authorize: () => Promise.resolve() })
  )
}

test('xrp: without deposit', testWithdrawWithoutDeposit(addXrp()))
test('eth: without deposit', testWithdrawWithoutDeposit(addEth()))
test('xrp: after successful withdraw', testDoubleWithdraw(addXrp()))
test('eth: after successful withdraw', testDoubleWithdraw(addEth()))
