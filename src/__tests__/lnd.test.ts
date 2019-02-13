import {
  btc,
  connectCoinCap,
  convert,
  usd,
  xrp
} from '@kava-labs/crypto-rate-utils'
import test from 'ava'
import BigNumber from 'bignumber.js'
import 'envkey'
import { connect, LedgerEnv } from '..'
import { SettlementEngineType } from '../engine'
import { performance } from 'perf_hooks'

test('lnd -> lnd', async t => {
  const { state, deposit, withdraw, add, streamMoney } = await connect(
    LedgerEnv.Local
  )

  const uplink2 = await add({
    settlerType: SettlementEngineType.Lnd,
    hostname: process.env.LIGHTNING_LND_HOST_CLIENT_1!,
    tlsCert: process.env.LIGHTNING_TLS_CERT_PATH_CLIENT_1!,
    macaroon: process.env.LIGHTNING_MACAROON_PATH_CLIENT_1!,
    grpcPort: parseInt(process.env.LIGHTNING_LND_GRPCPORT_CLIENT_1!, 10)
  })

  const uplink = await add({
    settlerType: SettlementEngineType.XrpPaychan,
    secret: process.env.XRP_SECRET_CLIENT_1!
  })

  await deposit({
    uplink,
    authorize: () => Promise.resolve(true),
    amount: convert(usd(5), xrp(), state.rateBackend)
  })

  await new Promise(r => setTimeout(r, 2000))

  // await deposit(uplink as ReadyXrpPaychanUplink)({
  //   authorize: () => Promise.resolve(true),
  //   amount: convert(usd(5), xrp(), state.rateBackend)
  // })

  // const uplink3 = await configure({
  //   settlerType: SettlementEngineType.XrpPaychan,
  //   secret: process.env.XRP_SECRET_CLIENT_2!
  // })

  const start = performance.now()
  await streamMoney({
    amount: convert(usd(2), xrp(), state.rateBackend),
    source: uplink,
    dest: uplink2
  })
  t.log(`time: ${performance.now() - start} ms`)

  await new Promise(r => setTimeout(r, 2000))

  await withdraw({
    uplink,
    authorize: () => Promise.resolve(true)
  })

  await new Promise(r => setTimeout(r, 4000))
})

// const uplink2 = await configure({
//   settlerType: SettlementEngineType.Lnd,
//   hostname: process.env.LIGHTNING_LND_HOST_CLIENT_2!,
//   tlsCert: process.env.LIGHTNING_TLS_CERT_PATH_CLIENT_2!,
//   macaroon: process.env.LIGHTNING_MACAROON_PATH_CLIENT_2!,
//   grpcPort: 10009
// })

// const total$ = new BehaviorSubject(new BigNumber(0))
// combineLatest(uplink.balance$, uplink2.balance$)
//   .pipe(sumAll())
//   .subscribe(total$)

// Allow time for initial balances to load (e.g. LND channel balance)
// TODO Once in a while, channel balance will still be 0 when the stream starts, causing it to fail
// TODO Yuck! Find a better solution
// await new Promise(r => setTimeout(r, 2000))

// const baseline = total$.value

// TODO Ideally we'd check on every update that the total balance is within some bounds (e.g. maxInFlight?),
// but it's hard to do when it over-represents how much we have available

// const maxVariance = convert(
//   satoshi(uplink.idleAvailableToDebit.plus(uplink2.idleAvailableToCredit)),
//   btc()
// )
// total$.subscribe(total => {
//   const difference = total.minus(baseline).abs()
//   t.true(difference.lte(maxVariance), 'input-output balances remain in sync')
// })

// TODO Add back logging for speed test for streaming the money itself (look at OG stream test & eth/btc plugin tests)
// await t.notThrowsAsync(
//   streamMoney({
//     amount: convert(usd(1), btc(), state.rateBackend),
//     source: uplink,
//     dest: uplink3
//   }),
//   'streams $1 between the uplinks'
// )

/**
 * TODO It's impossible to know when settlements from the stream and finalized
 * since outgoingCapacity & availableToDebit aren't updated atomically
 * - it appears we have a balance with them/finished settling when we really haven't
 * - complicated by the fact that multiple settlements may be occuring simultaneously in Lightning
 *
 * Find a better solution
 */
// await new Promise(r => setTimeout(r, 2000))

// const final = total$.value
// t.true(final.eq(baseline), 'Total balance did not change during the stream')

// await Promise.all([
//   restoreCredit(state)(uplink),
//   restoreCredit(state)(uplink2)
// ])

// // TODO Yuck! Find a better solution
// await new Promise(r => setTimeout(r, 2000))

// const restored = total$.value
// t.true(restored.eq(baseline), 'Money prefunded was returned in full')
// })
