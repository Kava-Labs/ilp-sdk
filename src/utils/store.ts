export interface PluginStore {
  readonly get: (key: string) => Promise<string | void>
  readonly put: (key: string, value: string) => Promise<void>
  readonly del: (key: string) => Promise<void>
}

export interface SimpleStore {
  /* tslint:disable-next-line:readonly-keyword TODO */
  [key: string]: string
}

export class MemoryStore implements PluginStore {
  private readonly store: SimpleStore
  private readonly prefix: string

  constructor(store: SimpleStore = {}, prefix = '') {
    this.store = store
    this.prefix = prefix
  }

  /** Async actions (for plugins to support DB) */

  async get(key: string): Promise<string | undefined> {
    return this.getSync(key)
  }

  async put(key: string, val: string): Promise<void> {
    this.putSync(key, val)
  }

  async del(key: string): Promise<void> {
    this.delSync(key)
  }

  /** Synchronous actions (in-memory only) */

  getSync(key: string): string | undefined {
    return this.store[this.prefix + key]
  }

  putSync(key: string, val: string): void {
    this.store[this.prefix + key] = val
  }

  delSync(key: string): void {
    delete this.store[this.prefix + key]
  }
}
