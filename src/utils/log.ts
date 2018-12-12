import pino from 'pino'

export default (name: string) =>
  pino({
    name,
    level: 'trace',
    base: {
      name
    },
    prettyPrint: {
      colorize: true,
      translateTime: 'yyyy-mm-dd HH:MM:ss.l'
    }
  })
