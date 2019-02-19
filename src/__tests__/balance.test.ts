import { AssetUnit, convert, usd } from '@kava-labs/crypto-rate-utils'
import anyTest, { ExecutionContext, TestInterface } from 'ava'
import 'envkey'
import { ReadyUplinks } from 'uplink'
import { Api, connect, LedgerEnv } from '..'
import { SettlementEngineType } from '../engine'
import BigNumber from 'bignumber.js'

const test = anyTest as TestInterface<Api>

export const addMachinomy = ({ add }: Api): Promise<ReadyUplinks> =>
  add({
    settlerType: SettlementEngineType.Machinomy,
    privateKey: process.env.ETH_PRIVATE_KEY_CLIENT_1!
  })

export const addLnd = ({ add }: Api): Promise<ReadyUplinks> =>
  add({
    settlerType: SettlementEngineType.Lnd,
    hostname: process.env.LIGHTNING_LND_HOST_CLIENT_1!,
    tlsCert: process.env.LIGHTNING_TLS_CERT_PATH_CLIENT_1!,
    macaroon: process.env.LIGHTNING_MACAROON_PATH_CLIENT_1!,
    grpcPort: parseInt(process.env.LIGHTNING_LND_GRPCPORT_CLIENT_1!, 10)
  })

export const addXrpPaychan = ({ add }: Api): Promise<ReadyUplinks> =>
  add({
    settlerType: SettlementEngineType.XrpPaychan,
    secret: process.env.XRP_SECRET_CLIENT_1!
  })

// Before & after each test, construct and disconnect the API

test.beforeEach(async t => {
  t.context = await connect(LedgerEnv.Local)
})

test.afterEach(async t => t.context.disconnect())

const testFunding = (
  createUplink: (api: Api) => Promise<ReadyUplinks>
) => async (t: ExecutionContext<Api>) => {
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

  /**
   * TODO Issue with xrp: openAmount has 9 digits of precision, but balance$ only has 6!
   * e.g. openAmount === "2.959676012", uplink.balance$ === "2.959676"
   */

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

  // TODO Test that balance is correct

  await t.notThrowsAsync(
    withdraw({ uplink, authorize: () => Promise.resolve() }),
    'withdraws from channel without throwing an error'
  )

  t.true(
    uplink.balance$.value.isZero(),
    'balance$ of uplink goes back to zero following a withdraw'
  )
}

// test('machinomy deposits & withdrawals', testFunding(addMachinomy))
test('xrp-paychan deposits & withdrawals', testFunding(addXrpPaychan))

// TODO Perform streaming exchanges for all 6 trading pairs
//      (to make it simple, I could call deposit on each of them -- it'd just be a no-op on Lnd!)

// const exchange = async (
//   state: State,
//   source: ReadyUplinks,
//   dest: ReadyUplinks
// ) => {
//   const testName = `${state.settlers[
//     source.settlerType
//   ].assetCode.toLowerCase()} -> ${state.settlers[
//     dest.settlerType
//   ].assetCode.toLowerCase()}`

//   test(testName, async t => {})
// }

// const amountToSend = convert(usd(2), eth(), state.rateBackend)
//   const start = performance.now()
//   await streamMoney({
//     amount: amountToSend,
//     source: uplink,
//     dest: uplink2
//   })
//   t.log(`time: ${performance.now() - start} ms`)