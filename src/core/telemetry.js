// Telemetria in tempo reale verso server locale (http://127.0.0.1:3000/event)
export function reportTelemetry(type, message, data = null) {
  try {
    fetch("http://127.0.0.1:3000/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, message, data, timestamp: Date.now() })
    }).catch(() => { });
  } catch (_) { }
}
