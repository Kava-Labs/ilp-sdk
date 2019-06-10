import {
  AssetQuantity,
  convert,
  exchangeQuantity,
  exchangeUnit
} from '@kava-labs/crypto-rate-utils'
import anyTest, { ExecutionContext, TestInterface } from 'ava'
import BigNumber from 'bignumber.js'
import { connect, IlpSdk, LedgerEnv, ReadyUplinks } from '..'
import { usdAsset } from '../assets'
import { addDai, addEth, addXrp, captureFeesFrom } from './helpers'
require('envkey')

const test = anyTest as TestInterface<IlpSdk>

// Before & after each test, construct and disconnect the API

test.beforeEach(async t => {
  t.context = await connect(process.env.LEDGER_ENV! as LedgerEnv)
})

test.afterEach(async t => t.context.disconnect())

// Helper to test deposit and withdraw on uplinks
export const testFunding = (
  createUplink: (api: IlpSdk) => Promise<ReadyUplinks>
) => async (t: ExecutionContext<IlpSdk>) => {
  const { state, deposit, withdraw, streamMoney, getBaseBalance } = t.context
  const uplink = await createUplink(t.context)

  // Instead down to the base unit of the ledger if there's more precision than that
  const toUplinkUnit = (unit: AssetQuantity) =>
    convert(
      unit,
      exchangeUnit(uplink.asset),
      state.rateBackend
    ).amount.decimalPlaces(uplink.asset.exchangeScale, BigNumber.ROUND_DOWN)

  const depositAndCapture = (amount: BigNumber) =>
    captureFeesFrom(authorize => deposit({ uplink, amount, authorize }))

  const withdrawAndCapture = () =>
    captureFeesFrom(authorize => withdraw({ uplink, authorize }))

  /**
   * Test deposit (channel open)
   */

  t.true(uplink.balance$.value.isZero(), 'initial layer 2 balance is 0')

  // TODO Issue with xrp: openAmount has 9 digits of precision, but balance$ only has 6!
  // e.g. openAmount === "2.959676012", uplink.balance$ === "2.959676"

  const initialBaseBalance = await getBaseBalance(uplink)
  const openAmount = toUplinkUnit(exchangeQuantity(usdAsset, 1))
  const channelOpenFee = await depositAndCapture(openAmount)

  t.true(
    uplink.balance$.value.isEqualTo(openAmount),
    'balance$ correctly reflects the initial channel open'
  )

  const baseBalanceAfterOpen = await getBaseBalance(uplink)
  const baseBalanceDecreaseAfterOpen = initialBaseBalance.amount.minus(
    baseBalanceAfterOpen.amount
  )

  // For Machinomy, base balance is in ETH, but deposits may be denominated in an ERC-20. If so, only check the fee
  const expectedBaseBalanceDecreaseAfterOpen =
    baseBalanceAfterOpen.symbol === uplink.asset.symbol
      ? openAmount.plus(channelOpenFee.amount)
      : channelOpenFee.amount

  // For Machinomy, one-time "unlocking" of ERC-20 transfers requires over-estimating the fee, so must use inequality
  t.true(
    baseBalanceDecreaseAfterOpen.isLessThanOrEqualTo(
      expectedBaseBalanceDecreaseAfterOpen
    ),
    'after channel open, base balance is reduced by no more than the reported fee + open amount'
  )

  t.true(
    uplink.incomingCapacity$.value.isGreaterThan(new BigNumber(0)),
    'peer opens incoming capacity after a deposit'
  )

  /**
   * Test deposit (top up)
   */

  const depositAmount = toUplinkUnit(exchangeQuantity(usdAsset, 2))
  const depositFee = await depositAndCapture(depositAmount)

  t.true(
    uplink.balance$.value.isEqualTo(openAmount.plus(depositAmount)),
    'balance$ correctly reflects the deposit to the channel'
  )

  const baseBalanceAfterDeposit = await getBaseBalance(uplink)
  const baseBalanceDecreaseAfterDeposit = baseBalanceAfterOpen.amount.minus(
    baseBalanceAfterDeposit.amount
  )
  const expectedBaseBalanceDecreaseAfterDeposit =
    baseBalanceAfterDeposit.symbol === uplink.asset.symbol
      ? depositAmount.plus(depositFee.amount)
      : depositFee.amount

  t.true(
    baseBalanceDecreaseAfterDeposit.isEqualTo(
      expectedBaseBalanceDecreaseAfterDeposit
    ),
    'after deposit, base balance is reduced by exactly the reported fee + deposit amount'
  )

  /**
   * Test withdraw
   */

  // Rebalance so there's some money in both the incoming & outgoing channels
  await t.notThrowsAsync(
    streamMoney({
      amount: toUplinkUnit(exchangeQuantity(usdAsset, 1.1)),
      source: uplink,
      dest: uplink
    }),
    'uplink can stream money to itself'
  )

  const withdrawAmount = uplink.balance$.value
  const withdrawFee = await withdrawAndCapture()

  t.true(
    uplink.balance$.value.isZero(),
    'balance$ of uplink goes back to zero following a withdraw'
  )

  const baseBalanceAfterWithdraw = await getBaseBalance(uplink)
  const baseBalanceIncreaseAfterWithdraw = baseBalanceAfterWithdraw.amount.minus(
    baseBalanceAfterDeposit.amount
  )
  const expectedBaseBalanceIncreaseAfterWithdraw =
    baseBalanceAfterWithdraw.symbol === uplink.asset.symbol
      ? withdrawAmount.minus(withdrawFee.amount)
      : withdrawFee.amount.negated()

  t.true(
    baseBalanceIncreaseAfterWithdraw.isLessThanOrEqualTo(withdrawAmount),
    'after withdraw, base balance is increased no more than the withdraw amount'
  )

  t.true(
    baseBalanceIncreaseAfterWithdraw.isGreaterThanOrEqualTo(
      expectedBaseBalanceIncreaseAfterWithdraw
    ),
    'after withdraw, base balance is increased by at least the withdraw amount minus reported fee'
  )
}

test('dai: deposit & withdraw', testFunding(addDai()))
test('eth: deposit & withdraw', testFunding(addEth()))
test('xrp: deposit & withdraw', testFunding(addXrp()))
