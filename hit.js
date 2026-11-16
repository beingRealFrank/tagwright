// Privacy-friendly counter: sends page, event and referrer host to our own intake service. No cookies, no IP, no ID.
(() => {
  if (navigator.doNotTrack === "1") return;
  const API = "https://tagwright-intake.netlify.app/api/hit";
  const send = (e) => { try { const b = new Blob([JSON.stringify({ e, p: location.pathname.replace(/^\/tagwright/, "") || "/", r: document.referrer ? new URL(document.referrer).hostname : "" })], { type: "application/json" }); navigator.sendBeacon(API, b); } catch (_) {} };
  window.twHit = send;
  send(location.pathname.endsWith("order.html") ? "order_view" : "view");
})();
