import { convert, gwei, wei } from '@kava-labs/crypto-rate-utils'
import axios from 'axios'
import BigNumber from 'bignumber.js'
import { ethers } from 'ethers'

/**
 * Use the `fast` gasPrice per EthGasStation on mainnet
 * Fallback to Web3 eth_gasPrice RPC call if it fails
 */
export const fetchGasPrice = (
  ethereumProvider: ethers.providers.Provider
) => (): Promise<BigNumber> =>
  axios
    .get('https://ethgasstation.info/json/ethgasAPI.json')
    .then(({ data }) => convert(gwei(data.fast / 10), wei()))
    .catch(async () => bnToBigNumber(await ethereumProvider.getGasPrice()))

const bnToBigNumber = (bn: ethers.utils.BigNumber) =>
  new BigNumber(bn.toString())
