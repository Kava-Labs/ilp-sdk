/*
 * Failed to add new ledger/uplink/connection
 */

class InvalidCredentialError extends Error {}

/** Attempted to configure an uplink to the same connector with the same credentials */
class DuplicateUplinkError extends Error {}

/*
 * Failed escrow/deposit/open errors
 */

/** The on-chain transaction would lock up an unsafe amount on-chain */
class AboveEscrowLimitError extends Error {}

/** The account on the base ledger does have enough funds to perform the on-chain transaction */
class InsufficientFundsError extends Error {}
