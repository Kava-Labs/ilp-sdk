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

test('persists unencrypted state if no password is provided', async t => {
  // Delete any existing config
  await promisify(unlink)(CONFIG_PATH).catch(() => Promise.resolve())

  // Connect API
  const api = await connect(process.env.LEDGER_ENV as LedgerEnv)
  await Promise.all(
    [addBtc, addXrp, addEth].map(createUplink => createUplink()(api))
  )
  await api.disconnect() // Should persist the state

  const initialSerializedConfig = await readConfig()

  // Reconnect the API
  const newApi = await connect(process.env.LEDGER_ENV as LedgerEnv)
  t.is(newApi.state.credentials.length, 3, 'same number of credentials')
  t.is(newApi.state.uplinks.length, 3, 'same number of uplink')
  await newApi.disconnect()

  const rebuiltSerializedConfig = await readConfig()

  t.is(
    rebuiltSerializedConfig,
    initialSerializedConfig,
    'config is persisted and can be rebuilt from the persisted version'
  )
})

test('encrypts and decrypts persisted state if password is provided', async t => {
  const password = 'hello world'

  // Delete any existing config
  await promisify(unlink)(CONFIG_PATH).catch(() => Promise.resolve())

  // Connect API
  const api = await connect(
    process.env.LEDGER_ENV! as LedgerEnv,
    password
  )
  await Promise.all(
    [addBtc, addEth, addXrp].map(createUplink => createUplink()(api))
  )
  await api.disconnect() // Should persist the state

  // Reconnect the API
  const newApi = await connect(
    process.env.LEDGER_ENV! as LedgerEnv,
    password
  )
  t.is(newApi.state.credentials.length, 3, 'same number of credentials')
  t.is(newApi.state.uplinks.length, 3, 'same number of uplink')
  await newApi.disconnect()
})

test(`fails to reload state if password is incorrect`, async t => {
  // Delete any existing config
  await promisify(unlink)(CONFIG_PATH).catch(() => Promise.resolve())

  // Connect API
  const api = await connect(
    process.env.LEDGER_ENV! as LedgerEnv,
    'hello world'
  )
  await Promise.all(
    [addBtc, addEth, addXrp].map(createUplink => createUplink()(api))
  )
  await api.disconnect() // Should persist the state

  // Reconnect the API
  await t.throwsAsync(() =>
    connect(
      process.env.LEDGER_ENV! as LedgerEnv,
      'wrong password'
    )
  )
})

test('fails to reload encrypted state if no password is provided', async t => {
  // Delete any existing config
  await promisify(unlink)(CONFIG_PATH).catch(() => Promise.resolve())

  // Connect API
  const api = await connect(
    process.env.LEDGER_ENV as LedgerEnv,
    'some password'
  )
  await Promise.all(
    [addBtc, addXrp, addEth].map(createUplink => createUplink()(api))
  )
  await api.disconnect() // Should persist the state

  await t.throwsAsync(() => connect(process.env.LEDGER_ENV as LedgerEnv))
})

// TODO How to test whether v0.3+ configs are upgraded to the new configs?

// test('supports loading states from v0.3.x or v0.4.x', async t => {
//   // Delete any existing config
//   await promisify(unlink)(CONFIG_PATH).catch(() => Promise.resolve())

//   // Connect API
//   const api = await connect(
//     process.env.LEDGER_ENV as LedgerEnv,
//     'some password'
//   )
//   await Promise.all(
//     [addBtc, addXrp, addEth].map(createUplink => createUplink()(api))
//   )
//   await api.disconnect() // Should persist the state

//   await t.throwsAsync(() => connect(process.env.LEDGER_ENV as LedgerEnv))
// })

// TODO How to test support for multiple environments?

// test('persists state for multiple environments', async t => {
//   // Delete any existing config
//   await promisify(unlink)(CONFIG_PATH).catch(() => Promise.resolve())

//   // Start running a local connector
//   await promisify(start)('connector-config/ecosystem.config.js')

//   // Connect API for a local connector
//   const api = await connect(LedgerEnv.Local)
//   await Promise.all(
//     [addBtc, addXrp, addEth].map(createUplink => createUplink()(api))
//   )
//   await api.disconnect() // Should persist the state

//   // Stop local connector
//   await promisify(start)('connector-config/ecosystem.config.js')

//   // Connect API on testnet
//   const api2 = await connect(LedgerEnv.Testnet)
//   await Promise.all([addBtc, addEth].map(createUplink => createUplink()(api2)))
//   await api2.disconnect() // Should persist the state

//   const initialSerializedConfig = await readConfig()

//   // Reconnect the API on testnet
//   const api3 = await connect(LedgerEnv.Testnet)
//   t.is(api3.state.credentials.length, 3, 'same number of credentials')
//   t.is(api3.state.uplinks.length, 3, 'same number of uplink')
//   await api3.disconnect()

//   // Reconnect the API a local connector
//   const api4 = await connect(LedgerEnv.Local)
//   t.is(api4.state.credentials.length, 2, 'same number of credentials')
//   t.is(api4.state.uplinks.length, 2, 'same number of uplink')
//   await api4.disconnect()

//   const rebuiltSerializedConfig = await readConfig()

//   t.is(
//     rebuiltSerializedConfig,
//     initialSerializedConfig,
//     'config is persisted and can be rebuilt from the persisted version'
//   )
// })
