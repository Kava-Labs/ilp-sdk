interface Flavoring<FlavorT> {
  readonly _type?: FlavorT
}

export type Flavor<T, FlavorT> = T & Flavoring<FlavorT>

export type Brand<K, T> = K & { readonly __brand: T }
