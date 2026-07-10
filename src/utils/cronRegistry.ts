import { Env } from '../types';

type CronHandler = (env: Env, force?: boolean) => Promise<void | boolean>;

const registry = new Map<string, CronHandler>();

export function registerCron(cronExpr: string, handler: CronHandler): void {
  if (registry.has(cronExpr)) {
    throw new Error(`Cron expression already registered: ${cronExpr}`);
  }
  registry.set(cronExpr, handler);
}

export function getCronHandler(cronExpr: string): CronHandler | undefined {
  return registry.get(cronExpr);
}

export function getRegisteredCrons(): string[] {
  return Array.from(registry.keys());
}