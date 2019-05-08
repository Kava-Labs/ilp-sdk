import test from 'ava'
import { connect, LedgerEnv } from '..'
import { addBtc, addEth, addXrp } from './helpers'
require('envkey')

test('rebuilds sdk from a serialized config', async t => {
  const sdk = await connect(process.env.LEDGER_ENV as LedgerEnv)
  await Promise.all(
    [addBtc, addXrp, addEth].map(createUplink => createUplink()(sdk))
  )
  await sdk.disconnect()

  const initialSerializedConfig = JSON.stringify(sdk.serializeConfig())

  // Reconnect the API
  const newSdk = await connect(process.env.LEDGER_ENV as LedgerEnv)
  t.is(newSdk.state.credentials.length, 3, 'same number of credentials')
  t.is(newSdk.state.uplinks.length, 3, 'same number of uplink')
  await newSdk.disconnect()

  const rebuiltSerializedConfig = JSON.stringify(newSdk.serializeConfig())

  t.is(
    rebuiltSerializedConfig,
    initialSerializedConfig,
    'config is persisted and can be rebuilt from the persisted version'
  )
})
