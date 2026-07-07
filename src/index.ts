import { Env } from './types';
import { fetchCron } from './cron/fetch';
import { selectCron } from './cron/select';
import { handleUpdate } from './bot/commands';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

    // Manual trigger for the select cron (selection → summarize → deliver).
    // Token in path gates access; selectCron still enforces delivery hours.
    // Runs in the background via waitUntil so the full pipeline completes even
    // after the HTTP response is sent (an inline await gets canceled on disconnect).
    if (url.pathname === `/run-select/${env.BOT_TOKEN}`) {
      ctx.waitUntil(selectCron(env));
      return new Response('select triggered');
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`cron triggered: "${event.cron}"`);
    switch (event.cron) {
      case '*/10 * * * *':
        ctx.waitUntil(fetchCron(env));
        break;
      case '30 5,8,11,14,16 * * *':
        ctx.waitUntil(selectCron(env));
        break;
      default:
        console.warn(`unknown cron expression: "${event.cron}"`);
    }
  },
};
