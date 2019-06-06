import { IlpSdk, SettlementEngineType, ReadyUplinks } from '..'
import {
  convert,
  exchangeQuantity,
  exchangeUnit,
  AssetQuantity
} from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import { AuthorizeDeposit, AuthorizeWithdrawal } from '../uplink'
import { usdAsset, getAssetScale } from '../assets'

export const addEth = (n = 1) => ({ add }: IlpSdk): Promise<ReadyUplinks> =>
  add({
    settlerType: SettlementEngineType.Machinomy,
    privateKey: process.env[`ETH_PRIVATE_KEY_CLIENT_${n}`]!
  })

export const addDai = (n = 1) => ({ add }: IlpSdk): Promise<ReadyUplinks> =>
  add({
    settlerType: SettlementEngineType.Machinomy,
    assetType: 'DAI',
    privateKey: process.env[`ETH_PRIVATE_KEY_CLIENT_${n}`]!
  })

export const addBtc = (n = 1) => ({ add }: IlpSdk): Promise<ReadyUplinks> =>
  add({
    settlerType: SettlementEngineType.Lnd,
    hostname: process.env[`LIGHTNING_LND_HOST_CLIENT_${n}`]!,
    tlsCert: process.env[`LIGHTNING_TLS_CERT_PATH_CLIENT_${n}`]!,
    macaroon: process.env[`LIGHTNING_MACAROON_PATH_CLIENT_${n}`]!,
    grpcPort: parseInt(process.env[`LIGHTNING_LND_GRPCPORT_CLIENT_${n}`]!, 10)
  })

export const addXrp = (n = 1) => ({ add }: IlpSdk): Promise<ReadyUplinks> =>
  add({
    settlerType: SettlementEngineType.XrpPaychan,
    secret: process.env[`XRP_SECRET_CLIENT_${n}`]!
  })

export const createFundedUplink = (api: IlpSdk) => async (
  createUplink: (api: IlpSdk) => Promise<ReadyUplinks>
) => {
  const uplink = await createUplink(api)

  const amount = convert(
    exchangeQuantity(usdAsset, 3),
    exchangeUnit(uplink.asset),
    api.state.rateBackend
  ).amount.decimalPlaces(getAssetScale(uplink.asset), BigNumber.ROUND_DOWN)

  await api.deposit({
    uplink,
    amount,
    authorize: () => Promise.resolve()
  })

  return uplink
}

// Helper that runs deposit/withdraw, capturing and returning the reported tx value and fees.
export const captureFeesFrom = async (
  apiMethod: (authorize: AuthorizeDeposit | AuthorizeWithdrawal) => Promise<any>
) => {
  /* tslint:disable-next-line:no-let */
  let pendingOp: Promise<any> = Promise.resolve()

  const reportedFee = new Promise<AssetQuantity>(resolve => {
    pendingOp = apiMethod(async ({ fee }) => resolve(fee))
  })

  await pendingOp
  return reportedFee
}
