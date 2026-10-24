// Entry point for the navigation menu's accessibility behaviour (concatenated into the page script bundle).
import { createFeatureHost } from './core/feature-host.js';
import { desktopDropdowns, menuButtons, mobileMenuDismissal } from './menu/features.js';

createFeatureHost({ features: [menuButtons, mobileMenuDismissal, desktopDropdowns] }).start();
