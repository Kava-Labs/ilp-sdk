const apiModule = require('../build/')
//use `const apiModule = require('@kava-labs/switch-api')` when running this script in it's own project
const BigNumber = require('bignumber.js')

// Prompt user for input and return a promise for the result.
function prompt(question) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;

    stdin.resume();
    stdout.write(question);

    stdin.on('data', data => resolve(data.toString().trim()));
    stdin.on('error', err => reject(err));
  });
}

// Generate functions that ask user for authorization to submit deposit and withdraw transactions.
function generateUserAuthorizeFunc(transactionType, assset) {
  return async function ({ fee, value }) {
    const answer = await prompt(`${transactionType} ${value} ${assset} with fee of ${fee} ${assset}? (y/n): `)
    const confirmationAnswers = ["yes","y","Y","Yes"]
    if (confirmationAnswers.includes(answer)) {
      return
    } else {
      throw new Error("authorization failed")
    }
  }
}

// Main script
async function main() {
  // CONNECT API =============================================================
  const api = await apiModule.connect()
  console.log("CONNECTED API")


  // For Kovan account 0x80e618c3bB05152D9b440f07aaD9771E80000Fc0
  const ethUplink = await api.add({
    settlerType: apiModule.SettlementEngineType.Machinomy,
    privateKey: 'dd858dad15ce0e442e19365d2967b2aa9d06008518e6fdbf60d24a0352517603'
  })
  // For ripple testnet account rGRDocJADWAcrB8a8BMfxfvWeY23q3nzd4
  const xrpUplink = await api.add({
    settlerType: apiModule.SettlementEngineType.XrpPaychan,
    secret: 'sahAw3PFc6gNnmJtWgFPgfsdSoZnY'
  })


  // ADD UPLINKS =============================================================
  xrpUplink.balance$.subscribe(amount => {
    console.log('XRP interledger balance:', amount.toString())
  })
  ethUplink.balance$.subscribe(amount => {
    console.log('ETH interledger balance:', amount.toString())
  })
  console.log("ADDED UPLINKS")


  // DEPOSIT =============================================================
  await api.deposit({
    /** Uplink to deposit to */
    uplink: xrpUplink,
    /** Amount to deposit, in units of exchange */
    amount: new BigNumber(20),
    /** Callback to authorize the fee and amount to be transferred from layer 1, after it's calculated */
    authorize: generateUserAuthorizeFunc("Deposit", "XRP")
  })
  console.log("DEPOSITED XRP")

  await api.deposit({
    /** Uplink to deposit to */
    uplink: ethUplink,
    /** Amount to deposit, in units of exchange */
    amount: new BigNumber(0.05),
    /** Callback to authorize the fee and amount to be transferred from layer 1, after it's calculated */
    authorize: generateUserAuthorizeFunc("Deposit", "ETH")
  })
  console.log("DEPOSITED ETH")


  // STREAM MONEY =============================================================
  await api.streamMoney({
    /** Amount to send in units of exchange of the source uplink */
    amount: new BigNumber(10),
    /** Sending uplink */
    source: xrpUplink,
    /** Receiving uplink */
    dest: ethUplink,
    /** Optionally, specify a maximum slippage margin against the most recently fetched exchange rate */
    slippage: 0.02
  })
  console.log("STREAMED XRP TO ETH")
  await new Promise(r => setTimeout(r, 2000)) // wait until the connector has finished settling the fulfilled packets


  // WITHDRAW & REMOVE UPLINKS =============================================================
  await api.withdraw({
    /** Uplink to withdraw from */
    uplink: ethUplink,

    /** Callback to authorize the fee and amount to be transferred to layer 1, after it's calculated */
    authorize: generateUserAuthorizeFunc("Withdraw", "ETH")
  })
  console.log("WITHDREW ETH")
  await api.remove(ethUplink)
  console.log("REMOVED ETH")

  await api.withdraw({
    /** Uplink to withdraw from */
    uplink: xrpUplink,

    /** Callback to authorize the fee and amount to be transferred to layer 1, after it's calculated */
    authorize: generateUserAuthorizeFunc("Withdraw", "XRP")
  })
  console.log("WITHDREW XRP")
  await api.remove(xrpUplink)
  console.log("REMOVED XRP")


  // DISCONNECT API =============================================================
  await api.disconnect()
  console.log("DISCONNECTED API")

}
main().then(res => process.exit(0)).catch(e => { console.log(e); process.exit(1) })

