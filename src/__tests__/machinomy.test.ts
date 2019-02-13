import test from 'ava'
import { connect, LedgerEnv } from '..'
import { SettlementEngineType } from '../engine'
import { convert, usd, eth } from '@kava-labs/crypto-rate-utils'
import 'envkey'
import createLogger from 'ilp-logger'
import { performance } from 'perf_hooks'

const log = createLogger('switch-api:test')

test('machinomy balance & deposits', async t => {
  const { state, deposit, withdraw, add, streamMoney } = await connect(
    LedgerEnv.Local
  )

  const uplink = await add({
    settlerType: SettlementEngineType.Machinomy,
    privateKey: process.env.ETH_PRIVATE_KEY_CLIENT_1!
  })

  const uplink2 = await add({
    settlerType: SettlementEngineType.Lnd,
    hostname: process.env.LIGHTNING_LND_HOST_CLIENT_1!,
    tlsCert: process.env.LIGHTNING_TLS_CERT_PATH_CLIENT_1!,
    macaroon: process.env.LIGHTNING_MACAROON_PATH_CLIENT_1!,
    grpcPort: parseInt(process.env.LIGHTNING_LND_GRPCPORT_CLIENT_1!, 10)
  })

  // TODO For testing purposes only
  uplink.balance$.subscribe(amount =>
    log.info(`BALANCE: ${uplink.balance$.value} eth`)
  )

  t.true(uplink.balance$.value.isZero(), 'initial layer 2 balance is 0')

  // TODO Add assertion to make sure this doesn't reject
  const fundAmount = convert(usd(1), eth(), state.rateBackend)
  await deposit({
    uplink,
    amount: fundAmount,
    authorize: async ({ fee, value }) => {
      t.true(
        convert(eth(fee), usd(), state.rateBackend).isLessThan(0.2),
        'fee to open channel should be less than 20 cents'
      )
      return true
    }
  })

  // TODO Wtf
  await new Promise(r => setTimeout(r, 1000))

  t.true(
    fundAmount.isEqualTo(uplink.balance$.value),
    'balance is correct after initial channel open'
  )

  // TODO Uncomment
  // await t.throwsAsync(
  //   streamMoney({
  //     amount: convert(usd(2), eth(), state.rateBackend),
  //     source: uplink,
  //     dest: uplink
  //   }),
  //   'streaming more than outgoing capacity should fail'
  // )

  // TODO Add assertion so it doesn't reject
  const depositAmount = convert(usd(2), eth(), state.rateBackend)
  await deposit({
    uplink,
    amount: depositAmount,
    authorize: async ({ fee, value }) => {
      t.true(
        convert(eth(fee), usd(), state.rateBackend).isLessThan(0.2),
        'fee to deposit to channel should be less than 20 cents'
      )
      return true
    }
  })

  // TODO Wtf
  await new Promise(r => setTimeout(r, 1000))

  t.true(
    uplink.balance$.value.isEqualTo(fundAmount.plus(depositAmount)),
    'balance is correct after depositing to channel'
  )

  const start = performance.now()
  const amountToSend = convert(usd(2), eth(), state.rateBackend)
  await streamMoney({
    amount: amountToSend,
    source: uplink,
    dest: uplink2
  })
  t.log(`time: ${performance.now() - start} ms`)

  await new Promise(r => setTimeout(r, 2000))

  // TODO Wtf
  await new Promise(r => setTimeout(r, 1000))

  t.true(
    uplink.balance$.value.isEqualTo(
      fundAmount.plus(depositAmount).minus(amountToSend)
    ),
    'balance is correct after depositing to channel'
  )

  // TODO Wtf
  await new Promise(r => setTimeout(r, 1000))
})
