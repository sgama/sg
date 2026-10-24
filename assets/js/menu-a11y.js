// Entry point for the navigation menu's accessibility behaviour (concatenated into the page script bundle).
import { createFeatureHost } from './core/feature-host.js';
import { menuButtons } from './menu/buttons.js';
import { mobileMenuDismissal } from './menu/mobile-dismissal.js';
import { desktopDropdowns } from './menu/desktop-dropdowns.js';

createFeatureHost({ features: [menuButtons, mobileMenuDismissal, desktopDropdowns] }).start();
