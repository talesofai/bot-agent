declare module "redlock" {
  export interface Lock {
    extend(ttl: number): Promise<Lock>;
    release(): Promise<void>;
  }

  export interface RedlockOptions {
    retryCount?: number;
    retryDelay?: number;
    retryJitter?: number;
  }

  export default class Redlock {
    constructor(clients: object[], options?: RedlockOptions);
    acquire(resources: string[], ttl: number): Promise<Lock>;
  }
}
