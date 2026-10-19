// Helper HTTP condiviso per le chiamate alle API EA

// Header standard per le richieste JSON autenticate verso UTAS
export function buildEaHeaders(xUtSid, extra = {}) {
  return new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "content-type": "application/json",
    "X-UT-SID": xUtSid,
    ...extra
  });
}

// Wrapper fetch con header EA e gestione uniforme degli errori di rete.
// Ritorna la Response grezza: la gestione degli status (401, 429, ...) resta al chiamante.
export async function eaFetch(url, { method = "GET", xUtSid, body = null, headers = {}, ...rest } = {}) {
  if (!xUtSid) {
    throw new Error("X-UT-SID non definito");
  }
  return fetch(url, {
    method,
    headers: buildEaHeaders(xUtSid, headers),
    body: body ? JSON.stringify(body) : null,
    ...rest
  });
}
