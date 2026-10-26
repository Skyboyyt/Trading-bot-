/** Injected time source. Strategy, risk and paper execution never read the wall clock directly. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Deterministic clock for tests and replays. */
export class ManualClock implements Clock {
  #ms: number;

  constructor(start: Date | string | number) {
    this.#ms = new Date(start).getTime();
    if (Number.isNaN(this.#ms)) throw new Error(`Invalid clock start: ${String(start)}`);
  }

  now(): Date {
    return new Date(this.#ms);
  }

  advance(ms: number): Date {
    if (ms < 0) throw new Error("ManualClock cannot move backwards");
    this.#ms += ms;
    return this.now();
  }

  set(to: Date | string | number): void {
    const next = new Date(to).getTime();
    if (next < this.#ms) throw new Error("ManualClock cannot move backwards");
    this.#ms = next;
  }
}

export const MINUTE_MS = 60_000;
export const SECOND_MS = 1_000;

/** Floor a timestamp to the start of its minute (UTC). */
export function floorToMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS);
}
