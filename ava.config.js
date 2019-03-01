export default {
  files: ['build/__tests__/**/*.test.js'],
  failFast: true,
  verbose: true,
  serial: true,
  timeout: '2m',
  require: ['source-map-support/register']
}
