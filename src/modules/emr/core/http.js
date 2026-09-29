// Success responses for EMR routes: the { status: 'success', data } envelope, the record's
// version as a weak ETag, and the Idempotent-Replayed marker for replayed creates.
import { etagFor } from './concurrency.js';

export function send(res, data, status = 200) {
  if (data?.version) res.set('ETag', etagFor(data.version));
  res.status(status).json({ status: 'success', data });
}

/** For results of idempotent(): { statusCode, body, replayed }. */
export function sendResult(res, result) {
  if (result.replayed) res.set('Idempotent-Replayed', 'true');
  send(res, result.body, result.statusCode);
}

export const sendItems = (res, items) => res.json({ status: 'success', data: { items } });
