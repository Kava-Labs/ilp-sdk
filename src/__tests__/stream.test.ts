import { AssetUnit, convert, usd } from '@kava-labs/crypto-rate-utils'
import anyTest, { ExecutionContext, TestInterface } from 'ava'
import 'envkey'
import {
  SwitchApi,
  connect,
  LedgerEnv,
  SettlementEngineType,
  ReadyUplinks
} from '..'
import BigNumber from 'bignumber.js'
import { performance } from 'perf_hooks'
import { promisify } from 'util'
import { unlink } from 'fs'
import { CONFIG_PATH } from '../config'

const test = anyTest as TestInterface<SwitchApi>

export const addEth = ({ add }: SwitchApi): Promise<ReadyUplinks> =>
  add({
    settlerType: SettlementEngineType.Machinomy,
    privateKey: process.env.ETH_PRIVATE_KEY_CLIENT_1!
  })

export const addBtc = ({ add }: SwitchApi): Promise<ReadyUplinks> =>
  add({
    settlerType: SettlementEngineType.Lnd,
    hostname: process.env.LIGHTNING_LND_HOST_CLIENT_1!,
    tlsCert: process.env.LIGHTNING_TLS_CERT_PATH_CLIENT_1!,
    macaroon: process.env.LIGHTNING_MACAROON_PATH_CLIENT_1!,
    grpcPort: parseInt(process.env.LIGHTNING_LND_GRPCPORT_CLIENT_1!, 10)
  })

export const addXrp = ({ add }: SwitchApi): Promise<ReadyUplinks> =>
  add({
    settlerType: SettlementEngineType.XrpPaychan,
    secret: process.env.XRP_SECRET_CLIENT_1!
  })

// Before & after each test, construct and disconnect the API

test.beforeEach(async t => {
  // Delete any existing config
  await promisify(unlink)(CONFIG_PATH).catch(() => Promise.resolve())
  t.context = await connect(process.env.LEDGER_ENV! as LedgerEnv)
})

test.afterEach(async t => t.context.disconnect())

const testFunding = (
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

  // TODO In the case of eth, this won't actually get the final claim before it withdraws

  await t.notThrowsAsync(
    withdraw({ uplink, authorize: () => Promise.resolve() }),
    'withdraws from channel without throwing an error'
  )

  t.true(
    uplink.balance$.value.isZero(),
    'balance$ of uplink goes back to zero following a withdraw'
  )
}

const testExchange = (
  createSource: (api: SwitchApi) => Promise<ReadyUplinks>,
  createDest: (api: SwitchApi) => Promise<ReadyUplinks>
) => async (t: ExecutionContext<SwitchApi>) => {
  const { state, deposit, streamMoney } = t.context

  const createFundedUplink = async (
    createUplink: (api: SwitchApi) => Promise<ReadyUplinks>
  ) => {
    const uplink = await createUplink(t.context)
    await deposit({
      uplink,
      amount: convert(
        usd(3),
        state.settlers[uplink.settlerType].exchangeUnit(),
        state.rateBackend
      ),
      authorize: () => Promise.resolve()
    })
    return uplink
  }

  const [sourceUplink, destUplink] = await Promise.all([
    createFundedUplink(createSource),
    createFundedUplink(createDest)
  ])

  const initialSourceBalance = sourceUplink.balance$.value
  const initialDestBalance = destUplink.balance$.value

  const sourceUnit = state.settlers[sourceUplink.settlerType].exchangeUnit
  const destUnit = state.settlers[destUplink.settlerType].exchangeUnit

  const amountToSend = convert(usd(2), sourceUnit(), state.rateBackend)
  const start = performance.now()
  await t.notThrowsAsync(
    streamMoney({
      amount: amountToSend,
      source: sourceUplink,
      dest: destUplink
    })
  )
  t.log(`time: ${performance.now() - start} ms`)

  // Wait up to 2 seconds for the final settlements to come in (sigh)
  await new Promise(r => setTimeout(r, 2000))

  const finalSourceBalance = sourceUplink.balance$.value
  t.true(
    initialSourceBalance.minus(amountToSend).isEqualTo(finalSourceBalance),
    'source balance accurately represents the amount that was sent'
  )

  const estimatedReceiveAmount = convert(
    sourceUnit(amountToSend),
    destUnit(),
    state.rateBackend
  )
  const estimatedDestFinalBalance = initialDestBalance.plus(
    estimatedReceiveAmount
  )
  const finalDestBalance = destUplink.balance$.value
  t.true(
    finalDestBalance.isGreaterThan(estimatedDestFinalBalance.times(0.99)) &&
      finalDestBalance.isLessThan(estimatedDestFinalBalance.times(1.01)),
    'destination balance accounts for the amount that was sent, with margin for exchange rate fluctuations'
  )
}

test('eth deposits & withdrawals', testFunding(addEth))
test('xrp deposits & withdrawals', testFunding(addXrp))

test('xrp -> eth', testExchange(addXrp, addEth))
test('xrp -> btc', testExchange(addXrp, addBtc))
test('btc -> eth', testExchange(addBtc, addEth))
test('btc -> xrp', testExchange(addBtc, addXrp))
test('eth -> btc', testExchange(addEth, addBtc))
test('eth -> xrp', testExchange(addEth, addXrp))

// test.only('persistence', async t => {
//   const api = t.context
//   const { disconnect } = api

//   await Promise.all([addBtc(api), addEth(api)])
//   await disconnect()

//   t.context = await connect(process.env.LEDGER_ENV! as LedgerEnv)
//   const newApi = t.context

//   t.true(newApi.state.uplinks.length === 2)
// })
