import anyTest, { TestInterface, ExecutionContext } from 'ava'
import 'envkey'
import {
  SwitchApi,
  connect,
  LedgerEnv,
  SettlementEngineType,
  ReadyUplinks
} from '..'
import { addXrp, addEth, addBtc } from './_helpers'

const test = anyTest as TestInterface<SwitchApi>

// Before & after each test, construct and disconnect the API
test.beforeEach(async t => {
  t.context = await connect(process.env.LEDGER_ENV! as LedgerEnv)
})
test.afterEach(async t => t.context.disconnect())

// Test adding and removing uplinks
const testAddRemove = (
  createUplink: (api: SwitchApi) => Promise<ReadyUplinks>
) => async (t: ExecutionContext<SwitchApi>) => {
  const uplink = await createUplink(t.context)
  t.true(t.context.state.uplinks.includes(uplink))

  await t.context.remove(uplink)
  t.false(t.context.state.uplinks.includes(uplink))
}
test('add then remove btc', testAddRemove(addBtc(1)))
test('add then remove eth without deposit', testAddRemove(addEth(1)))
test('add then remove xrp without deposit', testAddRemove(addXrp(1)))

// Test that uplinks with the same credentials cannot be added
test('cannot add duplicate eth uplink', async t => {
  await addEth(1)(t.context)
  await t.throwsAsync(addEth(1)(t.context))
})
test('cannot add duplicate xrp uplink', async t => {
  await addXrp(1)(t.context)
  await t.throwsAsync(addXrp(1)(t.context))
})
test('cannot add duplicate btc uplink', async t => {
  await addBtc(1)(t.context)
  await t.throwsAsync(addBtc(1)(t.context))
})

// Test credential config input validation
// Private key and credential validation is done by lower level libraries.

test('add with invalid xrp secret throws', async t => {
  await t.throwsAsync(
    t.context.add({
      settlerType: SettlementEngineType.XrpPaychan,
      secret: 'this is not a valid xrpSecret' // invalid but correct length
    }),
    'Non-base58 character'
  )
})
test('add with un-activated xrp secret throws', async t => {
  await t.throwsAsync(
    t.context.add({
      settlerType: SettlementEngineType.XrpPaychan,
      secret: 'sn5s78zYX1i9mzFmd8jXooDFYgfj2' // un-activated but valid secret
    }),
    'actNotFound'
  )
})
// Test eth private keys. As long as they contain correct characters and are the right length they are a valid key.
test('add with invalid eth secret throws', async t => {
  await t.throwsAsync(
    t.context.add({
      settlerType: SettlementEngineType.Machinomy,
      privateKey:
        'this is not a valid eth secret despite being the correct leength'
    })
  )
  // Note: if the secret is correct length but contains invalid characters, an invalid length error is thrown ('private key length is invalid').
})
// Test valid lnd uri, but invalid credentials.
test('add with invalid lnd credentials throws', async t => {
  await t.throwsAsync(
    t.context.add({
      settlerType: SettlementEngineType.Lnd,
      hostname: process.env.LIGHTNING_LND_HOST_CLIENT_1!,
      grpcPort: parseInt(process.env.LIGHTNING_LND_GRPCPORT_CLIENT_1!, 10),
      tlsCert:
        'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUNpRENDQWkrZ0F3SUJBZ0lRZG81djBRQlhIbmppNGhSYWVlTWpOREFLQmdncWhrak9QUVFEQWpCSE1SOHcKSFFZRFZRUUtFeFpzYm1RZ1lYVjBiMmRsYm1WeVlYUmxaQ0JqWlhKME1TUXdJZ1lEVlFRREV4dEtkWE4wZFhOegpMVTFoWTBKdmIyc3RVSEp2TFRNdWJHOWpZV3d3SGhjTk1UZ3dPREl6TURVMU9ERXdXaGNOTVRreE1ERTRNRFUxCk9ERXdXakJITVI4d0hRWURWUVFLRXhac2JtUWdZWFYwYjJkbGJtVnlZWFJsWkNCalpYSjBNU1F3SWdZRFZRUUQKRXh0S2RYTjBkWE56TFUxaFkwSnZiMnN0VUhKdkxUTXViRzlqWVd3d1dUQVRCZ2NxaGtqT1BRSUJCZ2dxaGtpTwpQUU1CQndOQ0FBU0ZoUm0rdy9UMTBQb0t0ZzRsbTloQk5KakpENDczZmt6SHdQVUZ3eTkxdlRyUVNmNzU0M2oyCkpyZ0ZvOG1iVFYwVnRwZ3FrZksxSU1WS01MckYyMXhpbzRIOE1JSDVNQTRHQTFVZER3RUIvd1FFQXdJQ3BEQVAKQmdOVkhSTUJBZjhFQlRBREFRSC9NSUhWQmdOVkhSRUVnYzB3Z2NxQ0cwcDFjM1IxYzNNdFRXRmpRbTl2YXkxUQpjbTh0TXk1c2IyTmhiSUlKYkc5allXeG9iM04wZ2dSMWJtbDRnZ3AxYm1sNGNHRmphMlYwaHdSL0FBQUJoeEFBCkFBQUFBQUFBQUFBQUFBQUFBQUFCaHhEK2dBQUFBQUFBQUFBQUFBQUFBQUFCaHhEK2dBQUFBQUFBQUF3bGM5WmMKazdiRGh3VEFxQUVFaHhEK2dBQUFBQUFBQUJpTnAvLytHeFhHaHhEK2dBQUFBQUFBQUtXSjV0bGlET1JqaHdRSwpEd0FDaHhEK2dBQUFBQUFBQUc2V3ovLyszYXRGaHhEOTJ0RFF5djRUQVFBQUFBQUFBQkFBTUFvR0NDcUdTTTQ5CkJBTUNBMGNBTUVRQ0lBOU85eHRhem1keENLajBNZmJGSFZCcTVJN0pNbk9GUHB3UlBKWFFmcllhQWlCZDVOeUoKUUN3bFN4NUVDblBPSDVzUnB2MjZUOGFVY1hibXlueDlDb0R1ZkE9PQotLS0tLUVORCBDRVJUSUZJQ0FURS0tLS0tCg==',
      macaroon:
        'AgEDbG5kArsBAwoQ3/I9f6kgSE6aUPd85lWpOBIBMBoWCgdhZGRyZXNzEgRyZWFkEgV3cml0ZRoTCgRpbmZvEgRyZWFkEgV32ml0ZRoXCghpbnZvaWNlcxIEcmVhZBIFd3JpdGUaFgoHbWVzc2FnZRIEcmVhZBIFd3JpdGUaFwoIb2ZmY2hhaW4SBHJlYWQSBXdyaXRlGhYKB29uY2hhaW4SBHJlYWQSBXdyaXRlGhQKBXBlZXJzEgRyZWFkEgV3cml0ZQAABiAiUTBv3Eh6iDbdjmXCfNxp4HBEcOYNzXhrm+ncLHf5jA=='
    }),
    'Failed to connect before the deadline'
  )
})
test('add with invalid lnd uri throws', async t => {
  await t.throwsAsync(
    t.context.add({
      settlerType: SettlementEngineType.Lnd,
      hostname: 'nonsense',
      grpcPort: 2000,
      tlsCert: 'nonsense',
      macaroon: 'nonsense'
    })
  )
})
