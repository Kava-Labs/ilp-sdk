import BigNumber from 'bignumber.js'
import { convert, usd } from '@kava-labs/crypto-rate-utils'
import { ReadyUplinks, SettlementEngineType, SwitchApi } from '..'
import { SettlementEngines } from '../engine'
import { ReadyCredentials } from '../credential'
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
import {
  baseLayerBalance as getLndBaseBalance,
  ReadyLndCredential
} from '../settlement/lnd'

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

  await api.deposit({
    uplink,
    amount: convert(
      usd(3),
      api.state.settlers[uplink.settlerType].exchangeUnit(),
      api.state.rateBackend
    ),
    authorize: () => Promise.resolve()
  })

  return uplink
}

// TODO add baseLayer to settlement module interface?
// TODO can this code be more succinct?
export const getBaseLayerBalance = async (
  settler: SettlementEngines,
  credential: ReadyCredentials
): Promise<BigNumber> => {
  switch (
    settler.settlerType // should switch based on type check of settler? and func arg should have an interface type that the settlers fulfil
  ) {
    case SettlementEngineType.Lnd:
      return getLndBaseBalance(credential as ReadyLndCredential)
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
