import { pagesHandler } from '../_lib/pages-adapter.js';
import { createChatApp } from '../_lib/chat-app.js';

export const onRequest = pagesHandler(createChatApp());
