/**
 * Entry point, and the only file `index.html` names.
 *
 * Everything else is reached from here: the global stylesheet, which is the
 * palette and the page shell, and the root component, which pulls in the rest.
 *
 * Two roots, not one. The detached inspector is the same document loaded in a
 * second window with `?view=inspector`, so that one swaps the app out for the
 * inspector rather than being a page of its own — one HTML file, one bundle,
 * and no way for the two to drift apart.
 */
import './styles/styles.css';

import { isInspectorView } from './utils/detached.utils.js';

if (isInspectorView()) {
  await import('./components/inspector-window/inspector-window.component.js');
  document.body.replaceChildren(document.createElement('devkit-inspector-window'));
} else {
  await import('./components/app/app.component.js');
}
