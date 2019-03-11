import { SwitchApi, SettlementEngineType, ReadyUplinks } from '..'
import { convert, usd } from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'

export const addEth = (n = 1) => ({ add }: SwitchApi): Promise<ReadyUplinks> =>
  add({
    settlerType: SettlementEngineType.Machinomy,
    privateKey: process.env[`ETH_PRIVATE_KEY_CLIENT_${n}`]!
  })

export const addBtc = (n = 1) => ({ add }: SwitchApi): Promise<ReadyUplinks> =>
  add({
    settlerType: SettlementEngineType.Lnd,
    hostname: process.env[`LIGHTNING_LND_HOST_CLIENT_${n}`]!,
    tlsCert: process.env[`LIGHTNING_TLS_CERT_PATH_CLIENT_${n}`]!,
    macaroon: process.env[`LIGHTNING_MACAROON_PATH_CLIENT_${n}`]!,
    grpcPort: parseInt(process.env[`LIGHTNING_LND_GRPCPORT_CLIENT_${n}`]!, 10)
  })

export const addXrp = (n = 1) => ({ add }: SwitchApi): Promise<ReadyUplinks> =>
  add({
    settlerType: SettlementEngineType.XrpPaychan,
    secret: process.env[`XRP_SECRET_CLIENT_${n}`]!
  })

export const createFundedUplink = (api: SwitchApi) => async (
  createUplink: (api: SwitchApi) => Promise<ReadyUplinks>
) => {
  const uplink = await createUplink(api)

  const amount = convert(
    usd(3),
    api.state.settlers[uplink.settlerType].exchangeUnit(),
    api.state.rateBackend
  ).decimalPlaces(
    api.state.settlers[uplink.settlerType].assetScale,
    BigNumber.ROUND_DOWN
  )

  await api.deposit({
    uplink,
    amount,
    authorize: () => Promise.resolve()
  })

  return uplink
}

// Helper that runs deposit/withdraw, capturing and returning the reported tx value and fees.
export const captureFeesFrom = (apiMethod: any) => async (params: {
  readonly uplink: ReadyUplinks
  readonly amount?: BigNumber
}) => {
  const reportedValueAndFee = { value: new BigNumber(0), fee: new BigNumber(0) }

  const authorize: AuthorizeDeposit | AuthorizeWithdrawal = async params => {
    reportedValueAndFee.value = params.value
    reportedValueAndFee.fee = params.fee
  }

  await apiMethod({
    ...params,
    authorize: authorize
  })

  return reportedValueAndFee
}
