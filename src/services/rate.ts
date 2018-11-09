import { Ledger } from '@src/ledger'
import axios from 'axios'
import BigNumber from 'bignumber.js'

interface ICoinMarketCapResponse {
  data: {
    [id: number]: {
      symbol: string
      quotes: {
        USD: {
          price: string
        }
      }
    }
  }
}

// TODO Should this throw an error if rates are out of date?
// TODO Should I approach error handling in a different way?

export class RateBackend {
  private rates: {
    [symbol: string]: BigNumber
  } = {
    USD: new BigNumber(1)
  }

  private interval?: NodeJS.Timeout

  /**
   * Determine the precise relative exchange rate between the given source and destination assets
   * - If given a ledger, the base units or asset scale will be used
   * - If given an asset code/symbol, the unit of exchange will be used
   * @param source Ledger or code for asset to be converted
   * @param dest Ledger or code for asset resulting from conversion
   */
  public getRate(
    source: Ledger | string,
    dest: Ledger | string
  ): BigNumber | Error {
    const { symbol: sourceSymbol, scale: sourceScale } = this.getInfo(source)
    const sourceRate = this.rates[sourceSymbol]
    if (!sourceRate) {
      return new Error(`No rate available for currency ${sourceSymbol}`)
    }

    const { symbol: destSymbol, scale: destScale } = this.getInfo(dest)
    const destRate = this.rates[destSymbol]
    if (!destRate) {
      return new Error(`No rate available for currency ${destSymbol}`)
    }

    const scaledSourceRate = sourceRate.shiftedBy(sourceScale)
    const scaledDestRate = destRate.shiftedBy(destScale)

    return scaledDestRate.div(scaledSourceRate).dp(0, BigNumber.ROUND_CEIL)
  }

  /**
   * Refresh exchange rates and update at the given interval
   */
  public connect({
    refreshInterval = 5000
  }: {
    refreshInterval?: number
  } = {}): Promise<void> {
    clearInterval(this.interval)
    this.interval = setInterval(() => this.fetchRates(), refreshInterval)

    return this.fetchRates()
  }

  /**
   * Stop refreshing exchange rates at a regular interval
   */
  public disconnect(): void {
    clearInterval(this.interval)
  }

  /**
   * Fetch and persist updated rates in USD for all listings on CoinMarketCap
   */
  private async fetchRates(): Promise<void> {
    const { data } = await axios.get<ICoinMarketCapResponse>(
      'https://api.coinmarketcap.com/v2/ticker/'
    )

    const coins = Object.values(data.data)
    for (const coin of coins) {
      this.rates[coin.symbol] = new BigNumber(coin.quotes.USD.price)
    }
  }

  /**
   * Normalize the given asset into the base unit scale and symbol/code
   * @param asset Instance of a ledger or asset code as a string
   */
  private getInfo(
    asset: Ledger | string
  ): {
    symbol: string
    scale: number
  } {
    const isLedger = (o: any): o is Ledger => o instanceof Ledger

    return isLedger(asset)
      ? {
          symbol: asset.assetCode,
          scale: asset.assetScale
        }
      : {
          symbol: asset,
          scale: 0
        }
  }
}
