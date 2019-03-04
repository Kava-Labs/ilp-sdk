import test from 'ava'
import { connect, LedgerEnv } from '..'
import { addBtc, addEth, addXrp } from './helpers'
import { promisify } from 'util'
import { unlink, readFile } from 'fs'
import { CONFIG_PATH } from '../config'
require('envkey')

const readConfig = () =>
  promisify(readFile)(CONFIG_PATH, {
    encoding: 'utf8'
  })

test('persists state locally', async t => {
  // Delete any existing config
  await promisify(unlink)(CONFIG_PATH).catch(() => Promise.resolve())

  // Connect API
  const api = await connect(process.env.LEDGER_ENV! as LedgerEnv)
  await Promise.all([addBtc, addEth, addXrp].map(create => create()(api)))
  await api.disconnect() // Should persist the state

  const initialSerializedConfig = await readConfig()

  // Reconnect the API
  await t.notThrowsAsync(async () => {
    const newApi = await connect(process.env.LEDGER_ENV! as LedgerEnv)

    t.is(newApi.state.credentials.length, 3, 'same number of credentials')
    t.is(newApi.state.uplinks.length, 3, 'same number of uplink')

    await newApi.disconnect()
  }, 'connects api using existing config')

  const rebuiltSerializedConfig = await readConfig()

  t.is(
    rebuiltSerializedConfig,
    initialSerializedConfig,
    'config is persisted and can be rebuilt from the persisted version'
  )
})
