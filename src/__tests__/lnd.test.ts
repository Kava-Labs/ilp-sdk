import { btc, convert, usd } from '@kava-labs/crypto-rate-utils'
import test from 'ava'
import 'envkey'
import { connect, LedgerEnv } from '..'
import { SettlementEngineType } from '../engine'
import { performance } from 'perf_hooks'

test.skip('lnd -> lnd', async t => {
  const { state, add, streamMoney } = await connect(LedgerEnv.Local)

  const sourceUplink = await add({
    settlerType: SettlementEngineType.Lnd,
    hostname: process.env.LIGHTNING_LND_HOST_CLIENT_2!,
    tlsCert: process.env.LIGHTNING_TLS_CERT_PATH_CLIENT_2!,
    macaroon: process.env.LIGHTNING_MACAROON_PATH_CLIENT_2!,
    grpcPort: parseInt(process.env.LIGHTNING_LND_GRPCPORT_CLIENT_2!, 10)
  })

  const destUplink = await add({
    settlerType: SettlementEngineType.Lnd,
    hostname: process.env.LIGHTNING_LND_HOST_CLIENT_1!,
    tlsCert: process.env.LIGHTNING_TLS_CERT_PATH_CLIENT_1!,
    macaroon: process.env.LIGHTNING_MACAROON_PATH_CLIENT_1!,
    grpcPort: parseInt(process.env.LIGHTNING_LND_GRPCPORT_CLIENT_1!, 10)
  })

  await new Promise(r => setTimeout(r, 2000))

  const start = performance.now()
  await streamMoney({
    amount: convert(usd(2), btc(), state.rateBackend),
    source: sourceUplink,
    dest: destUplink
  })
  t.log(`time: ${performance.now() - start} ms`)

  await new Promise(r => setTimeout(r, 2000))
})
