function setBackgroundBlur(targetId, scrollDivisor = 300, disableBlur = false, isMenuBlur = false) {
  if (!targetId) {
    console.error("data-blur-id is null");
    return;
  }
  const blurElement = document.getElementById(targetId);
  if (!blurElement) return;
  if (disableBlur) {
    blurElement.setAttribute("aria-hidden", "true");
    if (!isMenuBlur) {
      blurElement.style.display = "none";
      blurElement.style.opacity = "0";
    } else {
      blurElement.style.display = "";
    }
  } else {
    blurElement.style.display = "";
    blurElement.removeAttribute("aria-hidden");
  }
  
  let ticking = false;
  const updateBlur = () => {
    if (!disableBlur || isMenuBlur) {
      if (!ticking) {
        requestAnimationFrame(() => {
          const scroll = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
          if (scroll <= scrollDivisor * 1.5) {
              blurElement.style.opacity = Math.min(scroll / scrollDivisor, 1);
          } else {
              blurElement.style.opacity = "1";
          }
          ticking = false;
        });
        ticking = true;
      }
    }
  };
  
  blurElement.setAttribute("role", "presentation");
  blurElement.setAttribute("tabindex", "-1");

  // CPU Scaling via IntersectionObserver:
  // Create an invisible sentinel bounding box corresponding exactly to the required scroll Math
  const sentinel = document.createElement("div");
  sentinel.style.cssText = `position: absolute; top: 0; left: 0; width: 1px; height: ${Math.ceil(scrollDivisor * 1.5)}px; pointer-events: none; visibility: hidden; z-index: -1;`;
  document.body.prepend(sentinel);

  const observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      window.addEventListener("scroll", updateBlur, { passive: true });
      updateBlur();
    } else {
      window.removeEventListener("scroll", updateBlur);
      // Hard clamp the opacity to max when the sentinel is fully off-screen
      if (!disableBlur || isMenuBlur) blurElement.style.opacity = "1";
    }
  });

  observer.observe(sentinel);
}

document.querySelectorAll("script[data-blur-id]").forEach((script) => {
  const targetId = script.getAttribute("data-blur-id");
  const scrollDivisor = Number(script.getAttribute("data-scroll-divisor") || 300);
  const isMenuBlur = targetId === "menu-blur";
  const settings = JSON.parse(localStorage.getItem("a11ySettings") || "{}");
  const disableBlur = settings.disableBlur || false;
  setBackgroundBlur(targetId, scrollDivisor, disableBlur, isMenuBlur);
});
