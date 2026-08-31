/**
 * Run tasks with a ceiling on how many are in flight.
 *
 * The R package rendered cells one after another; a folder of forty plots is
 * the common case and most of that time is spent waiting on a converter or a
 * renderer. Running a few at once is the single most visible speed-up of the
 * port — but only a few: each in-flight page holds a decoded bitmap, and a
 * dozen A3 pages at 300 dpi is gigabytes.
 */
export async function mapWithLimit<Input, Output>(
  items: readonly Input[],
  limit: number,
  worker: (item: Input, index: number) => Promise<Output>,
  options: { readonly signal?: AbortSignal | undefined } = {},
): Promise<Output[]> {
  if (limit < 1) throw new RangeError(`Concurrency limit must be at least 1, got ${limit}.`);

  const results = new Array<Output>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      // Checked between items rather than inside them: a half-rendered page is
      // worth finishing, and stopping there keeps the cache consistent.
      if (options.signal?.aborted === true) throw new CancelledError();

      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);
  return results;
}

/** Thrown when work was stopped on purpose, so callers can say so rather than report a failure. */
export class CancelledError extends Error {
  constructor(message = 'Cancelled.') {
    super(message);
    this.name = 'CancelledError';
  }
}

/** A sensible default: enough to hide latency, few enough to bound memory. */
export function defaultConcurrency(cpuCount: number): number {
  return Math.max(2, Math.min(6, cpuCount - 1));
}
