// Tabella centralizzata degli status code EA: unica fonte di verità per la policy di reazione.
// Ogni voce: azione da intraprendere e soglia/severità.

export const EA_STATUS_POLICY = {
  401: { action: "session-refresh", label: "Sessione scaduta" },
  426: { action: "rate-limit", label: "Upgrade Required (soft-ban ricerche)" },
  429: { action: "rate-limit", label: "Too Many Requests" },
  458: { action: "stop-captcha", label: "FunCaptcha richiesto" },
  461: { action: "bid-soft-ban", label: "Soft-ban offerte/acquisti" },
  470: { action: "outbid", label: "Offerta superata" },
  478: { action: "trade-blocked", label: "Trade non consentito" },
  512: { action: "rate-limit", label: "Market Restricted" },
  521: { action: "rate-limit", label: "Server EA in congestione" }
};

export function isRateLimitStatus(status) {
  return EA_STATUS_POLICY[status]?.action === "rate-limit";
}

export function getStatusAction(status) {
  return EA_STATUS_POLICY[status]?.action || "unknown";
}
