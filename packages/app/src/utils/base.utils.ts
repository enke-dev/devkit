import type { CSSResultGroup } from 'lit';
import { LitElement } from 'lit';

import styles from './base.utils.css';

/**
 * Base class for DevKit's own components.
 *
 * A central place for what every component shares. Right now that is the
 * box-sizing rule and the font, which the shadow DOM does not inherit from the
 * page — without it each component would restate them.
 */
export class DevkitElement extends LitElement {
  static override styles: CSSResultGroup = [styles];

  /** Extend the shared styles rather than replacing them. */
  static withStyles<T extends typeof DevkitElement>(
    this: T,
    ...additionalStyles: CSSResultGroup[]
  ): T {
    const Base = this as typeof DevkitElement;
    return class extends Base {
      static override styles = [Base.styles, ...additionalStyles];
    } as unknown as T;
  }
}
