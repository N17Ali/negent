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
    //
    // Kicked off via ctx.waitUntil (fire-and-forget) rather than awaited inline: selection +
    // summarization is slow, and if the client disconnects while we await, the runtime
    // cancels the whole invocation mid-pipeline. waitUntil keeps it running server-side
    // independent of the client — watch `npm run tail` for the outcome.
    if (url.pathname === `/run-select/${env.BOT_TOKEN}`) {
      const force = ['1', 'true', 'yes'].includes((url.searchParams.get('force') || '').toLowerCase());
      ctx.waitUntil(
        selectCron(env, force).catch((err) =>
          console.error('run-select error:', err instanceof Error ? err.message : err)
        )
      );
      return new Response(force ? 'select started (force) — watch logs' : 'select started — watch logs');
    }

    // Manual trigger for the deliver cron — ships ONE ready article (text + voice). Hit it
    // repeatedly to drain the backlog. `?force=1` bypasses the delivery-hours gate and the
    // per-subscriber rate limit so the bot can be exercised at night during development.
    //
    // Fire-and-forget via ctx.waitUntil for the same reason: voice-first delivery generates
    // the whole WAV before sending, which can take a minute; awaiting it inline meant a
    // browser giving up would cancel the invocation before the text/voice ever went out.
    if (url.pathname === `/run-deliver/${env.BOT_TOKEN}`) {
      const force = ['1', 'true', 'yes'].includes((url.searchParams.get('force') || '').toLowerCase());
      ctx.waitUntil(
        deliverCron(env, force)
          .then((sent) => console.log(`run-deliver: ${sent ? 'delivered one' : 'nothing to deliver'}`))
          .catch((err) => console.error('run-deliver error:', err instanceof Error ? err.message : err))
      );
      return new Response('deliver started — watch logs');
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
