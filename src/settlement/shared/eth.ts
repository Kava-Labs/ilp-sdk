import { convert, gwei, wei } from '@kava-labs/crypto-rate-utils'
import Web3 from 'web3'
import { State } from '../..'
import { MachinomySettlementEngine } from '../machinomy'
import axios from 'axios'

/**
 * Use the `fast` gasPrice per EthGasStation on mainnet
 * Fallback to Web3 eth_gasPrice RPC call otherwise
 */
export const fetchGasPrice = ({ ledgerEnv }: State) => async ({
  ethereumProvider
}: MachinomySettlementEngine): Promise<number> => {
  const web3 = new Web3(ethereumProvider)

  if (ledgerEnv !== 'mainnet') {
    return web3.eth.getGasPrice()
  }

  try {
    const { data } = await axios.get(
      'https://ethgasstation.info/json/ethgasAPI.json'
    )
    return convert(gwei(data.fast / 10), wei()).toNumber()
  } catch (err) {
    return web3.eth.getGasPrice()
  }
}
