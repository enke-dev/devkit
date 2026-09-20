/**
 * A boolean as WAI-ARIA spells it.
 *
 * ARIA's boolean attributes take the strings `"true"` and `"false"`. They are
 * not boolean attributes in the HTML sense, where presence is the whole value:
 * `aria-pressed="false"` says "a toggle, currently off", while no attribute at
 * all says "not a toggle". So they have to be written out.
 *
 * `String(value)` writes them correctly and types them as `string`, which the
 * typed ARIA attributes do not accept — hence this, which returns the union
 * they are declared as.
 *
 * `@enke.dev/lit-utils` solves the other half of the same problem with
 * `StringifiedBooleanConverter`, which reflects a boolean *property* onto such
 * an attribute. This is the template side: the ones computed while rendering
 * rather than held as state.
 */
export function ariaBoolean(value: boolean): 'true' | 'false' {
  return value ? 'true' : 'false';
}
