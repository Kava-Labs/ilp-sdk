import { FormattedPaymentChannel } from 'ripple-lib/dist/npm/ledger/parse/payment-channel'
import getPaymentChannel from 'ripple-lib/dist/npm/ledger/payment-channel'

declare module 'ripple-lib' {
  export interface FormattedPaymentChannel {
    /** Total amount of XRP funded in this channel */
    amount: string
    /** Total amount of XRP delivered by this channel (per docs) */
    balance: string
  }
}
