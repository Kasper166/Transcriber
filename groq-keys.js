// Try the alternate key only on a rate-limit response. Other failures should
// remain visible instead of triggering duplicate requests.
export function withGroqFallback(fetchAPI, keys) {
  const unique = [...new Set(keys.filter(key => key && key !== 'your-api-key-here'))];
  let preferred = 0;
  return async (url, options) => {
    if (!unique.length) return fetchAPI(url, options);
    let response;
    for (let attempt = 0; attempt < unique.length; attempt++) {
      const index = (preferred + attempt) % unique.length;
      response = await fetchAPI(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${unique[index]}` } });
      if (response.status !== 429) {
        if (response.ok) preferred = index;
        return response;
      }
      if (attempt < unique.length - 1) await response.body?.cancel();
    }
    return response;
  };
}
