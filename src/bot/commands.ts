import { Env } from '../types';
import { handleStart, handleStop, handleSources, handleStatus } from './handlers';

interface TelegramUpdate {
  message?: {
    chat: { id: number };
    from?: { username?: string; first_name?: string };
    text?: string;
  };
}

export async function handleUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const username = msg.from?.username || null;
  const firstName = msg.from?.first_name || null;

  console.log(`command from ${chatId} (${username || firstName}): "${text}"`);

  switch (text) {
    case '/start':
      await handleStart(chatId, username, firstName, env);
      break;
    case '/stop':
      await handleStop(chatId, env);
      break;
    case '/sources':
      await handleSources(chatId, env);
      break;
    case '/status':
      await handleStatus(chatId, env);
      break;
    default:
      console.log(`unknown command: "${text}"`);
  }
}