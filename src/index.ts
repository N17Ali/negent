import { Env } from './types';
import { fetchCron } from './cron/fetch';
import { processCron } from './cron/process';
import { deliverCron } from './cron/deliver';
import { handleUpdate } from './bot/commands';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === `/webhook/${env.BOT_TOKEN}`) {
      try {
        const update = await request.json();
        await handleUpdate(update as any, env);
      } catch (err) {
        console.error('webhook error:', err instanceof Error ? err.message : err);
      }
      return new Response('OK', { status: 200 });
    }

    if (url.pathname === '/health') {
      return new Response('negent is running');
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`cron triggered: "${event.cron}"`);
    switch (event.cron) {
      case '*/20 * * * *':
        ctx.waitUntil(fetchCron(env));
        break;
      case '1-59/20 * * * *':
        ctx.waitUntil(processCron(env));
        break;
      case '0 */3 * * *':
        ctx.waitUntil(deliverCron(env));
        break;
      default:
        console.warn(`unknown cron expression: "${event.cron}"`);
    }
  },
};
