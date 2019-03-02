import { AssetUnit, convert, usd } from '@kava-labs/crypto-rate-utils'
import 'envkey'
import { ExecutionContext } from 'ava'
import BigNumber from 'bignumber.js'
import { performance } from 'perf_hooks'
import { SwitchApi, SettlementEngineType, ReadyUplinks } from '..'
import { SettlementEngines } from '../engine'
import {
  CredentialConfigs,
  ReadyCredentials,
  getCredential
} from '../credential'
import {
  baseLayerBalance as getMachinomyBaseBalance,
  MachinomySettlementEngine,
  ReadyEthereumCredential
} from '../settlement/machinomy'
import {
  baseLayerBalance as getXrpBaseBalance,
  XrpPaychanSettlementEngine,
  ValidatedXrpSecret
} from '../settlement/xrp-paychan'

// Return configs for connecting to accounts set up in env vars.
const ethConfig = (n: number): CredentialConfigs => {
  return {
    settlerType: SettlementEngineType.Machinomy,
    privateKey: process.env[`ETH_PRIVATE_KEY_CLIENT_${n}`]!
  }
}
const btcConfig = (n: number): CredentialConfigs => {
  return {
    settlerType: SettlementEngineType.Lnd,
    hostname: process.env[`LIGHTNING_LND_HOST_CLIENT_${n}`]!,
    tlsCert: process.env[`LIGHTNING_TLS_CERT_PATH_CLIENT_${n}`]!,
    macaroon: process.env[`LIGHTNING_MACAROON_PATH_CLIENT_${n}`]!,
    grpcPort: parseInt(process.env[`LIGHTNING_LND_GRPCPORT_CLIENT_${n}`]!, 10)
  }
}
const xrpConfig = (n: number): CredentialConfigs => {
  return {
    settlerType: SettlementEngineType.XrpPaychan,
    secret: process.env[`XRP_SECRET_CLIENT_${n}`]!
  }
}

export const addEth = (n: number) => ({
  add
}: SwitchApi): Promise<ReadyUplinks> => add(ethConfig(n))
export const addBtc = (n: number) => ({
  add
}: SwitchApi): Promise<ReadyUplinks> => add(btcConfig(n))
export const addXrp = (n: number) => ({
  add
}: SwitchApi): Promise<ReadyUplinks> => add(xrpConfig(n))

// TODO add baseLayer to settlement module interface?
// TODO can this code be more succinct?
const getBaseLayerBalance = async (
  settler: SettlementEngines,
  credential: ReadyCredentials
): Promise<BigNumber> => {
  switch (
    settler.settlerType // should switch based on type check of settler? and func arg should have an interface type that the settler's fulfil
  ) {
    case SettlementEngineType.Lnd:
      return Promise.resolve(new BigNumber(0)) // TODO credential.channelBalance$ // TODO write a wrapper baseLayerBalance?
    case SettlementEngineType.Machinomy:
      return getMachinomyBaseBalance(
        settler as MachinomySettlementEngine,
        credential as ReadyEthereumCredential
      )
    case SettlementEngineType.XrpPaychan:
      return getXrpBaseBalance(
        settler as XrpPaychanSettlementEngine,
        credential as ValidatedXrpSecret
      )
  }
}

// An authorize function for use in deposit and withdraw. It authorizes and records the reported value and fee (in the provided object).
const createAuthorizeAndCaptureFunc = (captureObject: any) => async (
  params: any
) => {
  captureObject.value = params.value
  captureObject.fee = params.fee
}
const createEmptyCaptureObject = () => {
  return {
    value: new BigNumber(0),
    fee: new BigNumber(0)
  }
}

// Helper to test deposit and withdraw on uplinks
export const testFunding = (
  createUplink: (api: SwitchApi) => Promise<ReadyUplinks>
) => async (t: ExecutionContext<SwitchApi>) => {
  const { state, deposit, withdraw, streamMoney } = t.context
  const uplink = await createUplink(t.context)

  const settler = state.settlers[uplink.settlerType]
  const currentBaseBalance = async () =>
    getBaseLayerBalance(settler, getCredential(state)(uplink.credentialId)!)

  // Instead down to the base unit of the ledger if there's more precision than that
  const toUplinkUnit = (unit: AssetUnit) =>
    convert(unit, settler.exchangeUnit(), state.rateBackend).decimalPlaces(
      settler.exchangeUnit().exchangeUnit,
      BigNumber.ROUND_DOWN
    )

  t.true(uplink.balance$.value.isZero(), 'initial layer 2 balance is 0')

  // TODO Check that incoming capacity is opened!
  // TODO Use t.deepEqual instead  of isEqualTo?

  /**
   * TODO Issue with xrp: openAmount has 9 digits of precision, but balance$ only has 6!
   * e.g. openAmount === "2.959676012", uplink.balance$ === "2.959676"
   */

  // Deposit to uplink (opens channel).
  const baseBalance0 = await currentBaseBalance()
  const reportedValueAndFee1 = createEmptyCaptureObject()
  const openAmount = toUplinkUnit(usd(1))
  await t.notThrowsAsync(
    deposit({
      uplink,
      amount: openAmount,
      authorize: createAuthorizeAndCaptureFunc(reportedValueAndFee1)
    }),
    'opens channel without throwing an error'
  )

  t.true(
    uplink.balance$.value.isEqualTo(openAmount),
    'balance$ correctly reflects the initial channel open'
  )
  const baseBalance1 = await currentBaseBalance()
  t.true(
    baseBalance0
      .minus(openAmount)
      .minus(reportedValueAndFee1.fee)
      .isEqualTo(baseBalance1),
    'base layer balance matches reported balances'
  )
  t.true(
    openAmount.isEqualTo(reportedValueAndFee1.value),
    'authorize reports correct value'
  )

  // Deposit to uplink (tops up channel).
  const reportedValueAndFee2 = createEmptyCaptureObject()
  const depositAmount = toUplinkUnit(usd(2))
  await t.notThrowsAsync(
    deposit({
      uplink,
      amount: depositAmount,
      authorize: createAuthorizeAndCaptureFunc(reportedValueAndFee2)
    }),
    'deposits to channel without throwing an error'
  )

  t.true(
    uplink.balance$.value.isEqualTo(openAmount.plus(depositAmount)),
    'balance$ correctly reflects the deposit to the channel'
  )
  const baseBalance2 = await currentBaseBalance()
  t.true(
    baseBalance1
      .minus(depositAmount)
      .minus(reportedValueAndFee2.fee)
      .isEqualTo(baseBalance2),
    'base layer balance matches reported balances'
  )
  t.true(
    depositAmount.isEqualTo(reportedValueAndFee2.value),
    'authorize reports correct value'
  )

  // Rebalance so there's some money in both the incoming & outgoing channels.
  await t.notThrowsAsync(
    streamMoney({
      amount: toUplinkUnit(usd(1.1)),
      source: uplink,
      dest: uplink
    }),
    'uplink can stream money to itself'
  )

  // Withdraw from uplink (closes channel).
  const reportedValueAndFee3 = createEmptyCaptureObject()
  const finalBalance = uplink.balance$.value
  await t.notThrowsAsync(
    withdraw({
      uplink,
      authorize: createAuthorizeAndCaptureFunc(reportedValueAndFee3)
    }),
    'withdraws from channel without throwing an error'
  )

  t.true(
    uplink.balance$.value.isZero(),
    'balance$ of uplink goes back to zero following a withdraw'
  )
  const baseBalance3 = await currentBaseBalance()
  t.true(
    baseBalance2
      .plus(finalBalance)
      .minus(reportedValueAndFee3.fee.dividedBy(2)) // TODO FIXME why is reported fee 2x?
      .isEqualTo(baseBalance3),
    'base layer balance matches reported balances'
  )
  t.true(
    finalBalance.isEqualTo(reportedValueAndFee3.value),
    'authorize reports correct value'
  )
}

// Helper to test streaming between different uplinks
export const testExchange = (
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

  // Without this pause after creating the uplinks, a stream from lnd to lnd fails.
  // TODO fix
  await new Promise(r => setTimeout(r, 500))

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
