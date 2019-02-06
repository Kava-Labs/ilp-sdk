declare module 'envkey' {
  interface VarsSet {
    [envVar: string]: string
  }

  export = VarsSet
}
