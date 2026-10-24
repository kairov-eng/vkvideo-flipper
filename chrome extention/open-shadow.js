(() => {
  const original = Element.prototype.attachShadow;
  if (original.vkFlipPatched) return;

  function attachShadowOpen(init) {
    const options = Object.assign({}, init || {}, { mode: "open" });
    const root = original.call(this, options);
    this.dispatchEvent(
      new CustomEvent("vkflip-shadow-open", { bubbles: true, composed: true })
    );
    return root;
  }

  attachShadowOpen.vkFlipPatched = true;
  Element.prototype.attachShadow = attachShadowOpen;
})();
