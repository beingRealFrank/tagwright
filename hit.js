// Privacy-friendly counter: sends page, event and referrer host to our own intake service. No cookies, no IP, no ID.
(() => {
  if (navigator.doNotTrack === "1") return;
  const API = "https://tagwright-intake.netlify.app/api/hit";
  const send = (e) => { try { const b = new Blob([JSON.stringify({ e, p: location.pathname.replace(/^\/tagwright/, "") || "/", r: document.referrer ? new URL(document.referrer).hostname : "" })], { type: "application/json" }); navigator.sendBeacon(API, b); } catch (_) {} };
  // Page views also go to GoatCounter (cookieless); the path starts with the host so this site stays separate from other sites counted there.
  window.goatcounter = { path: (p) => location.host + p };
  const gc = document.createElement("script");
  gc.async = true; gc.src = "//gc.zgo.at/count.js"; gc.dataset.goatcounter = "https://sendwell.goatcounter.com/count";
  document.head.appendChild(gc);
  window.twHit = send;
  send(location.pathname.endsWith("order.html") ? "order_view" : "view");
})();
