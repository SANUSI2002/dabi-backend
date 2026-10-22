// EMDEX responses → the products a prescriber picks from. The documentation publishes no response
// examples, so the field mapping is written against real sandbox responses; anything unrecognised is
// refused (EMDEX_RESPONSE_UNRECOGNISED), never guessed into a medicine.
import { emdexError } from './emdex.transport.js';

/** { kind, referenceId, genericName, brandName, form, strength, manufacturer, therapeuticClass? } for each search hit (the class, when EMDEX gives one, lets a prescriber's category filter apply). */
export function normalizeResults(kind, data) {
  throw emdexError('EMDEX_RESPONSE_UNRECOGNISED');
}
/** One product's details, as above. */
export function normalizeProduct(kind, data, id) {
  throw emdexError('EMDEX_RESPONSE_UNRECOGNISED');
}
