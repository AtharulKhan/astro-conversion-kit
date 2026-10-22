// Form fields, shared by the capture and the forms gate so both read a form the same way.
// No side effects on import.
import { attr, findAll } from './html.mjs';

const NOT_FIELDS = new Set(['submit', 'button', 'reset', 'image']);

// The named input, select and textarea fields of a <form> node, without submit, button, reset
// and image inputs: [{ name, type, required }] in document order.
export function formFields(form) {
  return findAll(form, (n) => ['input', 'select', 'textarea'].includes(n.tagName))
    .filter((n) => attr(n, 'name'))
    .map((n) => ({
      name: attr(n, 'name'),
      type: n.tagName === 'input' ? (attr(n, 'type') || 'text').toLowerCase() : n.tagName,
      required: attr(n, 'required') !== null,
    }))
    .filter((field) => !NOT_FIELDS.has(field.type));
}
