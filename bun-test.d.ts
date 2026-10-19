declare module "bun:test" {
  export function describe(name: string, fn: () => void): void
  export function test(
    name: string,
    fn: () => void | Promise<void>,
    timeout?: number
  ): void
  export namespace test {
    function each<T>(
      cases: readonly T[]
    ): (
      name: string,
      fn: (value: T) => void | Promise<void>,
      timeout?: number
    ) => void
  }
  export function it(name: string, fn: () => void | Promise<void>): void
  export function expect<T>(value: T): {
    toBe(expected: T): void
    toEqual(expected: unknown): void
    toBeTruthy(): void
    toBeFalsy(): void
    toBeNull(): void
    toBeUndefined(): void
    toBeDefined(): void
    toBeInstanceOf(expected: unknown): void
    toContain(expected: unknown): void
    toHaveLength(expected: number): void
    toThrow(expected?: string | RegExp | Error): void
    toMatchObject(expected: Record<string, unknown>): void
    toBeGreaterThan(expected: number): void
    toBeGreaterThanOrEqual(expected: number): void
    toBeLessThan(expected: number): void
    toBeLessThanOrEqual(expected: number): void
    toMatchSnapshot(): void
    not: {
      toBe(expected: T): void
      toEqual(expected: unknown): void
      toBeTruthy(): void
      toBeFalsy(): void
      toBeNull(): void
      toBeUndefined(): void
      toBeDefined(): void
      toContain(expected: unknown): void
      toHaveLength(expected: number): void
      toThrow(expected?: string | RegExp | Error): void
      toMatchObject(expected: Record<string, unknown>): void
    }
  }
  export function beforeEach(fn: () => void | Promise<void>): void
  export function afterEach(fn: () => void | Promise<void>): void
  export function beforeAll(fn: () => void | Promise<void>): void
  export function afterAll(fn: () => void | Promise<void>): void
  export function spyOn<T, K extends keyof T>(
    object: T,
    key: K
  ): {
    mockImplementation(fn: T[K]): { mockRestore(): void }
    mockRestore(): void
  }
  export function mock<T extends (...args: unknown[]) => unknown>(
    fn?: T
  ): T & { mock: { calls: unknown[][]; results: unknown[] } }
}
