import test from 'ava'

const run = require('../../example/stream-xrp-eth.js')

test('example does not error', async t => {
  await t.notThrowsAsync(run())
})
