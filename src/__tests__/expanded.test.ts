import anyTest, { ExecutionContext, TestInterface } from 'ava'
import 'envkey'
import {
  SwitchApi,
  connect,
  LedgerEnv,
  SettlementEngineType,
  ReadyUplinks
} from '..'
import { testExchange } from './stream.test'

const test = anyTest as TestInterface<SwitchApi>

// TODO Refactor these for less repetition
const addEth1 = ({ add }: SwitchApi): Promise<ReadyUplinks> =>
  add({
    settlerType: SettlementEngineType.Machinomy,
    privateKey: process.env.ETH_PRIVATE_KEY_CLIENT_1!
  })
const addBtc1 = ({ add }: SwitchApi): Promise<ReadyUplinks> =>
  add({
    settlerType: SettlementEngineType.Lnd,
    hostname: process.env.LIGHTNING_LND_HOST_CLIENT_1!,
    tlsCert: process.env.LIGHTNING_TLS_CERT_PATH_CLIENT_1!,
    macaroon: process.env.LIGHTNING_MACAROON_PATH_CLIENT_1!,
    grpcPort: parseInt(process.env.LIGHTNING_LND_GRPCPORT_CLIENT_1!, 10)
  })
const addXrp1 = ({ add }: SwitchApi): Promise<ReadyUplinks> =>
  add({
    settlerType: SettlementEngineType.XrpPaychan,
    secret: process.env.XRP_SECRET_CLIENT_1!
  })
const addEth2 = ({ add }: SwitchApi): Promise<ReadyUplinks> =>
  add({
    settlerType: SettlementEngineType.Machinomy,
    privateKey: process.env.ETH_PRIVATE_KEY_CLIENT_2!
  })
const addBtc2 = ({ add }: SwitchApi): Promise<ReadyUplinks> =>
  add({
    settlerType: SettlementEngineType.Lnd,
    hostname: process.env.LIGHTNING_LND_HOST_CLIENT_2!,
    tlsCert: process.env.LIGHTNING_TLS_CERT_PATH_CLIENT_2!,
    macaroon: process.env.LIGHTNING_MACAROON_PATH_CLIENT_2!,
    grpcPort: parseInt(process.env.LIGHTNING_LND_GRPCPORT_CLIENT_2!, 10)
  })
const addXrp2 = ({ add }: SwitchApi): Promise<ReadyUplinks> =>
  add({
    settlerType: SettlementEngineType.XrpPaychan,
    secret: process.env.XRP_SECRET_CLIENT_2!
  })

// Before & after each test, construct and disconnect the API

test.beforeEach(async t => {
  t.context = await connect(process.env.LEDGER_ENV! as LedgerEnv)
})

test.afterEach(async t => t.context.disconnect())

//test('xrp -> xrp', testExchange(addXrp1, addXrp2))
//test('eth -> eth', testExchange(addEth1, addEth2))
test('btc -> btc', testExchange(addBtc1, addBtc2))