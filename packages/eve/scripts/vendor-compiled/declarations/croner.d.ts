export interface CronOptions {
  readonly unref?: boolean;
}

export type CronCallback = (job: Cron) => void | Promise<void>;

export declare class Cron {
  constructor(
    pattern: string | Date,
    optionsOrCallback?: CronOptions | CronCallback,
    callbackOrOptions?: CronOptions | CronCallback,
  );

  stop(): void;
}
