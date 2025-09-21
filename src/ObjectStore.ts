class ObjectStore {
  static #instance: ObjectStore;
  #store: Map<string, any>;

  private constructor() {
    this.#store = new Map();
  }

  public static getInstance(): ObjectStore {
    if (!ObjectStore.#instance) {
      ObjectStore.#instance = new ObjectStore();
    }
    return ObjectStore.#instance;
  }

  // Set an item
  public set<T>(key: string, value: T): void {
    this.#store.set(key, value);
  }

  public get<T>(key: string): T | undefined {
    return this.#store.get(key);
  }

  public delete(key: string): boolean {
    return this.#store.delete(key);
  }

  public clear(): void {
    this.#store.clear();
  }
}

export default ObjectStore.getInstance();
