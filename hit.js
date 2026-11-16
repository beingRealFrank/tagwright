// Page views and free-check runs are counted by GoatCounter (cookieless, no personal data), site "tagwright". Does nothing if Do Not Track is on.
(() => {
  if (navigator.doNotTrack === "1") return;
  const gc = document.createElement("script");
  gc.async = true; gc.src = "//gc.zgo.at/count.js"; gc.dataset.goatcounter = "https://tagwright.goatcounter.com/count";
  document.head.appendChild(gc);
  window.twHit = (name) => { try { if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: name, title: name, event: true }); } catch (_) {} };
})();
