// Entry point for the site's progressive enhancements. Add or remove a feature by editing this list.
import { createFeatureHost } from './core/feature-host.js';
import { a11yBlur, a11yStars } from './site/features/a11y.js';
import { chatTriggers } from './site/features/chat-triggers.js';
import { starfield } from './site/features/starfield.js';
import { suggestionChips } from './site/features/suggestion-chips.js';

createFeatureHost({ features: [chatTriggers, a11yStars, a11yBlur, suggestionChips, starfield] }).start();
