import { handle } from 'hono/cloudflare-pages';
import { createChatApp } from '../_lib/chat-app.js';

export const onRequest = handle(createChatApp());
