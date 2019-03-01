import { AssetUnit, convert, usd } from '@kava-labs/crypto-rate-utils'
import anyTest, { ExecutionContext, TestInterface } from 'ava'
import BigNumber from 'bignumber.js'
import { unlink } from 'fs'
import { promisify } from 'util'
import { connect, LedgerEnv, ReadyUplinks, SwitchApi } from '..'
import { CONFIG_PATH } from '../config'
import { addEth, addXrp } from './helpers'
require('envkey')

const test = anyTest as TestInterface<SwitchApi>

// Before & after each test, construct and disconnect the API

test.beforeEach(async t => {
  // Delete any existing config
  await promisify(unlink)(CONFIG_PATH).catch(() => Promise.resolve())
  t.context = await connect(process.env.LEDGER_ENV! as LedgerEnv)
})

test.afterEach(async t => t.context.disconnect())

// Helper to test deposit and withdraw on uplinks
export const testFunding = (
  createUplink: (api: SwitchApi) => Promise<ReadyUplinks>
) => async (t: ExecutionContext<SwitchApi>) => {
  const { state, deposit, withdraw, streamMoney } = t.context
  const uplink = await createUplink(t.context)

  const settler = state.settlers[uplink.settlerType]

  // Instead down to the base unit of the ledger if there's more precision than that
  const toUplinkUnit = (unit: AssetUnit) =>
    convert(unit, settler.exchangeUnit(), state.rateBackend).decimalPlaces(
      settler.exchangeUnit().exchangeUnit,
      BigNumber.ROUND_DOWN
    )

  t.true(uplink.balance$.value.isZero(), 'initial layer 2 balance is 0')

  // TODO Check base layer balances to make sure fees are also correctly reported!
  // TODO Check that incoming capacity is opened!

  // TODO Issue with xrp: openAmount has 9 digits of precision, but balance$ only has 6!
  // e.g. openAmount === "2.959676012", uplink.balance$ === "2.959676"

  const openAmount = toUplinkUnit(usd(1))
  await t.notThrowsAsync(
    deposit({
      uplink,
      amount: openAmount,
      authorize: () => Promise.resolve()
    }),
    'opens channel without throwing an error'
  )

  t.true(
    uplink.balance$.value.isEqualTo(openAmount),
    'balance$ correctly reflects the initial channel open'
  )

  const depositAmount = toUplinkUnit(usd(2))
  await t.notThrowsAsync(
    deposit({
      uplink,
      amount: depositAmount,
      authorize: () => Promise.resolve()
    }),
    'deposits to channel without throwing an error'
  )

  t.true(
    uplink.balance$.value.isEqualTo(openAmount.plus(depositAmount)),
    'balance$ correctly reflects the deposit to the channel'
  )

  // Rebalance so there's some money in both the incoming & outgoing channels
  await t.notThrowsAsync(
    streamMoney({
      amount: toUplinkUnit(usd(1.1)),
      source: uplink,
      dest: uplink
    }),
    'uplink can stream money to itself'
  )

  await t.notThrowsAsync(
    withdraw({ uplink, authorize: () => Promise.resolve() }),
    'withdraws from channel without throwing an error'
  )

  t.true(
    uplink.balance$.value.isZero(),
    'balance$ of uplink goes back to zero following a withdraw'
  )
}

test('eth: deposit & withdraw', testFunding(addEth()))
test('xrp: deposit & withdraw', testFunding(addXrp()))
