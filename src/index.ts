import { Env } from './types';
import { fetchCron } from './cron/fetch';
import { selectCron } from './cron/select';
import { deliverCron } from './cron/deliver';
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

    // Manual trigger for the select cron (selection → summarize). Token in path gates
    // access. `?force=1` bypasses the delivery-hours gate so selection can be tested at
    // night. Delivery is a separate endpoint (/run-deliver) now.
    // Await the pipeline inline (rather than ctx.waitUntil) so the invocation stays alive
    // for its full duration.
    if (url.pathname === `/run-select/${env.BOT_TOKEN}`) {
      const force = ['1', 'true', 'yes'].includes((url.searchParams.get('force') || '').toLowerCase());
      try {
        await selectCron(env, force);
      } catch (err) {
        console.error('run-select error:', err instanceof Error ? err.message : err);
        return new Response('select failed', { status: 500 });
      }
      return new Response(force ? 'select done (force)' : 'select done');
    }

    // Manual trigger for the deliver cron — ships ONE ready article (text + voice). Hit it
    // repeatedly to drain the backlog. `?force=1` bypasses the delivery-hours gate and the
    // per-subscriber rate limit so the bot can be exercised at night during development.
    if (url.pathname === `/run-deliver/${env.BOT_TOKEN}`) {
      const force = ['1', 'true', 'yes'].includes((url.searchParams.get('force') || '').toLowerCase());
      try {
        const sent = await deliverCron(env, force);
        return new Response(sent ? 'delivered one' : 'nothing to deliver');
      } catch (err) {
        console.error('run-deliver error:', err instanceof Error ? err.message : err);
        return new Response('deliver failed', { status: 500 });
      }
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`cron triggered: "${event.cron}"`);
    switch (event.cron) {
      case '*/10 * * * *':
        ctx.waitUntil(fetchCron(env));
        break;
      case '5-59/10 * * * *':
        ctx.waitUntil(deliverCron(env).then(() => undefined));
        break;
      case '30 5,6,7,8,9,10,11,12,13,14,15,16 * * *':
        ctx.waitUntil(selectCron(env));
        break;
      default:
        console.warn(`unknown cron expression: "${event.cron}"`);
    }
  },
};
