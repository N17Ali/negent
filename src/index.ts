import { Env } from './types';
import { handleUpdate } from './bot/commands';
import { getCronHandler } from './utils/cronRegistry';

// Import cron handlers to trigger their registerCron calls
import './cron/fetch';
import './cron/select';
import './cron/deliver';

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
    // Awaited inline (NOT ctx.waitUntil): waitUntil work is capped to a small window after the
    // response is sent, which truncates the slow summarize/voice passes. Awaiting keeps the
    // invocation alive for the full run. The trade-off is that a client disconnect cancels the
    // invocation — so test with `curl` (which stays connected), not a browser tab that may
    // give up. Delivery sends text before the slow audio pass, so even a mid-run cancel can't
    // lose the summary.
    if (url.pathname === `/run-select/${env.BOT_TOKEN}`) {
      const force = ['1', 'true', 'yes'].includes((url.searchParams.get('force') || '').toLowerCase());
      const handler = getCronHandler('30 5,6,7,8,9,10,11,12,13,14,15,16 * * *');
      if (!handler) {
        return new Response('select cron not registered', { status: 500 });
      }
      try {
        await handler(env, force);
      } catch (err) {
        console.error('run-select error:', err instanceof Error ? err.message : err);
        return new Response('select failed', { status: 500 });
      }
      return new Response(force ? 'select done (force)' : 'select done');
    }

    // Manual trigger for the deliver cron — ships ONE ready article (text, then voice reply).
    // Hit it repeatedly to drain the backlog. `?force=1` bypasses the delivery-hours gate and
    // the per-subscriber rate limit so the bot can be exercised at night during development.
    // Awaited inline for the same reason as run-select — test with `curl`, not a browser tab.
    if (url.pathname === `/run-deliver/${env.BOT_TOKEN}`) {
      const force = ['1', 'true', 'yes'].includes((url.searchParams.get('force') || '').toLowerCase());
      const handler = getCronHandler('5-59/10 * * * *');
      if (!handler) {
        return new Response('deliver cron not registered', { status: 500 });
      }
      try {
        const sent = await handler(env, force);
        return new Response(sent === true ? 'delivered one' : 'nothing to deliver');
      } catch (err) {
        console.error('run-deliver error:', err instanceof Error ? err.message : err);
        return new Response('deliver failed', { status: 500 });
      }
    }

    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`cron triggered: "${event.cron}"`);
    const handler = getCronHandler(event.cron);
    if (!handler) {
      console.warn(`unknown cron expression: "${event.cron}"`);
      return;
    }
    await handler(env);
  },
};
