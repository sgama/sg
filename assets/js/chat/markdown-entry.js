// Separate build entry for the chat's Markdown libraries. Hugo must not inline these into the
// widget bundle: they are fetched once, by URL, only when a conversation is first opened.
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export { marked, DOMPurify };
