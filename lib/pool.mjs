// Bounded-concurrency runner. Lived in lib/sources/html.mjs, but nothing about
// it is HTML or HTTP — jobs.mjs had to import the scraper helpers to run its
// LLM calls, which made "sources/html" look like a dependency of the LLM gate.

// Run `worker` over `items` with at most `limit` in flight at once.
export async function pool(items, limit, worker) {
  let i = 0;
  limit = Math.max(1, Number(limit) || 1);   // "five" or 0 must not silently run zero workers (a hung Promise.all([]) caller)
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}
