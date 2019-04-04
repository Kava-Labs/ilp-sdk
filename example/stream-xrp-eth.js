const { connect } = require('@kava-labs/switch-api')
const BigNumber = require('bignumber.js')

async function run() {
  // Connect the API, which uses testnet by default
  const api = await connect()
  
  // Add new uplink with an account on the Kovan Ethereum testnet
  const ethUplink = await api.add({
    settlerType: 'machinomy',
    privateKey: 'dd858dad15ce0e442e19365d2967b2aa9d06008518e6fdbf60d24a0352517603'
  })
  
  // Add new uplink with an XRP testnet credential
  const xrpUplink = await api.add({
    settlerType: 'xrp-paychan',
    secret: 'sahAw3PFc6gNnmJtWgFPgfsdSoZnY'
  })

  // Display the amount in client custody, in real-time
  xrpUplink.balance$.subscribe(amount => {
    console.log('XRP interledger balance:', amount.toString())
  })
  ethUplink.balance$.subscribe(amount => {
    console.log('ETH interledger balance:', amount.toString())
  })

  // Deposit 20 XRP into a payment channel
  await api.deposit({
    uplink: xrpUplink,
    amount: new BigNumber(20)
  })

  // Deposit 0.05 ETH into a payment channel
  await api.deposit({
    uplink: ethUplink,
    amount: new BigNumber(0.05)
  })

  // Stream 10 XRP to ETH, prefunding only $0.05 at a time
  // If the connector cheats or the exchange rate is too low, your funds are safe!
  await api.streamMoney({
    amount: new BigNumber(10),
    source: xrpUplink,
    dest: ethUplink
  })

  await api.disconnect()
}

if (!module.parent) {
  run().catch(err => console.error(err))
} else {
  module.exports = run
}
