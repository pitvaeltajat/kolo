/** SWR fetcher that turns a non-2xx into a thrown Error carrying the API's Finnish message. */
export async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? `Virhe ${res.status}`);
  return body as T;
}

/** POST JSON, returning the parsed body; throws the API message on failure. */
export async function post<T = unknown>(url: string, data?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? `Virhe ${res.status}`);
  return body as T;
}
