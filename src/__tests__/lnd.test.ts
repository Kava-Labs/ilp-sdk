import { btc, connectCoinCap, convert, usd } from '@kava-labs/crypto-rate-utils'
import test from 'ava'
import BigNumber from 'bignumber.js'
import 'envkey'
import { connect, LedgerEnv } from '../api'
import { SettlementEngineType } from '../settlement'

test('lnd -> lnd', async t => {
  const { state, configure, streamMoney } = await connect(LedgerEnv.Local)
  const uplink = await configure({
    settlerType: SettlementEngineType.Lnd,
    hostname: process.env.LIGHTNING_LND_HOST_CLIENT_1!,
    tlsCert: process.env.LIGHTNING_TLS_CERT_PATH_CLIENT_1!,
    macaroon: process.env.LIGHTNING_MACAROON_PATH_CLIENT_1!,
    grpcPort: parseInt(process.env.LIGHTNING_LND_GRPCPORT_CLIENT_1!, 10)
  })

  // const uplink2 = await configure({
  //   settlerType: SettlementEngineType.Lnd,
  //   hostname: process.env.LIGHTNING_LND_HOST_CLIENT_2!,
  //   tlsCert: process.env.LIGHTNING_TLS_CERT_PATH_CLIENT_2!,
  //   macaroon: process.env.LIGHTNING_MACAROON_PATH_CLIENT_2!,
  //   grpcPort: 10009
  // })

  const uplink3 = await configure({
    settlerType: SettlementEngineType.XrpPaychan,
    secret: process.env.XRP_SECRET_CLIENT_1!
  })

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
  await t.notThrowsAsync(
    streamMoney({
      amount: convert(usd(1), btc(), state.rateBackend),
      source: uplink,
      dest: uplink3
    }),
    'streams $1 between the uplinks'
  )

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
})
