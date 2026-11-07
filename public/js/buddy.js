// buddy.js — the friendly studio companion: SVG character, speech bubble, notes log, celebration petals.
export function buddySvg() {
  return `<svg class="buddy" viewBox="0 0 120 120" data-mood="happy" role="img" aria-label="Buddy, your studio companion">
  <ellipse cx="60" cy="110" rx="30" ry="5" fill="rgba(52,50,61,.12)"/>
  <g class="body">
    <path d="M60 14C86 14 104 34 104 62C104 90 86 104 60 104C34 104 16 90 16 62C16 34 34 14 60 14Z" fill="#C9B8F0"/>
    <path d="M30 40C36 26 50 20 62 20" stroke="#fff" stroke-opacity=".5" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M60 15C58 5 50 2 45 6C52 6 56 9 60 15Z" fill="#9fcba0"/><path d="M60 15C62 6 70 3 75 8C68 8 64 10 60 15Z" fill="#b8dcb9"/>
    <ellipse cx="33" cy="70" rx="8" ry="5" fill="#F6C8D6"/><ellipse cx="87" cy="70" rx="8" ry="5" fill="#F6C8D6"/>
    <g class="eye"><ellipse cx="44" cy="58" rx="6" ry="7.5" fill="#34323D"/><circle class="pupil" cx="46" cy="55" r="2.2" fill="#fff"/></g>
    <g class="eye"><ellipse cx="76" cy="58" rx="6" ry="7.5" fill="#34323D"/><circle class="pupil" cx="78" cy="55" r="2.2" fill="#fff"/></g>
    <path class="m m-happy" d="M51 74Q60 83 69 74" stroke="#34323D" stroke-width="3.2" stroke-linecap="round" fill="none"/>
    <path class="m m-cheer" d="M48 72Q60 94 72 72Z" fill="#34323D"/><path class="m m-cheer" d="M54 82Q60 78 66 82Q60 88 54 82Z" fill="#F6C8D6"/>
    <ellipse class="m m-think" cx="60" cy="78" rx="4" ry="5" fill="#34323D"/>
    <path class="m m-sleep" d="M52 78Q60 82 68 78" stroke="#34323D" stroke-width="3" stroke-linecap="round" fill="none"/>
    <g transform="rotate(24 100 86)"><rect x="96" y="66" width="7" height="34" rx="3.5" fill="#F8E9B1" stroke="#e5cf7d"/><path d="M96 66h7l-3.5-12z" fill="#F6C8D6"/></g>
    <g class="spark" fill="#F8E9B1" stroke="#e0c35a"><path d="M14 30l3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/><path d="M104 18l2 5 5 2-5 2-2 5-2-5-5-2 5-2z"/></g>
  </g></svg>`;
}

export function petals(root, n = 24, set = ['🌸', '🌷', '💮', '✨', '🌼']) {
  if (!root || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (let i = 0; i < n; i++) {
    const s = document.createElement('span'); s.className = 'petal'; s.textContent = set[i % set.length];
    s.style.left = `${Math.random() * 100}%`; s.style.setProperty('--dx', `${(Math.random() - 0.5) * 160}px`); s.style.setProperty('--rot', `${(Math.random() - 0.5) * 720}deg`);
    s.style.animationDelay = `${Math.random() * 0.6}s`; s.style.fontSize = `${16 + Math.random() * 16}px`;
    root.appendChild(s); setTimeout(() => s.remove(), 3400);
  }
}

export class Buddy {
  constructor({ mount, bubble, log }) {
    this.mount = mount; this.bubble = bubble; this.log = log; this.timer = null;
    mount.innerHTML = buddySvg(); this.svg = mount.querySelector('svg');
  }
  mood(m, ms = 0) { this.svg.dataset.mood = m; clearTimeout(this.timer); if (ms) this.timer = setTimeout(() => (this.svg.dataset.mood = 'happy'), ms); }
  /** kind: info | positive | constructive | tip. All text is set via textContent (model output is never trusted as HTML). */
  say(text, kind = 'info', { log = true, mood = null } = {}) {
    this.bubble.textContent = text; this.bubble.className = `bubble ${kind}`;
    if (mood) this.mood(mood, 2600); else if (kind === 'positive') this.mood('cheer', 1800);
    if (log && this.log) {
      const li = document.createElement('li'); li.className = kind; li.textContent = text;
      this.log.prepend(li); while (this.log.children.length > 30) this.log.lastChild.remove();
    }
  }
}

/** A little spin of happiness: a temporary Buddy twirls up from the bottom of the screen. */
export function happySpin(root = document.body) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const d = document.createElement('div'); d.className = 'buddy-spin'; d.innerHTML = buddySvg(); d.firstElementChild.dataset.mood = 'cheer';
  root.appendChild(d); setTimeout(() => d.remove(), 1700);
}
