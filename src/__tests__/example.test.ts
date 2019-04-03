import test from 'ava'

test('example does not error', t => {
  t.notThrows(() => require('../../example/stream-xrp-eth.js'))
})
