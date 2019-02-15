import createLogger from 'ilp-logger'
export default (name: string) => createLogger(name)

// export default (name: string) =>
//   pino({
//     name,
//     level: 'trace',
//     base: {
//       name
//     },
//     prettyPrint: {
//       colorize: true,
//       translateTime: 'yyyy-mm-dd HH:MM:ss.l'
//     }
//   })
