import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const purgecss = require('@fullhuman/postcss-purgecss');
const autoprefixer = require('autoprefixer');

const isProduction = process.env.HUGO_ENV === 'production' || process.env.NODE_ENV === 'production';

export default {
    plugins: [
        autoprefixer,
        ...(isProduction
            ? [
                  purgecss({
                      content: ['./layouts/**/*.html', './layouts/**/*.md', './content/**/*.md', './assets/**/*.js', './data/**/*.*'],
                      safelist: [
                          'dark',
                          'article-link--card',
                          'ai-chat-open',
                          'disable-stars',
                          'chat-cta__chips',
                          'chat-cta__chip',
                          'message--bot',
                          'message--user',
                          'message--loading',
                      ],
                      defaultExtractor: (content) => content.match(/[A-Za-z0-9-_:/]+/g) || [],
                  }),
              ]
            : []),
    ],
};
