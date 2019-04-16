import { AssetUnit, convert, usd } from '@kava-labs/crypto-rate-utils'
import anyTest, { ExecutionContext, TestInterface } from 'ava'
import BigNumber from 'bignumber.js'
import { unlink } from 'fs'
import { promisify } from 'util'
import { connect, LedgerEnv, ReadyUplinks, IlpSdk } from '..'
import { CONFIG_PATH } from '../config'
import { addEth, addXrp, captureFeesFrom } from './helpers'
require('envkey')

const test = anyTest as TestInterface<IlpSdk>

// Before & after each test, construct and disconnect the API

test.beforeEach(async t => {
  // Delete any existing config
  await promisify(unlink)(CONFIG_PATH).catch(() => Promise.resolve())
  t.context = await connect(process.env.LEDGER_ENV! as LedgerEnv)
})

test.afterEach(async t => t.context.disconnect())

// Helper to test deposit and withdraw on uplinks
export const testFunding = (
  createUplink: (api: IlpSdk) => Promise<ReadyUplinks>
) => async (t: ExecutionContext<IlpSdk>) => {
  // SETUP ------------------------------------------

  const { state, deposit, withdraw, streamMoney, getBaseBalance } = t.context
  const uplink = await createUplink(t.context)

  const settler = state.settlers[uplink.settlerType]

  // Instead down to the base unit of the ledger if there's more precision than that
  const toUplinkUnit = (unit: AssetUnit) =>
    convert(unit, settler.exchangeUnit(), state.rateBackend).decimalPlaces(
      settler.exchangeUnit().exchangeUnit,
      BigNumber.ROUND_DOWN
    )
  // capture reported fee from deposit and withdraw functions
  const depositAndCapture = (amount: BigNumber) =>
    captureFeesFrom(authorize => deposit({ uplink, amount, authorize }))
  const withdrawAndCapture = () =>
    captureFeesFrom(authorize => withdraw({ uplink, authorize }))

  // TEST DEPOSIT (CHANNEL OPEN) ---------------------

  t.true(uplink.balance$.value.isZero(), 'initial layer 2 balance is 0')

  // TODO Issue with xrp: openAmount has 9 digits of precision, but balance$ only has 6!
  // e.g. openAmount === "2.959676012", uplink.balance$ === "2.959676"

  const initialBaseBalance = await getBaseBalance(uplink)
  const openAmount = toUplinkUnit(usd(1))
  const channelOpenValueAndFee = await depositAndCapture(openAmount)

  t.true(
    uplink.balance$.value.isEqualTo(openAmount),
    'balance$ correctly reflects the initial channel open'
  )
  const baseBalanceAfterOpen = await getBaseBalance(uplink)
  t.true(
    initialBaseBalance
      .minus(baseBalanceAfterOpen)
      .isEqualTo(openAmount.plus(channelOpenValueAndFee.fee)),
    'after channel open, base balance is reduced by exactly the reported fee + open amount'
  )
  t.true(
    openAmount.isEqualTo(channelOpenValueAndFee.value),
    'authorize reports correct value for open amount'
  )
  t.true(
    uplink.incomingCapacity$.value.isGreaterThan(new BigNumber(0)),
    'there is incoming capacity to us after a deposit'
  )

  // TEST DEPOSIT (TOP UP) ----------------------------

  const depositAmount = toUplinkUnit(usd(2))
  const depositValueAndFee = await depositAndCapture(depositAmount)
  t.true(
    uplink.balance$.value.isEqualTo(openAmount.plus(depositAmount)),
    'balance$ correctly reflects the deposit to the channel'
  )
  const baseBalanceAfterDeposit = await getBaseBalance(uplink)
  t.true(
    baseBalanceAfterOpen
      .minus(baseBalanceAfterDeposit)
      .isEqualTo(depositAmount.plus(depositValueAndFee.fee)),
    'after deposit, base balance is reduced by exactly the reported fee + deposit amount'
  )
  t.true(
    depositAmount.isEqualTo(depositValueAndFee.value),
    'authorize reports correct value for deposit amount'
  )

  // TEST WITHDRAW ----------------------------------------

  // Rebalance so there's some money in both the incoming & outgoing channels
  await t.notThrowsAsync(
    streamMoney({
      amount: toUplinkUnit(usd(1.1)),
      source: uplink,
      dest: uplink
    }),
    'uplink can stream money to itself'
  )

  const withdrawAmount = uplink.balance$.value
  const withdrawValueAndFee = await withdrawAndCapture()

  t.true(
    uplink.balance$.value.isZero(),
    'balance$ of uplink goes back to zero following a withdraw'
  )
  const baseBalanceAfterWithdraw = await getBaseBalance(uplink)
  t.true(
    baseBalanceAfterWithdraw
      .minus(baseBalanceAfterDeposit)
      .isLessThanOrEqualTo(withdrawAmount),
    'after withdraw, base balance is increased no more than the withdraw amount'
  )
  t.true(
    baseBalanceAfterWithdraw
      .minus(baseBalanceAfterDeposit)
      .isGreaterThanOrEqualTo(withdrawAmount.minus(withdrawValueAndFee.fee)),
    'after withdraw, base balance is increased by at least the withdraw amount minus reported fee'
  )
  t.true(
    withdrawAmount.isEqualTo(withdrawValueAndFee.value),
    'authorize reports correct value for withdraw amount'
  )
}

test('eth: deposit & withdraw', testFunding(addEth()))
test('xrp: deposit & withdraw', testFunding(addXrp()))
