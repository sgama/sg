// Entry point for the site's progressive enhancements. Add or remove a feature by editing this list.
import { createFeatureHost } from './core/feature-host.js';
import { a11yBlur, a11yStars, avatarSpin, chatTriggers, starfield, suggestionChips } from './site/features.js';

createFeatureHost({ features: [chatTriggers, avatarSpin, a11yStars, a11yBlur, suggestionChips, starfield] }).start();
