import { INSPECTED_PROPERTIES, STYLE_VALUE_PRECISION } from '@devkit/protocol';

/**
 * The name the walker is installed under in the page.
 *
 * Long and unlovely on purpose: it has to be a name no page would pick for
 * itself, because the page is somebody else's and this is a guest in it.
 */
export const WALKER_KEY = '__devkitIntrospect__';

/**
 * The DOM and style walker, as source, injected once per context with
 * `addInitScript` rather than shipped with every call.
 *
 * It is a string rather than a function because it runs in the page while the
 * sidecar is a Node program compiled without the DOM lib — the alternative is
 * the `globalThis as unknown as { ... }` ceremony `readCursor` needs, repeated
 * for every DOM API a real inspector touches, which is most of them.
 *
 * What it must never do is change the page. It defines one non-enumerable
 * property and nothing else: no listeners, no elements, no styles. That is not
 * quite "unmutated" — a page that enumerates its own globals would find it —
 * but it is the least a shared walker can cost, and the alternative is paying
 * the parse of this whole file on every pointer move.
 *
 * The highlight is deliberately not in here. It is drawn in the app, over the
 * screencast: an overlay injected into the page would be captured in the very
 * frames it is meant to annotate.
 */
export const WALKER_SOURCE = `(() => {
  const KEY = ${JSON.stringify(WALKER_KEY)};
  if (globalThis[KEY]) {
    return;
  }

  const PROPERTIES = ${JSON.stringify(INSPECTED_PROPERTIES)};
  const PRECISION = ${STYLE_VALUE_PRECISION};

  /** Enough rules to explain an element, few enough to stay a message. */
  const MAX_RULES = 60;
  /** Attribute values are often a whole base64 image; the panel wants a hint. */
  const MAX_ATTRIBUTE = 200;
  const MAX_PREVIEW = 400;
  /** Guards against a frame or shadow tree that somehow points back at itself. */
  const MAX_DEPTH = 16;

  const factor = Math.pow(10, PRECISION);
  const round = value => Math.round(value * factor) / factor;

  /**
   * Flatten how a value is spelled without flattening what it says.
   *
   * The engines agree about rendering far more often than they agree about
   * serialising it, so an un-normalised diff lights up every row.
   */
  const channel = token =>
    token.endsWith('%') ? Math.round((parseFloat(token) * 255) / 100) : Math.round(parseFloat(token) || 0);
  const alpha = token => (token.endsWith('%') ? parseFloat(token) / 100 : parseFloat(token));

  const normaliseColour = value =>
    value.replace(/\\brgba?\\(([^()]*)\\)/gi, (whole, body) => {
      const parts = body.split(/[\\s,/]+/).filter(part => part.length > 0);
      if (parts.length < 3) {
        return whole;
      }
      const [r, g, b] = parts.map(channel);
      const a = parts.length > 3 ? alpha(parts[3]) : 1;
      return a >= 1
        ? 'rgb(' + r + ', ' + g + ', ' + b + ')'
        : 'rgba(' + r + ', ' + g + ', ' + b + ', ' + round(a) + ')';
    });

  // Only decimals: rounding integers would rewrite z-index and font-weight for
  // nothing, and the disagreements are all in the fractions.
  const normaliseNumbers = value =>
    value.replace(/-?\\d*\\.\\d+/g, match => String(round(parseFloat(match))));

  const normalise = (property, raw) => {
    const value = String(raw == null ? '' : raw).trim();
    if (property === 'font-family') {
      // Quoting and spacing differ per engine for the same stack.
      return value
        .replace(/["']/g, '')
        .split(',')
        .map(name => name.trim())
        .filter(name => name.length > 0)
        .join(', ');
    }
    return normaliseNumbers(normaliseColour(value));
  };

  const viewOf = node => (node.ownerDocument && node.ownerDocument.defaultView) || globalThis;

  const lengths = (style, names) =>
    names.map(name => parseFloat(style.getPropertyValue(name)) || 0);

  const rectOf = (x, y, width, height) => ({
    x: round(x),
    y: round(y),
    width: round(Math.max(0, width)),
    height: round(Math.max(0, height)),
  });

  /**
   * The four boxes, translated into top-level viewport pixels.
   *
   * An element inside a frame measures itself in that frame's coordinates, and
   * the overlay that draws these is outside every frame — so the offset the
   * descent accumulated is added back here. Without it the highlight lands
   * somewhere else on exactly the pages where a frame is involved.
   */
  const boxOf = (element, offsetX, offsetY) => {
    const rect = element.getBoundingClientRect();
    const style = viewOf(element).getComputedStyle(element);
    const [bl, br, bt, bb] = lengths(style, [
      'border-left-width',
      'border-right-width',
      'border-top-width',
      'border-bottom-width',
    ]);
    const [pl, pr, pt, pb] = lengths(style, [
      'padding-left',
      'padding-right',
      'padding-top',
      'padding-bottom',
    ]);
    const [ml, mr, mt, mb] = lengths(style, [
      'margin-left',
      'margin-right',
      'margin-top',
      'margin-bottom',
    ]);

    const border = rectOf(rect.left + offsetX, rect.top + offsetY, rect.width, rect.height);
    const padding = rectOf(
      border.x + bl,
      border.y + bt,
      border.width - bl - br,
      border.height - bt - bb
    );
    const content = rectOf(
      padding.x + pl,
      padding.y + pt,
      padding.width - pl - pr,
      padding.height - pt - pb
    );
    const margin = rectOf(
      border.x - ml,
      border.y - mt,
      border.width + ml + mr,
      border.height + mt + mb
    );
    return { content, padding, border, margin };
  };

  const classesOf = node =>
    node.classList ? Array.prototype.slice.call(node.classList) : [];

  /**
   * Which of its same-tag siblings this is, the way :nth-of-type counts.
   *
   * Not the raw child index. That changes whenever anything at all is inserted
   * beside the element — a dev server's overlay, a framework's style tag, a
   * script one engine kept and another folded away — and none of it means the
   * element is a different element. Counting within the tag ignores every
   * insertion that is not a sibling of the same kind, which is nearly all of
   * them.
   */
  const indexOf = node => {
    const parent = node.parentNode;
    const siblings = parent && parent.children ? parent.children : null;
    if (!siblings) {
      return 0;
    }
    return Array.prototype.slice
      .call(siblings)
      .filter(sibling => sibling.tagName === node.tagName)
      .indexOf(node);
  };

  const refOf = (node, boundary) => {
    const ref = {
      tag: node.tagName ? node.tagName.toLowerCase() : '#unknown',
      classes: classesOf(node),
      index: indexOf(node),
    };
    if (node.id) {
      ref.id = node.id;
    }
    if (boundary) {
      ref.boundary = boundary;
    }
    return ref;
  };

  /**
   * The breadcrumb from the element up to the outermost document, crossing
   * shadow roots and frames and saying which it crossed.
   *
   * Walked upwards rather than recorded on the way down, because the descent
   * only visits the boundaries it happened to pass through — the ordinary
   * parents between them are just as much of the answer, and the app derives
   * the element's identity from the whole chain.
   */
  const pathOf = element => {
    const path = [];
    let node = element;
    let depth = 0;
    while (node && depth < MAX_DEPTH * 16) {
      depth += 1;
      const parent = node.parentElement;
      if (parent) {
        node = parent;
        path.push(refOf(node));
        continue;
      }
      const root = node.getRootNode ? node.getRootNode() : null;
      if (root && root.host) {
        node = root.host;
        path.push(refOf(node, 'shadow'));
        continue;
      }
      const owner = root && root.defaultView ? root.defaultView.frameElement : null;
      if (owner) {
        node = owner;
        path.push(refOf(node, 'frame'));
        continue;
      }
      break;
    }
    return path;
  };

  const declarationsOf = style =>
    Array.prototype.slice.call(style).map(name => {
      const value = style.getPropertyValue(name);
      const priority = style.getPropertyPriority(name);
      return [name, priority ? value + ' !' + priority : value];
    });

  const conditionOf = rule => {
    if (rule.media && rule.media.mediaText) {
      return '@media ' + rule.media.mediaText;
    }
    if (rule.conditionText) {
      return '@supports ' + rule.conditionText;
    }
    if (rule.name !== undefined && rule.cssRules) {
      return '@layer ' + (rule.name || '');
    }
    return '';
  };

  /**
   * Every rule that matches, as far as the page will allow.
   *
   * Best-effort by nature: reading the rules of a sheet served from another
   * origin throws, and a page whose CSS comes from a CDN therefore has nothing
   * to show here. That is why it says how many sheets it could not open rather
   * than presenting a short list as the whole truth — an empty rules panel
   * otherwise reads as "this element is unstyled".
   */
  const rulesFor = element => {
    const found = [];
    const document = element.ownerDocument;
    let blocked = 0;

    if (element.style && element.style.length > 0) {
      found.push({
        selector: '',
        origin: 'element.style',
        conditions: [],
        declarations: declarationsOf(element.style),
      });
    }

    const collect = (rules, conditions, origin) => {
      rules.forEach(rule => {
        if (found.length >= MAX_RULES) {
          return;
        }
        if (rule.selectorText !== undefined && rule.style) {
          let matched = false;
          try {
            matched = element.matches(rule.selectorText);
          } catch (error) {
            // Selectors an engine cannot parse — vendor pseudo-elements, mostly
            // — are simply not matches here.
            matched = false;
          }
          if (matched) {
            found.push({
              selector: rule.selectorText,
              origin,
              conditions: conditions.slice(),
              declarations: declarationsOf(rule.style),
            });
          }
          return;
        }
        if (rule.cssRules) {
          const condition = conditionOf(rule);
          collect(
            Array.prototype.slice.call(rule.cssRules),
            condition ? conditions.concat([condition]) : conditions,
            origin
          );
        }
      });
    };

    const sheets = document.styleSheets ? Array.prototype.slice.call(document.styleSheets) : [];
    sheets.forEach(sheet => {
      let rules = null;
      try {
        rules = sheet.cssRules;
      } catch (error) {
        blocked += 1;
        return;
      }
      if (!rules) {
        blocked += 1;
        return;
      }
      collect(Array.prototype.slice.call(rules), [], sheet.href || '<style>');
    });

    const note =
      blocked > 0
        ? blocked + ' of ' + sheets.length + ' stylesheets could not be read (cross-origin)'
        : '';
    return { rules: blocked === sheets.length && sheets.length > 0 ? null : found, note };
  };

  /** Descend through open shadow roots at the same point, host by host. */
  const pierceShadow = (element, x, y) => {
    let current = element;
    let depth = 0;
    while (current && current.shadowRoot && current.shadowRoot.elementFromPoint && depth < MAX_DEPTH) {
      depth += 1;
      const inner = current.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === current) {
        break;
      }
      current = inner;
    }
    return current;
  };

  const FRAMES = ['iframe', 'frame', 'object', 'embed'];

  /**
   * Whether a frame is one this document may look into, judged from its src
   * before anything is touched.
   *
   * Reading contentDocument across origins does not throw — it quietly returns
   * null — but WebKit writes a security error into the page's own console for
   * the attempt. The inspector is a guest here and must not put words in the
   * page's mouth, so the question is answered from the URL instead, and the
   * property is only reached for when the answer is yes.
   *
   * A frame that redirected somewhere else after loading still gets touched
   * once. That is the residue, not the common case, which is an advert or an
   * embed that was cross-origin from the start.
   */
  const sameOrigin = element => {
    const source = element.getAttribute && element.getAttribute('src');
    if (!source || source === 'about:blank' || (element.hasAttribute && element.hasAttribute('srcdoc'))) {
      return true;
    }
    try {
      const base = element.ownerDocument.baseURI;
      return new URL(source, base).origin === new URL(base).origin;
    } catch (error) {
      return false;
    }
  };

  /**
   * The document inside a frame element: undefined when it is not a frame at
   * all, null when it is one this page may not look into.
   */
  const frameDocumentOf = element => {
    const tag = element.tagName ? element.tagName.toLowerCase() : '';
    if (!FRAMES.includes(tag)) {
      return undefined;
    }
    if (!sameOrigin(element)) {
      return null;
    }
    try {
      const document = element.contentDocument;
      return document && document.elementFromPoint ? document : null;
    } catch (error) {
      return null;
    }
  };

  /**
   * How far an element's own coordinate space sits from the top viewport's.
   *
   * The descent accumulates this on the way down, but a re-measure starts from
   * the element alone — the page has scrolled, and the frames it sits in may
   * have moved with it — so the chain is walked outwards again rather than
   * remembered. Remembering it is exactly the bug: an offset captured before a
   * scroll describes where the frame used to be.
   */
  const offsetOf = element => {
    let x = 0;
    let y = 0;
    let view = element.ownerDocument && element.ownerDocument.defaultView;
    let depth = 0;
    while (view && view.frameElement && depth < MAX_DEPTH) {
      depth += 1;
      const frame = view.frameElement;
      const origin = contentOriginOf(frame);
      x += origin.x;
      y += origin.y;
      view = frame.ownerDocument && frame.ownerDocument.defaultView;
    }
    return { x, y };
  };

  /** Where a frame's own viewport starts, in the coordinates of the document holding it. */
  const contentOriginOf = element => {
    const rect = element.getBoundingClientRect();
    const style = viewOf(element).getComputedStyle(element);
    const [bl, bt, pl, pt] = lengths(style, [
      'border-left-width',
      'border-top-width',
      'padding-left',
      'padding-top',
    ]);
    return { x: rect.left + bl + pl, y: rect.top + bt + pt };
  };

  const attributesOf = element =>
    Array.prototype.slice.call(element.attributes || [])
      .filter(attribute => attribute.name !== 'id' && attribute.name !== 'class')
      .map(attribute => [
        attribute.name,
        attribute.value.length > MAX_ATTRIBUTE
          ? attribute.value.slice(0, MAX_ATTRIBUTE) + '…'
          : attribute.value,
      ]);

  /**
   * What is at a point, piercing shadow roots and same-origin frames.
   *
   * Coordinates are the top-level viewport's, the same ones input uses, and are
   * translated down on the way into each frame — elementFromPoint inside a
   * frame speaks that frame's coordinates, so handing it the outer ones would
   * quietly return the wrong element rather than fail.
   *
   * The element and the offsets that belong to it are kept together, because
   * the descent can advance into a frame and then find nothing there: the
   * answer is then the frame element itself, and it must be measured where it
   * lives rather than where its contents would have been.
   */
  /**
   * The element the last inspection landed on, and what was said about it.
   *
   * The only state the walker keeps. A point identifies an element at the
   * moment it is asked, and nothing else in this design can name that element
   * again — so re-measuring a selection after the page has scrolled needs the
   * element itself, held here. Per document: a navigation gets a fresh global
   * and therefore a fresh, empty one.
   */
  let selected = null;
  let selection = null;

  const resolve = (x, y) => {
    let document = globalThis.document;
    let pointX = x;
    let pointY = y;
    let offsetX = 0;
    let offsetY = 0;
    let element = null;
    let elementOffsetX = 0;
    let elementOffsetY = 0;
    let elementX = x;
    let elementY = y;
    let pierceNote = '';
    let depth = 0;

    while (depth < MAX_DEPTH) {
      depth += 1;
      const found = document.elementFromPoint(pointX, pointY);
      if (!found) {
        break;
      }
      element = pierceShadow(found, pointX, pointY);
      elementOffsetX = offsetX;
      elementOffsetY = offsetY;
      // The point in the coordinates the element itself measures in, which is
      // what anything comparing against its own rects has to use.
      elementX = pointX;
      elementY = pointY;

      const inner = frameDocumentOf(element);
      if (inner === undefined) {
        break;
      }
      if (inner === null) {
        pierceNote = 'stopped at a cross-origin frame';
        break;
      }
      const origin = contentOriginOf(element);
      offsetX += origin.x;
      offsetY += origin.y;
      pointX -= origin.x;
      pointY -= origin.y;
      document = inner;
    }

    if (!element) {
      return null;
    }
    return {
      element,
      offsetX: elementOffsetX,
      offsetY: elementOffsetY,
      localX: elementX,
      localY: elementY,
      pierceNote,
    };
  };

  /**
   * What is at a point, described.
   *
   * The descent is shared with the cursor probe below: both questions are
   * "which element is at this point", and only what is read off it differs.
   */
  const inspect = (x, y) => {
    const found = resolve(x, y);
    if (!found) {
      return null;
    }
    const { element, offsetX: elementOffsetX, offsetY: elementOffsetY, pierceNote } = found;

    const style = viewOf(element).getComputedStyle(element);
    const matched = rulesFor(element);
    const result = {
      tag: element.tagName ? element.tagName.toLowerCase() : '#unknown',
      classes: classesOf(element),
      index: indexOf(element),
      attributes: attributesOf(element),
      path: pathOf(element),
      documentUrl: element.ownerDocument ? element.ownerDocument.URL : '',
      box: boxOf(element, elementOffsetX, elementOffsetY),
      styles: Object.fromEntries(
        PROPERTIES.map(property => [property, normalise(property, style.getPropertyValue(property))])
      ),
      rules: matched.rules,
    };
    if (element.id) {
      result.id = element.id;
    }
    if (matched.note) {
      result.rulesNote = matched.note;
    }
    if (pierceNote) {
      result.pierceNote = pierceNote;
    }
    selected = element;
    selection = result;
    return result;
  };

  /**
   * The selected element again, where it is now.
   *
   * Scrolling moves an element without changing anything about which element it
   * is, and the highlight is drawn from rectangles — so without this it stays
   * where the element used to be. Asking by point again would be wrong rather
   * than stale: the point now holds whatever scrolled into it.
   *
   * Only the box and the computed styles are taken again. The matched rules
   * mean walking every stylesheet in the document, which is far too expensive
   * to repeat on every scroll tick, and scrolling changes none of them.
   */
  const remeasure = () => {
    const element = selected;
    // Two different nothings, and the caller has to tell them apart: undefined
    // is "this pane has no selection", which is not worth announcing, while
    // null is "what was selected has gone", which is the highlight's cue to go
    // with it.
    if (!element || !selection) {
      return undefined;
    }
    if (element.isConnected === false) {
      return null;
    }
    const offset = offsetOf(element);
    const style = viewOf(element).getComputedStyle(element);
    return Object.assign({}, selection, {
      box: boxOf(element, offset.x, offset.y),
      styles: Object.fromEntries(
        PROPERTIES.map(property => [property, normalise(property, style.getPropertyValue(property))])
      ),
    });
  };

  /**
   * The cursor the engine would show at a point.
   *
   * Asked of the engine rather than inferred, so cursor: pointer on a link —
   * or a text caret, or a custom cursor — is whatever that engine decided,
   * which is the interesting answer for a tool that compares engines.
   *
   * It used to live in the sidecar and ship its own function body on every
   * pointer move, with its own copy of elementFromPoint. Here it shares the
   * descent, so it is also right inside shadow roots and frames, where the old
   * one reported whatever the host or the iframe element resolved to.
   */
  const LINKS =
    'a[href], button, summary, [role=button], [role=link], input[type=submit], input[type=button]';

  const cursorAt = (x, y) => {
    const found = resolve(x, y);
    // Nothing at that point is an answer rather than a failure: it is what a
    // pointer moved off the page finds, and the arrow is what the engine would
    // be showing for it. Answering null instead said nothing had changed, so a
    // pane kept whatever shape it was wearing when the pointer left it.
    if (!found) {
      return 'default';
    }
    const { element, localX, localY } = found;
    const view = viewOf(element);
    if (!view.getComputedStyle) {
      return null;
    }

    const css = view.getComputedStyle(element).cursor || 'auto';
    if (css !== 'auto') {
      return css;
    }

    // WebKit reports auto even over links, where Chromium and Gecko say
    // pointer, so what a link resolves to has to be worked out.
    if (element.closest && element.closest(LINKS)) {
      return 'pointer';
    }

    // auto also covers ordinary content, where a browser shows an I-beam over
    // text and an arrow beside it. Caret hit-testing is no good here: it snaps
    // to the nearest text and so claims 'text' across whole paragraphs of empty
    // space. Measuring the glyph boxes themselves is what makes the cursor
    // change back when leaving the words.
    const document = element.ownerDocument;
    const range = document && document.createRange ? document.createRange() : null;
    const TEXT_NODE = 3;
    const overText =
      range !== null &&
      Array.prototype.slice
        .call(element.childNodes || [])
        .filter(node => node.nodeType === TEXT_NODE && node.nodeValue && node.nodeValue.trim())
        .some(node => {
          range.selectNodeContents(node);
          return Array.prototype.slice
            .call(range.getClientRects())
            .some(
              rect =>
                localX >= rect.left &&
                localX <= rect.right &&
                localY >= rect.top &&
                localY <= rect.bottom
            );
        });
    return overText ? 'text' : 'default';
  };

  const truncate = text =>
    text.length > MAX_PREVIEW ? text.slice(0, MAX_PREVIEW) + '…' : text;

  /**
   * What kind of thing a value is, in the words a console would use.
   *
   * Primitives answer with typeof; everything else answers with its
   * constructor — Object, Array, Map, HTMLBodyElement. More useful than a
   * flattened 'object' would be, and it is the same word in all three engines
   * for everything the platform defines.
   */
  const typeOf = value => {
    const type = typeof value;
    if (type !== 'object') {
      return type;
    }
    return (value.constructor && value.constructor.name) || 'object';
  };

  const previewOf = value => {
    const type = typeof value;
    if (type === 'string') {
      return truncate(JSON.stringify(value));
    }
    if (type === 'function') {
      return 'ƒ ' + (value.name || 'anonymous') + '()';
    }
    if (value && value.nodeType === 1) {
      const id = value.id ? '#' + value.id : '';
      const classes = classesOf(value).map(name => '.' + name).join('');
      return '<' + value.tagName.toLowerCase() + id + classes + '>';
    }
    try {
      const text = JSON.stringify(value);
      return truncate(text === undefined ? String(value) : text);
    } catch (error) {
      return truncate(String(value));
    }
  };

  /**
   * Say what a value is rather than hand it over.
   *
   * Returning the value itself would put engine serialisation between the user
   * and their answer: a DOM node, a function or a cyclic object each fail
   * differently in each engine, which is noise rather than a finding. So the
   * value is printed here, in the page, where it is still itself.
   */
  const describe = value => {
    if (value === null) {
      return { kind: 'value', type: 'null', preview: 'null' };
    }
    if (value === undefined) {
      return { kind: 'value', type: 'undefined', preview: 'undefined' };
    }
    const type = typeOf(value);
    const result = { kind: 'value', type, preview: previewOf(value) };
    // Decided from the value rather than from the word for it: the word is a
    // constructor name, and every object would have missed this.
    if (typeof value === 'object' && value.nodeType !== 1) {
      try {
        const text = JSON.stringify(value);
        if (text !== undefined && text.length < 20000) {
          result.json = JSON.parse(text);
        }
      } catch (error) {
        // Cyclic, or something that throws from its own getter. The preview
        // already says what it was.
      }
    }
    return result;
  };

  const fail = error => ({
    kind: 'error',
    message: error && error.message ? String(error.message) : String(error),
    stack: error && error.stack ? String(error.stack).slice(0, 4000) : undefined,
  });

  Object.defineProperty(globalThis, KEY, {
    value: { inspect, remeasure, cursorAt, describe, fail },
    configurable: true,
    enumerable: false,
    writable: false,
  });
})();`;
