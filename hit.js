// Privacy-friendly counter: sends page, event and referrer host to our own intake service. No cookies, no IP, no ID.
(() => {
  if (navigator.doNotTrack === "1") return;
  const API = "https://tagwright-intake.netlify.app/api/hit";
  const send = (e) => { try { const b = new Blob([JSON.stringify({ e, p: location.pathname.replace(/^\/tagwright/, "") || "/", r: document.referrer ? new URL(document.referrer).hostname : "" })], { type: "application/json" }); navigator.sendBeacon(API, b); } catch (_) {} };
  // Page views and free-tool runs also go to GoatCounter (cookieless), site code "tagwright".
  const gc = document.createElement("script");
  gc.async = true; gc.src = "//gc.zgo.at/count.js"; gc.dataset.goatcounter = "https://tagwright.goatcounter.com/count";
  document.head.appendChild(gc);
  const gcEvent = (name) => { try { if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: name, title: name, event: true }); } catch (_) {} };
  window.twHit = (e) => { send(e); gcEvent(e); };
  send(location.pathname.endsWith("order.html") ? "order_view" : "view");
})();
