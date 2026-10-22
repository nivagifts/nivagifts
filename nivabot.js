/* =========================================================
   NIVI — Mobile-friendly auth-modal robot
   - Scales down on small phones
   - Bubble spans full modal-card width below 400px
   - No clipping behind the keyboard
   - Errors always SAD (no angry face, no brackets)
   - ✅ Runs ONLY on NIVA's own pages — never on customer gift sites (/g/...)
   - NEW: Signup now asks for username too, with uniqueness check
   - NEW: Warm welcome messages on every login / signup
   ========================================================= */
(() => {
  "use strict";

  if (window.__NIVI_LOADED__) return;
  if (/^\/g\//.test(location.pathname)) return;

  window.__NIVI_LOADED__ = true;

  /* =======================================================
     1. PAGE DETECTION
     ======================================================= */
  const PAGE = (() => {
    const p = location.pathname;
    if (p.includes("editor")) return "editor";
    if (p.includes("my-gifts")) return "my-gifts";
    if (p.includes("privacy")) return "privacy";
    return "home";
  })();

  const PAGE_HINTS = {
    home: "You're on the NIVA home page — ask me anything about gifts, pricing or signing up.",
    editor: "You're in the gift editor — ask 'How to save a draft?' or 'How to publish?'.",
    "my-gifts": "You're in My Gifts — ask 'What is a draft?' or 'How to delete a gift?'.",
    privacy: "You're on Privacy & Safety — ask 'Is my data safe?'.",
  };

  /* =======================================================
     2. KNOWLEDGE BASE
     ======================================================= */
  const KB = [
    { id: "about", tag: "About",
      keywords: ["what is niva","about niva","about","explain niva","what is this","what do you do"],
      answer: "**NIVA** is a place to create beautiful personalised digital gifts — love letters, proposals, birthday surprises and more.\n\nYou pick a template, add your own words, photos and music, then share a **private password-protected link** with someone special. ✦",
      next: ["Pricing?","How to create a gift?","Is it private?"] },
    { id: "pricing", tag: "Pricing",
      keywords: ["price","pricing","cost","how much","rate","fees","₹","rupee","plan","plans"],
      answer: "Our gifts:\n• **Special Letter** — ₹39\n• **Essential** — ₹99\n• **Signature** — ₹299\n• **Evermore** — ₹599\n\nYou only pay when you publish — drafting and previewing is always free. 💕",
      next: ["What is the Love Letter?","How to create a gift?","Templates"] },
    { id: "special-letter", tag: "Love Letter",
      keywords: ["special letter","love letter","loveletter","39","letter only","single letter","cheap","cheapest"],
      answer: "The **Love Letter** is our sweetest little gift at just ₹39 💌\n\nTwo handwritten-style love letter pages, sealed with a beautiful envelope-opening animation. You'll find it in the templates grid.",
      next: ["Pricing?","How to create a gift?"] },
    { id: "templates", tag: "Templates",
      keywords: ["template","templates","design","designs","theme","options","what can i make","kinds","types"],
      answer: "We have several templates:\n✦ **Eternal Love** (₹599)\n✦ **Love Proposal** (₹599)\n✦ **Birthday Magic** (₹299)\n✦ **Love Letter** (₹39)\n✦ **Eternal Anniversary** (₹599)",
      next: ["Pricing?","How to create a gift?"] },
    { id: "howto", tag: "How to create",
      keywords: ["how to create","how do i make","make a gift","create gift","start","begin","steps","how does it work"],
      answer: "Making a gift is easy:\n\n1. Pick a template\n2. Sign up with a **username + email** — I can help right here\n3. Fill in your words & photos — live preview updates as you type\n4. Set a **gift password** and pay\n5. Share the private link ♥",
      next: ["Sign up","Pricing?","Is it private?"] },
    { id: "privacy", tag: "Privacy",
      keywords: ["password","private","secure","encrypt","security","safe","is it private","data"],
      answer: "Your gift is **encrypted in your browser** with AES-256-GCM before it ever reaches our server. 🔒\n\n• PBKDF2 key derivation (310,000 iterations)\n• Only ciphertext + metadata is stored\n• Recipient needs the password you set\n• We never see your gift content",
      next: ["How does the recipient open it?","Sign up"] },
    { id: "payment", tag: "Payment",
      keywords: ["payment","pay","razorpay","upi","card","how to pay","checkout","billing"],
      answer: "Payments are handled securely by **Razorpay** — UPI, cards, netbanking.\n\nYou only pay once, at the moment you publish a gift.",
      next: ["Refunds?","Sign up"] },
    { id: "account", tag: "Account",
      keywords: ["account","sign up","signup","register","login","sign in","email verify","otp","password reset","forgot password","username"],
      answer: "I can help you sign in or sign up right here! ♥\n\nJust say:\n• **sign up** — to create a new account (choose a username!)\n• **sign in** — to log in\n• **forgot password** — to reset",
      next: ["Sign up","Sign in","Forgot password"] },
    { id: "mygifts", tag: "My Gifts",
      keywords: ["my gifts","my gifts page","drafts","wishlist","saved","saved gifts","account page"],
      answer: "Head to **My Gifts** from the home page. You'll find three tabs:\n• **Drafts** — works in progress\n• **Published** — finished gifts + shareable links\n• **Wishlist** — templates you've hearted ♥",
      next: ["Delete a gift?","What is a draft?"] },
    { id: "draft", tag: "Drafts",
      keywords: ["draft","drafts","save","autosave","unsaved","work in progress"],
      answer: "Drafts autosave to your browser as you type, and to your account within a couple of seconds. Hit **Save Draft** any time to force a cloud save.",
      next: ["My Gifts?","How to create a gift?"] },
    { id: "delete", tag: "Delete",
      keywords: ["delete","remove","unpublish","stop link","take down","erase"],
      answer: "Go to **My Gifts → Published** and tap Delete on any gift. The private link stops working immediately.",
      next: ["Refunds?","My Gifts?"] },
    { id: "upload", tag: "Uploads",
      keywords: ["photos","images","upload","pictures","how many","size","limit","video","audio","music","gb","mb"],
      answer: "You can upload photos, video and audio — up to **1 GB total** per gift.\n• Photos: 800 MB each\n• Videos: 800 MB\n• Audio: 200 MB",
      next: ["How to create a gift?","Is it private?"] },
    { id: "refund", tag: "Refunds",
      keywords: ["refund","cancel","return","money back","chargeback"],
      answer: "Gifts are digital and shareable, so we don't offer refunds **after** publishing. If something fails before publishing, you won't be charged.",
      next: ["Payment?","Contact support?"] },
    { id: "contact", tag: "Contact",
      keywords: ["contact","support","help","email you","reach you","talk to someone"],
      answer: "Reach us through the **Privacy & Safety** page. Until then, I (NIVI!) can answer most questions. Just ask! 💕",
      next: ["Pricing?","Sign up"] },
    { id: "recipient", tag: "Recipient",
      keywords: ["recipient","open gift","receive","someone sent","unlock","unlock gift"],
      answer: "Your recipient opens the private link, enters the **gift password** you gave them, and the gift unlocks in their browser. ✦",
      next: ["Is it private?","Password?"] },
    { id: "editor", tag: "Editor",
      keywords: ["editor","edit","live preview","preview","customise","customize","how does the editor"],
      answer: "The editor is where your gift comes alive.\n\n• Left side: your words, photos, music\n• Right side: **live preview** updating as you type\n• Top right: Save Draft\n• Bottom: set gift password & publish",
      next: ["How to create a gift?","Save draft"] },
  ];

  const INTENTS = [
    { id: "greeting",
      keywords: ["hello","hi","hey","namaste","vanakkam","sup","yo","hola"],
      answer: () => pick([
        "Hi there! ♥ I'm **NIVI** — NIVA's little robot guide.",
        "Hello! ✦ Ask about gifts, pricing, or say **sign up** / **sign in**.",
        "Hey! 💗 I can help with templates, pricing, or signing in.",
      ]),
      next: ["What is NIVA?","Pricing?","Sign up","Sign in"] },
    { id: "thanks",
      keywords: ["thank","thanks","thx","ty","appreciate"],
      answer: () => pick(["Anytime! ♥ ✦","You're welcome! ✦","Happy to help! 💕"]),
      next: ["How to create a gift?","Pricing?"] },
    { id: "bye",
      keywords: ["bye","goodbye","see you","later","cya"],
      answer: () => pick(["Goodbye! ♥ ✦","See you soon! 💕","Bye! ✦"]),
      next: ["What is NIVA?"] },
    { id: "whoami",
      keywords: ["who are you","your name","whats your name","what is your name","are you real","nivi"],
      answer: () => "I'm **NIVI** — NIVA's little robot guide. ✦\n\nI can help you understand NIVA, or even sign you in / sign you up. Just ask! 💗",
      next: ["Sign up","Sign in","What is NIVA?"] },
  ];

  const AUTH_INTENTS = [
    { id: "signup",  keywords: ["sign up","signup","register","create account","new account","make account"] },
    { id: "signin",  keywords: ["sign in","signin","login","log in","my account","enter account"] },
    { id: "forgot",  keywords: ["forgot password","reset password","password reset","can't log in","cannot log in"] },
  ];

  const FALLBACKS = [
    "I'm not sure I got that. Try **pricing**, **templates**, **privacy**, or say **sign up** / **sign in**. ♡",
    "Hmm, beyond what I know. Try 'how much does it cost?' or 'sign in'.",
    "I'd love to help — what would you like to know?",
  ];

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  /* =======================================================
     3. FUZZY MATCHING
     ======================================================= */
  function lev(a, b) {
    a = a || ""; b = b || "";
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const m = a.length, n = b.length;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }
  function fuzzyIncludes(haystack, needle) {
    if (!needle) return false;
    if (haystack.includes(needle)) return true;
    if (needle.length < 4) return false;
    const maxDist = needle.length <= 5 ? 1 : 2;
    for (const token of haystack.split(/\s+/)) {
      if (Math.abs(token.length - needle.length) > maxDist) continue;
      if (lev(token, needle) <= maxDist) return true;
    }
    return false;
  }
  function scoreEntry(q, entry) {
    let best = 0;
    for (const kw of entry.keywords) {
      if (!kw) continue;
      if (q === kw) best = Math.max(best, 100 + kw.length);
      else if (q.includes(kw)) best = Math.max(best, 60 + kw.length);
      else if (fuzzyIncludes(q, kw)) best = Math.max(best, 25 + kw.length);
    }
    return best;
  }
  function rankMatches(q) {
    q = String(q || "").toLowerCase().trim();
    if (!q) return [];
    const scored = KB.map(e => ({ entry: e, score: scoreEntry(q, e) }))
      .filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    if (!scored.length) return [];
    const top = scored[0].score;
    return scored.filter(x => x.score >= top * 0.7).slice(0, 2);
  }
  function matchIntent(q) {
    q = String(q || "").toLowerCase().trim();
    if (!q) return null;
    for (const intent of INTENTS) {
      for (const kw of intent.keywords) {
        if (q === kw || q.startsWith(kw + " ") || q.endsWith(" " + kw) || q.includes(kw)) return intent;
      }
    }
    return null;
  }
  function matchAuthIntent(q) {
    q = String(q || "").toLowerCase().trim();
    if (!q) return null;
    for (const a of AUTH_INTENTS) {
      for (const kw of a.keywords) {
        if (q === kw || q.startsWith(kw + " ") || q.endsWith(" " + kw) || q.includes(kw)) return a;
      }
    }
    return null;
  }

  /* =======================================================
     4. STATE
     ======================================================= */
  const state = {
    lastTopicId: null,
    busy: false,
    history: [],
    authFlow: null,
    authData: {},
    user: null,
    loginFailCount: 0,
    usernameCheckTimer: null,
    usernameAvailable: false,
    usernameChecked: false,
  };

  /* =======================================================
     5. RICH TEXT
     ======================================================= */
  function renderRich(text) {
    let safe = String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    safe = safe.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    safe = safe.replace(/\n/g, "<br>");
    safe = safe.replace(/^•\s/gm, '<span class="nivi-bullet">•</span> ');
    safe = safe.replace(/<br>•\s/g, '<br><span class="nivi-bullet">•</span> ');
    return safe;
  }

  /* =======================================================
     6. SERVER FALLBACK
     ======================================================= */
  let serverAvailable = true;
  async function askServer(message) {
    if (!serverAvailable) return null;
    try {
      const res = await fetch("/api/niva-bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ message }),
      });
      if (res.status === 404 || res.status === 405) { serverAvailable = false; return null; }
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      return (data && data.success && typeof data.reply === "string") ? data.reply : null;
    } catch { serverAvailable = false; return null; }
  }

  /* =======================================================
     7. STYLES — SAD ONLY + MOBILE FRIENDLY
     ======================================================= */
  const style = document.createElement("style");
  style.textContent = `
    .niva-bot-root {
      --nivi-pink: #ff8fbd;
      --nivi-purple: #b69aff;
      --nivi-ink: #21172d;
      position: fixed; z-index: 9000;
      right: 20px; bottom: calc(18px + env(safe-area-inset-bottom));
      font-family: 'DM Sans', system-ui, sans-serif;
      color: var(--nivi-ink);
      transition: opacity .3s;
    }
    .niva-bot-root.hidden-for-modal {
      opacity: 0; pointer-events: none; visibility: hidden;
    }
    .niva-bot-fab {
      width: 82px; height: 94px; position: relative;
      display: grid; place-items: center; padding: 0;
      border: 0; background: transparent; cursor: pointer;
      isolation: isolate; -webkit-tap-highlight-color: transparent;
      animation: niviFloat 3.2s ease-in-out infinite;
      filter: drop-shadow(0 9px 17px rgba(174,112,255,.25));
      transition: filter .25s, transform .25s;
    }
    .niva-bot-fab:hover { filter: drop-shadow(0 12px 23px rgba(255,126,190,.42)); transform: translateY(-4px); }
    .niva-bot-fab:focus-visible { outline: 2px solid #ff8fbd; outline-offset: 5px; border-radius: 30px; }
    @keyframes niviFloat { 0%,100%{translate:0 0;} 50%{translate:0 -7px;} }
    .nivi-character {
      position: relative; width: 68px; height: 73px;
      display: block; transform-origin: 50% 85%;
      transition: transform .25s;
    }
    .niva-bot-fab:hover .nivi-character { transform: rotate(-5deg) scale(1.04); }
    .nivi-antenna {
      position: absolute; z-index: 1; width: 3px; height: 12px;
      top: -5px; left: 33px; border-radius: 8px;
      background: linear-gradient(#d8c4ff, #a58bff);
    }
    .nivi-antenna::before {
      content: ""; position: absolute; width: 10px; height: 10px;
      top: -7px; left: -3.5px; border-radius: 50%;
      background: radial-gradient(circle at 35% 30%, #fff, #ffb4da 38%, #bd8cff 85%);
      box-shadow: 0 0 12px rgba(255,143,189,.85);
      animation: niviAntennaGlow 2s ease-in-out infinite;
    }
    @keyframes niviAntennaGlow {
      0%,100%{box-shadow:0 0 8px rgba(255,143,189,.55);}
      50%{box-shadow:0 0 18px rgba(182,154,255,.95);}
    }
    .nivi-head {
      position: absolute; top: 7px; left: 4px;
      width: 60px; height: 51px;
      border: 1px solid rgba(255,255,255,.95);
      border-radius: 21px 21px 18px 18px;
      background: linear-gradient(145deg, rgba(255,255,255,.98), rgba(247,235,255,.96) 60%, rgba(255,223,239,.98));
      box-shadow: inset 0 3px 6px rgba(255,255,255,.95), inset 0 -4px 8px rgba(190,155,255,.13), 0 5px 12px rgba(153,112,211,.17);
    }
    .nivi-head::before {
      content: ""; position: absolute; left: 12px; top: 4px;
      width: 21px; height: 5px; border-radius: 50%;
      background: rgba(255,255,255,.9); filter: blur(1px);
    }
    .nivi-ear {
      position: absolute; top: 24px; width: 7px; height: 17px;
      border-radius: 5px; background: linear-gradient(#d9c7ff, #b18dff);
      box-shadow: 0 2px 5px rgba(151,116,224,.2);
    }
    .nivi-ear.left { left: 0; }
    .nivi-ear.right { right: 0; }
    .nivi-ear::after {
      content: ""; position: absolute; left: 2px; top: 5px;
      width: 3px; height: 6px; border-radius: 3px; background: rgba(255,255,255,.85);
    }
    .nivi-face {
      position: absolute; inset: 9px 7px 7px; overflow: hidden;
      border-radius: 15px;
      background: linear-gradient(145deg, #332746, #20182f 70%, #3d2850);
      box-shadow: inset 0 1px 3px rgba(255,255,255,.16), 0 0 9px rgba(187,143,255,.12);
    }
    .nivi-eye {
      position: absolute; top: 13px; width: 8px; height: 10px;
      border-radius: 50%; background: #ffa9d0;
      box-shadow: 0 0 8px rgba(255,143,189,.7);
      animation: niviBlink 5s infinite; transform-origin: center;
    }
    .nivi-eye.left { left: 9px; }
    .nivi-eye.right { right: 9px; }
    @keyframes niviBlink { 0%,44%,48%,86%,90%,100%{transform:scaleY(1);} 46%,88%{transform:scaleY(.12);} }
    .nivi-eye::after {
      content: ""; position: absolute; top: 1px; left: 2px;
      width: 2px; height: 3px; border-radius: 50%; background: #fff;
    }
    .nivi-blush {
      position: absolute; top: 26px; width: 8px; height: 4px;
      border-radius: 50%; background: #ff82ba; opacity: .72; filter: blur(.5px);
    }
    .nivi-blush.left { left: 3px; }
    .nivi-blush.right { right: 3px; }
    .nivi-smile {
      position: absolute; top: 26px; left: 50%;
      width: 9px; height: 5px;
      border-bottom: 2px solid #ffb5d7;
      border-radius: 0 0 10px 10px;
      transform: translateX(-50%);
    }
    .nivi-body {
      position: absolute; bottom: 0; left: 22px;
      width: 24px; height: 13px;
      border-radius: 6px 6px 9px 9px;
      background: linear-gradient(145deg, #fff, #e8d9ff);
      border: 1px solid rgba(255,255,255,.95);
      box-shadow: 0 3px 7px rgba(154,116,222,.18);
    }
    .nivi-heart {
      position: absolute; top: 2px; left: 8px;
      font-size: 8px; line-height: 1; color: #ff83b8;
      animation: niviHeartBeat 1.7s ease-in-out infinite;
    }
    @keyframes niviHeartBeat {
      0%,100%{transform:scale(1);} 15%{transform:scale(1.25);} 30%{transform:scale(1);} 45%{transform:scale(1.18);}
    }
    .nivi-arm {
      position: absolute; z-index: -1; top: 49px;
      width: 8px; height: 14px; border-radius: 8px;
      background: linear-gradient(#fdf8ff, #d9c5ff);
      border: 1px solid rgba(255,255,255,.8);
      transform-origin: top center;
    }
    .nivi-arm.left { left: 12px; transform: rotate(22deg); }
    .nivi-arm.right { right: 12px; transform: rotate(-22deg); }
    .niva-bot-fab:hover .nivi-arm.right { animation: niviWave .5s ease-in-out 3; }
    @keyframes niviWave { 0%,100%{transform:rotate(-22deg);} 50%{transform:rotate(-65deg);} }
    .nivi-spark {
      position: absolute; z-index: -1; color: #ff8fbd;
      pointer-events: none; animation: niviSparkle 2.7s ease-in-out infinite;
    }
    .nivi-spark.one { top: 5px; right: 0; font-size: 13px; }
    .nivi-spark.two { bottom: 17px; left: 0; font-size: 10px; animation-delay: .8s; }
    @keyframes niviSparkle {
      0%,100%{opacity:.35; transform:translateY(2px) scale(.8);}
      50%{opacity:1; transform:translateY(-5px) scale(1.15);}
    }
    .nivi-badge {
      position: absolute; right: 73px; bottom: 27px;
      padding: 8px 11px;
      border: 1px solid rgba(255,255,255,.85);
      border-radius: 13px 13px 3px 13px;
      background: rgba(255,250,255,.96); color: #79568d;
      box-shadow: 0 5px 18px rgba(104,71,145,.12);
      font-size: 11px; font-weight: 700; white-space: nowrap;
      pointer-events: none; animation: niviBadgeIn .6s ease both;
    }
    @keyframes niviBadgeIn {
      from{opacity:0; transform:translateX(7px) scale(.94);}
      to{opacity:1; transform:translateX(0) scale(1);}
    }
    .niva-bot-root.chat-open .nivi-badge { display: none; }
    .niva-bot-panel {
      position: absolute; right: 0; bottom: 105px;
      width: min(370px, calc(100vw - 28px));
      height: min(550px, calc(100dvh - 145px)); min-height: 320px;
      display: flex; flex-direction: column;
      overflow: hidden;
      border: 1px solid rgba(222,201,255,.8);
      border-radius: 24px; background: #fffaff;
      box-shadow: 0 25px 80px rgba(38,20,55,.22), 0 0 0 5px rgba(202,174,255,.08);
      transform-origin: bottom right;
      transform: translateY(12px) scale(.92);
      opacity: 0; visibility: hidden; pointer-events: none;
      transition: transform .28s cubic-bezier(.2,.8,.2,1), opacity .2s, visibility .2s;
    }
    .niva-bot-panel.open { transform: translateY(0) scale(1); opacity: 1; visibility: visible; pointer-events: auto; }
    .niva-bot-head {
      position: relative;
      display: flex; align-items: center; gap: 11px;
      padding: 14px 15px; flex-shrink: 0;
      background: radial-gradient(ellipse at 0 0, rgba(255,255,255,.8), transparent 55%),
                  linear-gradient(120deg, #f5eaff, #ffeaf5 60%, #fff6fc);
      border-bottom: 1px solid #f0e2fa;
    }
    .nivi-mini {
      position: relative; width: 43px; height: 43px; flex-shrink: 0;
      border: 1px solid rgba(255,255,255,.9);
      border-radius: 15px;
      background: linear-gradient(145deg, #fff, #f3e6ff);
      box-shadow: 0 3px 12px rgba(157,116,215,.13);
    }
    .nivi-mini-antenna {
      position: absolute; top: 3px; left: 20px;
      width: 3px; height: 6px; border-radius: 4px; background: #b69aff;
    }
    .nivi-mini-antenna::after {
      content: ""; position: absolute; top: -4px; left: -2px;
      width: 7px; height: 7px; border-radius: 50%; background: #ff8fbd;
    }
    .nivi-mini-head {
      position: absolute; top: 10px; left: 5px;
      width: 31px; height: 25px; border-radius: 10px;
      background: linear-gradient(145deg, #f7efff, #ffe5f1);
      border: 1px solid white;
    }
    .nivi-mini-face { position: absolute; inset: 4px; border-radius: 6px; background: #2c203d; }
    .nivi-mini-face::before, .nivi-mini-face::after {
      content: ""; position: absolute; top: 6px;
      width: 4px; height: 5px; border-radius: 50%; background: #ffa9d0;
    }
    .nivi-mini-face::before { left: 5px; }
    .nivi-mini-face::after { right: 5px; }
    .nivi-mini-smile {
      position: absolute; left: 50%; bottom: 3px;
      width: 5px; height: 3px;
      border-bottom: 1px solid #ffb5d7;
      border-radius: 0 0 5px 5px; transform: translateX(-50%);
    }
    .niva-bot-title { display: flex; flex-direction: column; flex: 1; min-width: 0; gap: 3px; }
    .niva-bot-title b {
      font-family: 'Playfair Display', Georgia, serif;
      color: #352341; font-size: 17px; font-weight: 700;
    }
    .niva-bot-title span {
      color: #9a70b8; font-size: 10px; letter-spacing: .11em;
      font-weight: 700; text-transform: uppercase;
    }
    .nivi-status {
      display: inline-flex; align-items: center; gap: 5px;
      color: #7a6590; font-size: 10px; margin-top: 2px;
    }
    .nivi-status::before {
      content: ""; width: 6px; height: 6px; border-radius: 50%;
      background: #68cf9a; box-shadow: 0 0 6px rgba(104,207,154,.45);
    }
    .niva-bot-close {
      width: 31px; height: 31px; flex-shrink: 0;
      display: grid; place-items: center;
      border: 1px solid rgba(190,157,218,.2);
      border-radius: 10px; background: rgba(255,255,255,.6);
      color: #80668f; cursor: pointer; font-size: 21px; line-height: 1;
      transition: background .2s, transform .2s;
    }
    .niva-bot-close:hover { background: #fff; transform: rotate(90deg); }
    .niva-bot-body {
      flex: 1; min-height: 0; overflow-y: auto;
      overscroll-behavior: contain;
      padding: 16px 13px;
      display: flex; flex-direction: column;
      align-items: flex-start; gap: 11px;
      background: radial-gradient(ellipse at 100% 0%, rgba(244,225,255,.28), transparent 50%), #fffaff;
      scroll-behavior: smooth;
    }
    .niva-bot-body::-webkit-scrollbar { width: 4px; }
    .niva-bot-body::-webkit-scrollbar-thumb { border-radius: 8px; background: #dfc9f1; }
    .niva-bot-msg {
      max-width: 87%; padding: 11px 13px;
      border-radius: 16px; font-size: 12.5px; line-height: 1.65;
      overflow-wrap: anywhere; animation: niviMessageIn .25s ease both;
    }
    @keyframes niviMessageIn {
      from{opacity:0; transform:translateY(6px);}
      to{opacity:1; transform:translateY(0);}
    }
    .niva-bot-msg.bot {
      align-self: flex-start; color: #43334e; border: 1px solid #f0e3fa;
      border-bottom-left-radius: 5px;
      background: linear-gradient(135deg, #f8efff, #fff1f8);
    }
    .niva-bot-msg.user {
      align-self: flex-end; color: white; border-bottom-right-radius: 5px;
      background: linear-gradient(120deg, #a887ec, #e58ab8);
      box-shadow: 0 3px 9px rgba(181,130,211,.13);
    }
    .niva-bot-msg.typing {
      display: flex; align-items: center; gap: 5px;
      min-width: 52px; padding: 13px 15px;
    }
    .niva-bot-msg.typing i {
      width: 6px; height: 6px; border-radius: 50%;
      background: #b69aff; animation: niviDots 1.1s infinite;
    }
    .niva-bot-msg.typing i:nth-child(2) { animation-delay: .16s; }
    .niva-bot-msg.typing i:nth-child(3) { animation-delay: .32s; }
    @keyframes niviDots {
      0%,60%,100%{opacity:.35; transform:translateY(0);}
      30%{opacity:1; transform:translateY(-4px);}
    }
    .niva-bot-msg strong { color: #2c1f39; font-weight: 700; }
    .niva-bot-msg.user strong { color: #fff; }
    .nivi-bullet { color: #b69aff; font-weight: 700; }
    .niva-bot-quick {
      display: flex; flex-wrap: wrap; gap: 7px;
      padding: 0 13px 12px; flex-shrink: 0;
      background: #fffaff;
    }
    .niva-bot-quick button {
      padding: 7px 10px;
      border: 1px solid #e6d2f5; border-radius: 999px;
      background: #fff; color: #8d65ad;
      font-family: inherit; font-size: 10.5px; font-weight: 600;
      cursor: pointer;
      transition: background .2s, border-color .2s, transform .2s;
    }
    .niva-bot-quick button:hover { background: #f8edff; border-color: #c5a5e8; transform: translateY(-1px); }
    .niva-bot-quick button:disabled { opacity: .5; cursor: wait; }
    .niva-bot-input {
      display: flex; align-items: center; gap: 8px;
      padding: 11px 12px; flex-shrink: 0;
      border-top: 1px solid #f0e5f7;
      background: rgba(255,255,255,.96);
    }
    .niva-bot-input input {
      flex: 1; min-width: 0; height: 40px;
      padding: 0 14px;
      border: 1px solid #eadcf5; border-radius: 999px;
      outline: none; background: #fdf9ff; color: #392a46;
      font-family: inherit; font-size: 12px;
      transition: border-color .2s, box-shadow .2s;
    }
    .niva-bot-input input::placeholder { color: #ac9bb8; }
    .niva-bot-input input:focus { border-color: #bd9be9; box-shadow: 0 0 0 3px rgba(182,154,255,.13); }
    .niva-bot-input button {
      width: 40px; height: 40px; flex-shrink: 0;
      display: grid; place-items: center;
      border: 0; border-radius: 50%;
      background: linear-gradient(135deg, #b49aff, #ee91c2);
      color: white; font-size: 17px; cursor: pointer;
      box-shadow: 0 4px 10px rgba(183,139,222,.23);
      transition: transform .2s, box-shadow .2s;
    }
    .niva-bot-input button:hover { transform: scale(1.06); box-shadow: 0 5px 14px rgba(183,139,222,.35); }
    .niva-bot-input button:active { transform: scale(.94); }
    .niva-bot-input button:disabled { opacity: .55; cursor: wait; }
    @media (max-width: 480px) {
      .niva-bot-root { right: 12px; bottom: calc(12px + env(safe-area-inset-bottom)); }
      .niva-bot-fab { width: 72px; height: 82px; }
      .nivi-character { transform: scale(.91); }
      .niva-bot-panel {
        position: fixed; right: 10px;
        bottom: calc(90px + env(safe-area-inset-bottom));
        width: calc(100vw - 20px);
        height: min(520px, calc(100dvh - 125px - env(safe-area-inset-bottom)));
        min-height: 280px; border-radius: 22px;
      }
      .nivi-badge { right: 65px; bottom: 22px; font-size: 10px; }
    }
    @media (max-width: 350px) {
      .niva-bot-quick button { font-size: 10px; padding: 6px 8px; }
      .niva-bot-msg { font-size: 12px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .niva-bot-root *, .niva-bot-root *::before, .niva-bot-root *::after {
        animation-duration: .01ms !important;
        animation-iteration-count: 1 !important;
        scroll-behavior: auto !important;
        transition-duration: .01ms !important;
      }
    }

    /* MODAL ROBOT */
    .nivi-modal-root {
      position: relative;
      margin: 14px auto 4px;
      z-index: 5;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      pointer-events: none;
      width: 100%;
      max-width: 100%;
      font-family: 'DM Sans', system-ui, sans-serif;
    }
    .nivi-modal-root .nivi-modal-robot {
      pointer-events: auto;
      width: 64px; height: 72px;
      position: relative;
      transform-origin: bottom center;
      animation: niviModalFloat 3s ease-in-out infinite;
      filter: drop-shadow(0 6px 14px rgba(151,116,224,.28));
      flex-shrink: 0;
    }
    @keyframes niviModalFloat {
      0%,100% { transform: translateY(0); }
      50% { transform: translateY(-4px); }
    }
    .nivi-modal-root .nivi-modal-robot.happy .nivi-modal-mouth {
      width: 12px; height: 7px;
      border-bottom: 2.5px solid #ffb5d7;
      border-radius: 0 0 10px 10px;
    }
    .nivi-modal-root .nivi-modal-robot.happy .nivi-modal-eye {
      background: #ffb8dd;
      box-shadow: 0 0 12px rgba(255,143,189,.9);
    }
    .nivi-modal-root .nivi-modal-robot.sad .nivi-modal-eye {
      background: #c9a0ff;
      box-shadow: 0 0 10px rgba(201,160,255,.75);
      height: 8px;
    }
    .nivi-modal-root .nivi-modal-robot.sad .nivi-modal-mouth {
      width: 10px; height: 5px;
      border-top: 2px solid #d9b8ff; border-bottom: 0;
      border-radius: 8px 8px 0 0; top: 26px;
    }
    .nivi-modal-antenna {
      position: absolute; z-index: 1; width: 3px; height: 10px;
      top: -3px; left: 30px; border-radius: 8px;
      background: linear-gradient(#d8c4ff, #a58bff);
    }
    .nivi-modal-antenna::before {
      content: ""; position: absolute; width: 8px; height: 8px;
      top: -6px; left: -2.5px; border-radius: 50%;
      background: radial-gradient(circle at 35% 30%, #fff, #ffb4da 38%, #bd8cff 85%);
      box-shadow: 0 0 10px rgba(255,143,189,.85);
      animation: niviAntennaGlow 2s ease-in-out infinite;
    }
    .nivi-modal-head {
      position: absolute; top: 6px; left: 4px;
      width: 56px; height: 48px;
      border: 1px solid rgba(255,255,255,.95);
      border-radius: 20px 20px 17px 17px;
      background: linear-gradient(145deg, rgba(255,255,255,.98), rgba(247,235,255,.96) 60%, rgba(255,223,239,.98));
      box-shadow: inset 0 3px 6px rgba(255,255,255,.95), inset 0 -4px 8px rgba(190,155,255,.13), 0 4px 10px rgba(153,112,211,.17);
    }
    .nivi-modal-ear {
      position: absolute; top: 22px; width: 7px; height: 16px;
      border-radius: 5px; background: linear-gradient(#d9c7ff, #b18dff);
      box-shadow: 0 2px 5px rgba(151,116,224,.2);
    }
    .nivi-modal-ear.left { left: 0; }
    .nivi-modal-ear.right { right: 0; }
    .nivi-modal-face {
      position: absolute; inset: 8px 6px 6px; overflow: hidden;
      border-radius: 14px;
      background: linear-gradient(145deg, #332746, #20182f 70%, #3d2850);
      box-shadow: inset 0 1px 3px rgba(255,255,255,.16), 0 0 9px rgba(187,143,255,.12);
    }
    .nivi-modal-eye {
      position: absolute; top: 12px; width: 8px; height: 10px;
      border-radius: 50%; background: #ffa9d0;
      box-shadow: 0 0 8px rgba(255,143,189,.7);
      animation: niviBlink 5s infinite; transform-origin: center;
      transition: height .25s, background .25s, box-shadow .25s;
    }
    .nivi-modal-eye.left { left: 8px; }
    .nivi-modal-eye.right { right: 8px; }
    .nivi-modal-mouth {
      position: absolute; top: 25px; left: 50%;
      width: 9px; height: 5px;
      border-bottom: 2px solid #ffb5d7;
      border-radius: 0 0 10px 10px;
      transform: translateX(-50%);
      transition: all .25s;
    }
    .nivi-modal-body {
      position: absolute; bottom: 0; left: 20px;
      width: 22px; height: 12px;
      border-radius: 6px 6px 9px 9px;
      background: linear-gradient(145deg, #fff, #e8d9ff);
      border: 1px solid rgba(255,255,255,.95);
      box-shadow: 0 3px 7px rgba(154,116,222,.18);
    }
    .nivi-modal-heart {
      position: absolute; top: 2px; left: 7px;
      font-size: 7px; line-height: 1; color: #ff83b8;
      animation: niviHeartBeat 1.7s ease-in-out infinite;
    }
    .nivi-modal-arm {
      position: absolute; z-index: -1; top: 45px;
      width: 7px; height: 13px; border-radius: 8px;
      background: linear-gradient(#fdf8ff, #d9c5ff);
      border: 1px solid rgba(255,255,255,.8);
      transform-origin: top center;
    }
    .nivi-modal-arm.left { left: 10px; transform: rotate(22deg); }
    .nivi-modal-arm.right { right: 10px; transform: rotate(-22deg); }
    .nivi-modal-bubble {
      pointer-events: auto;
      background: #fffaff;
      border: 1px solid #e8c4c8;
      border-radius: 14px 14px 4px 14px;
      padding: 10px 12px;
      font-size: 12px;
      line-height: 1.55;
      color: #43334e;
      box-shadow: 0 6px 22px rgba(104,71,145,.15);
      max-width: 100%;
      width: 100%;
      text-align: center;
      position: relative;
      animation: niviBubbleIn .3s ease both;
      transition: background .25s, border-color .25s;
      overflow-wrap: anywhere;
      word-break: break-word;
      box-sizing: border-box;
    }
    @keyframes niviBubbleIn {
      from { opacity: 0; transform: translateY(4px) scale(.96); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .nivi-modal-bubble::after {
      content: ""; position: absolute; top: -6px; left: 50%;
      transform: translateX(-50%) rotate(45deg);
      width: 12px; height: 12px;
      background: #fffaff;
      border-left: 1px solid #e8c4c8;
      border-top: 1px solid #e8c4c8;
      border-radius: 3px 0 0 0;
    }
    .nivi-modal-bubble strong { color: #2c1f39; font-weight: 700; }
    .nivi-modal-bubble .nivi-modal-emotion {
      display: inline-block; margin-right: 4px;
    }
    .nivi-modal-bubble.happy { background: #f3fff7; border-color: #b5e6c6; }
    .nivi-modal-bubble.happy::after {
      background: #f3fff7;
      border-left-color: #b5e6c6;
      border-top-color: #b5e6c6;
    }
    .nivi-modal-bubble.sad { background: #f7f2ff; border-color: #d9c7f0; }
    .nivi-modal-bubble.sad::after {
      background: #f7f2ff;
      border-left-color: #d9c7f0;
      border-top-color: #d9c7f0;
    }
    .nivi-modal-bubble .nivi-forgot-btn {
      display: inline-block; margin-top: 8px;
      padding: 6px 12px; border-radius: 999px;
      border: 1px solid #d9c7f0;
      background: #fff; color: #b76e79;
      font-size: 11px; font-weight: 700;
      cursor: pointer;
      transition: background .2s, transform .15s;
    }
    .nivi-modal-bubble .nivi-forgot-btn:hover {
      background: #f5eeff; transform: translateY(-1px);
    }
    @media (max-width: 640px) {
      .nivi-modal-root { margin: 12px auto 2px; gap: 6px; }
      .nivi-modal-root .nivi-modal-robot { width: 58px; height: 66px; }
      .nivi-modal-bubble { font-size: 12px; padding: 9px 11px; }
    }
    @media (max-width: 520px) {
      .nivi-modal-root { margin: 10px auto 2px; gap: 6px; }
      .nivi-modal-root .nivi-modal-robot { width: 52px; height: 58px; }
      .nivi-modal-antenna { left: 24px; }
      .nivi-modal-head { top: 4px; left: 3px; width: 46px; height: 40px; border-radius: 16px 16px 14px 14px; }
      .nivi-modal-face { inset: 6px 5px 5px; }
      .nivi-modal-eye { top: 9px; width: 6px; height: 8px; }
      .nivi-modal-eye.left { left: 7px; }
      .nivi-modal-eye.right { right: 7px; }
      .nivi-modal-mouth { top: 20px; width: 8px; height: 4px; }
      .nivi-modal-ear { top: 18px; height: 13px; }
      .nivi-modal-body { left: 16px; width: 18px; height: 10px; }
      .nivi-modal-arm { top: 38px; height: 11px; }
      .nivi-modal-arm.left { left: 8px; }
      .nivi-modal-arm.right { right: 8px; }
      .nivi-modal-bubble { font-size: 11.5px; padding: 8px 10px; }
    }
    @media (max-width: 400px) {
      .nivi-modal-root { margin: 8px auto 2px; gap: 5px; }
      .nivi-modal-root .nivi-modal-robot { width: 46px; height: 52px; }
      .nivi-modal-antenna { left: 21px; height: 8px; top: -2px; }
      .nivi-modal-head { top: 3px; left: 3px; width: 40px; height: 35px; border-radius: 14px 14px 12px 12px; }
      .nivi-modal-face { inset: 5px 4px 4px; border-radius: 11px; }
      .nivi-modal-eye { top: 8px; width: 5px; height: 7px; }
      .nivi-modal-eye.left { left: 6px; }
      .nivi-modal-eye.right { right: 6px; }
      .nivi-modal-mouth { top: 18px; width: 7px; height: 3.5px; }
      .nivi-modal-ear { top: 16px; height: 11px; width: 5px; }
      .nivi-modal-body { left: 14px; width: 16px; height: 9px; }
      .nivi-modal-heart { font-size: 6px; top: 1px; left: 5px; }
      .nivi-modal-arm { top: 33px; height: 10px; width: 6px; }
      .nivi-modal-arm.left { left: 7px; }
      .nivi-modal-arm.right { right: 7px; }
      .nivi-modal-bubble { font-size: 11px; padding: 7px 9px; line-height: 1.5; border-radius: 12px 12px 3px 12px; }
      .nivi-modal-bubble::after { width: 10px; height: 10px; top: -5px; }
    }
    .modal-card { position: relative; padding-bottom: 8px; }
    @media (max-width: 520px) {
      .modal-card { padding: 26px 18px calc(8px + env(safe-area-inset-bottom)); max-height: calc(100dvh - 40px); }
      .modal-card .nivi-modal-bubble { margin-top: 2px; }
    }
    @media (max-width: 400px) {
      .modal-card { padding: 22px 16px calc(6px + env(safe-area-inset-bottom)); }
    }
  `;
  document.head.appendChild(style);

  /* =======================================================
     8. FLOATING MARKUP
     ======================================================= */
  const root = document.createElement("div");
  root.className = "niva-bot-root";
  root.innerHTML = `
    <div class="niva-bot-panel" id="nivaBotPanel" role="dialog" aria-modal="false" aria-label="NIVI robot assistant" aria-hidden="true">
      <div class="niva-bot-head">
        <div class="nivi-mini" aria-hidden="true">
          <div class="nivi-mini-antenna"></div>
          <div class="nivi-mini-head">
            <div class="nivi-mini-face"><div class="nivi-mini-smile"></div></div>
          </div>
        </div>
        <div class="niva-bot-title">
          <b>NIVI</b>
          <span>Your Little Love Guide</span>
          <div class="nivi-status">Ready to help</div>
        </div>
        <button class="niva-bot-close" id="nivaBotClose" type="button" aria-label="Close chat">×</button>
      </div>
      <div class="niva-bot-body" id="nivaBotBody" aria-live="polite" aria-relevant="additions"></div>
      <div class="niva-bot-quick" id="nivaBotQuick">
        <button type="button" data-q="What is NIVA?">💗 About NIVA</button>
        <button type="button" data-q="Pricing?">✨ Pricing</button>
        <button type="button" data-q="Sign up">Sign up</button>
        <button type="button" data-q="Sign in">Sign in</button>
      </div>
      <form class="niva-bot-input" id="nivaBotForm">
        <input id="nivaBotInput" type="text" placeholder="Ask your little robot..." autocomplete="off" maxlength="300" aria-label="Type your question">
        <button type="submit" aria-label="Send message">➤</button>
      </form>
    </div>
    <div class="nivi-badge" id="niviBadge" aria-hidden="true">Hii! Need help? 💗</div>
    <button class="niva-bot-fab" id="nivaBotFab" type="button" aria-label="Open NIVI robot assistant" aria-expanded="false" aria-controls="nivaBotPanel">
      <span class="nivi-character" aria-hidden="true">
        <span class="nivi-antenna"></span>
        <span class="nivi-arm left"></span>
        <span class="nivi-arm right"></span>
        <span class="nivi-ear left"></span>
        <span class="nivi-ear right"></span>
        <span class="nivi-head">
          <span class="nivi-face">
            <span class="nivi-eye left"></span>
            <span class="nivi-eye right"></span>
            <span class="nivi-blush left"></span>
            <span class="nivi-blush right"></span>
            <span class="nivi-smile"></span>
          </span>
        </span>
        <span class="nivi-body"><span class="nivi-heart">♥</span></span>
        <span class="nivi-spark one">✦</span>
        <span class="nivi-spark two">♥</span>
      </span>
    </button>
  `;
  document.body.appendChild(root);

  const fab = root.querySelector("#nivaBotFab");
  const panel = root.querySelector("#nivaBotPanel");
  const closeBtn = root.querySelector("#nivaBotClose");
  const body = root.querySelector("#nivaBotBody");
  const form = root.querySelector("#nivaBotForm");
  const input = root.querySelector("#nivaBotInput");
  const quick = root.querySelector("#nivaBotQuick");
  const sendBtn = form ? form.querySelector('button[type="submit"]') : null;
  const badge = root.querySelector("#niviBadge");

  if (!fab || !panel || !closeBtn || !body || !form || !input || !quick) {
    console.warn("[NIVI] Required elements missing.");
    root.remove(); style.remove();
    window.__NIVI_LOADED__ = false;
    return;
  }

  /* =======================================================
     9. CHAT RENDERING
     ======================================================= */
  function addMessage(html, who = "bot") {
    const el = document.createElement("div");
    el.className = "niva-bot-msg " + who;
    el.innerHTML = renderRich(html);
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }
  function addRaw(html, who = "bot") {
    const el = document.createElement("div");
    el.className = "niva-bot-msg " + who;
    el.innerHTML = html;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }
  function showTyping() {
    const el = document.createElement("div");
    el.className = "niva-bot-msg bot typing";
    el.innerHTML = "<i></i><i></i><i></i>";
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }
  function renderNextChips(items) {
    quick.innerHTML = "";
    const base = items && items.length
      ? items
      : ["What is NIVA?", "Pricing?", "Sign up", "Sign in"];
    base.slice(0, 4).forEach(q => {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.q = q;
      b.textContent = q;
      quick.appendChild(b);
    });
  }

  const HISTORY_KEY = "nivi-history-v1";
  function saveHistory() {
    try { sessionStorage.setItem(HISTORY_KEY, JSON.stringify(state.history.slice(-30))); } catch {}
  }
  function loadHistory() {
    try {
      const raw = sessionStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  /* =======================================================
     10. AUTH API WRAPPERS
     ======================================================= */
  async function apiCall(path, body) {
    const res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  async function checkUsernameAvailable(username) {
    const { ok, data } = await apiCall("/api/auth/check-username", { username });
    return { ok, data };
  }

  async function checkCurrentUser() {
    try {
      const res = await fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (data && data.authenticated && data.user) {
        state.user = data.user;
        return data.user;
      }
    } catch {}
    return null;
  }
  async function dispatchLogin(user) {
    state.user = user;
    document.dispatchEvent(new CustomEvent("nivi:login", { detail: user }));
    try {
      const signInBtn = document.getElementById("navSignIn");
      const userBtn = document.getElementById("navUser");
      const avatar = document.getElementById("navAvatar");
      const userName = document.getElementById("navUserName");
      const menuEmail = document.getElementById("menuEmail");
      const menuUsername = document.getElementById("menuUsername");
      if (signInBtn) signInBtn.style.display = "none";
      if (userBtn) userBtn.classList.add("show");
      const display = user.username || user.displayName || (user.email ? user.email.split("@")[0] : "friend");
      if (avatar) avatar.textContent = (display[0] || "U").toUpperCase();
      if (userName) userName.textContent = display;
      if (menuEmail) menuEmail.textContent = user.email || "";
      if (menuUsername) menuUsername.textContent = "@" + display;
    } catch {}
  }

  /* =======================================================
     11. USERNAME VALIDATION
     ======================================================= */
  function validateUsernameClient(name) {
    if (!name || typeof name !== "string") return "Please choose a username.";
    const t = name.trim();
    if (t.length < 3) return "Username must be at least 3 characters.";
    if (t.length > 30) return "Username must be at most 30 characters.";
    if (!/^[A-Za-z]/.test(t)) return "Username must start with a letter.";
    if (!/^[A-Za-z0-9_.]+$/.test(t)) return "Only letters, numbers, underscore (_) and dot (.) allowed.";
    return null;
  }

  /* =======================================================
     12. AUTH FLOW (chat-driven)
     ======================================================= */
  function resetAuthFlow() {
    state.authFlow = null;
    state.authData = {};
    state.usernameAvailable = false;
    state.usernameChecked = false;
  }
  async function startAuthFlow(kind) {
    resetAuthFlow();
    state.authFlow = kind;
    if (kind === "signup") {
      addMessage("Let's create your account ♥\n\nFirst, choose a **username** (3–30 characters, letters/numbers/_/.). It'll be yours forever!");
      renderNextChips([]);
    } else if (kind === "signin") {
      addMessage("Welcome back! ♥\n\nWhat's your **email or username**?");
      renderNextChips([]);
    } else if (kind === "forgot") {
      addMessage("No worries — I'll help you reset your password. ♥\n\nWhat's your **email**?");
      renderNextChips([]);
    }
  }

  async function handleAuthInput(text) {
    const q = text.trim();
    const flow = state.authFlow;

    if (flow === "signup") {
      if (!state.authData.username) {
        const uname = q.replace(/^@/, "").trim();
        const err = validateUsernameClient(uname);
        if (err) {
          addMessage("Hmm, " + err.charAt(0).toLowerCase() + err.slice(1) + " 🥺 Try again?");
          return;
        }
        const t = showTyping();
        const { ok, data } = await checkUsernameAvailable(uname);
        t.remove();
        if (!ok || !data.success || !data.available) {
          addMessage("Oh no — " + (data.message || "that username is already taken.") + " 🥺 Try another?");
          return;
        }
        state.authData.username = uname;
        state.usernameAvailable = true;
        state.usernameChecked = true;
        addMessage("Perfect — **@" + uname + "** is yours! ✦\n\nNow, what's your **email**? I'll send you a 6-digit verification code.");
        return;
      }
      if (!state.authData.email) {
        const email = q.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          addMessage("Hmm, that doesn't look like an email. Try something like **you@example.com** ♡");
          return;
        }
        state.authData.email = email;
        const t = showTyping();
        const { ok, data } = await apiCall("/api/auth/register", {
          email,
          username: state.authData.username,
        });
        t.remove();
        if (!ok || !data.success) {
          if (data.usernameTaken) {
            addMessage("Oh! Someone grabbed that username just before us 🥺 Please pick a different one.");
            state.authData.username = null;
            state.usernameAvailable = false;
            state.usernameChecked = false;
            return;
          }
          if (data.alreadyRegistered) {
            addMessage("Oh! An account with that email already exists. Try **sign in** instead, or say **forgot password** if you can't remember it. 💗");
            resetAuthFlow();
            return;
          }
          addMessage("Hmm — I couldn't send the code. " + (data.message || "Please try again in a moment."));
          resetAuthFlow();
          return;
        }
        state.authFlow = "verify-email";
        addMessage("Sent! ♥ I emailed a **6-digit code** to **" + email + "**.\n\nType the code here when you get it.");
        renderNextChips([]);
        return;
      }
    }

    if (flow === "verify-email") {
      const code = q.replace(/\D/g, "").slice(0, 6);
      if (code.length !== 6) {
        addMessage("I need the **6-digit code** — just the numbers ♡");
        return;
      }
      const t = showTyping();
      const { ok, data } = await apiCall("/api/auth/verify-email", { email: state.authData.email, code });
      t.remove();
      if (!ok || !data.success) {
        addMessage("Hmm — " + (data.message || "that code didn't work.") + "\n\nTry again, or say **resend** if you want a fresh one. ♡");
        return;
      }
      if (data.hasPassword && data.authenticated) {
        resetAuthFlow();
        await dispatchLogin(data.user);
        const display = data.user.username || data.user.email.split("@")[0];
        addMessage("🎉 You're in, **@" + display + "**! Welcome back ♥✦");
        renderNextChips(["Create a gift", "Pricing?"]);
        return;
      }
      state.authFlow = "set-password";
      addMessage("Email verified! ✦\n\nNow choose a **password** (8–128 characters). Type it here.");
      renderNextChips([]);
      return;
    }

    if (flow === "set-password") {
      if (!state.authData.password) {
        if (q.length < 8 || q.length > 128) {
          addMessage("Passwords need to be **8 to 128 characters**. Try again ♡");
          return;
        }
        state.authData.password = q;
        addMessage("Got it. Type the same password again to confirm. ♥");
        return;
      }
      if (q !== state.authData.password) {
        addMessage("Those don't match. Let's start over — type your password again ♡");
        state.authData.password = null;
        return;
      }
      const t = showTyping();
      const { ok, data } = await apiCall("/api/auth/set-password", {
        email: state.authData.email,
        password: state.authData.password,
      });
      t.remove();
      if (!ok || !data.success) {
        addMessage("Hmm — " + (data.message || "could not save password.") + " Try again later. ♡");
        resetAuthFlow();
        return;
      }
      resetAuthFlow();
      await dispatchLogin(data.user);
      const display = data.user.username || data.user.email.split("@")[0];
      addMessage("🎉 You're all set, **@" + display + "**! Welcome to NIVA ♥✦\n\nReady to create your first gift?");
      renderNextChips(["Create a gift", "Pricing?", "Templates"]);
      return;
    }

    if (flow === "signin") {
      if (!state.authData.identifier) {
        if (!q) {
          addMessage("Please enter your **email or username** ♡");
          return;
        }
        state.authData.identifier = q;
        addMessage("Got it. Now what's your **password**?");
        return;
      }
      if (!state.authData.password) state.authData.password = q;
      const t = showTyping();
      const { ok, status, data } = await apiCall("/api/auth/login", {
        email: state.authData.identifier,
        password: state.authData.password,
      });
      t.remove();
      if (!ok || !data.success) {
        if (status === 403 && data.needsVerification) {
          state.authFlow = "verify-email";
          state.authData.email = data.email;
          addMessage("Almost there! Your email isn't verified yet. ♥\n\nI just sent a fresh **6-digit code** to **" + data.email + "**. Type it here when it arrives.");
          return;
        }
        if (status === 403 && data.needsPasswordSetup) {
          state.authFlow = "set-password";
          state.authData.email = data.email;
          state.authData.password = null;
          addMessage("Your account exists but has no password yet. Let's set one — choose **8–128 characters**. ♡");
          return;
        }
        addMessage("Hmm, that password doesn't match. ♡\n\nTry again — or say **forgot password** if you'd like to reset it.");
        state.authData.password = null;
        return;
      }
      resetAuthFlow();
      await dispatchLogin(data.user);
      const display = data.user.username || data.user.email.split("@")[0];
      addMessage("🎉 Welcome back, **@" + display + "**! ♥✦\n\nWhat would you like to do?");
      renderNextChips(["Create a gift", "My gifts", "Pricing?"]);
      return;
    }

    if (flow === "forgot") {
      if (!state.authData.email) {
        const email = q.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          addMessage("That doesn't look like an email. Try **you@example.com** ♡");
          return;
        }
        state.authData.email = email;
        const t = showTyping();
        const { ok, data } = await apiCall("/api/auth/forgot-password", { email });
        t.remove();
        if (!ok || !data.success) {
          addMessage("Hmm — " + (data.message || "couldn't send reset code."));
          resetAuthFlow();
          return;
        }
        state.authFlow = "verify-reset";
        addMessage("If that email is registered, a **6-digit code** is on its way. ✦\n\nType the code when it arrives.");
        return;
      }
    }

    if (flow === "verify-reset") {
      const code = q.replace(/\D/g, "").slice(0, 6);
      if (code.length !== 6) {
        addMessage("I need the **6-digit code** — just numbers ♡");
        return;
      }
      const t = showTyping();
      const { ok, data } = await apiCall("/api/auth/verify-reset-code", { email: state.authData.email, code });
      t.remove();
      if (!ok || !data.success) {
        addMessage("Hmm — " + (data.message || "code didn't work.") + "\n\nTry again, or say **resend** ♡");
        return;
      }
      state.authFlow = "reset-password";
      addMessage("Code verified! ✦\n\nChoose a **new password** (8–128 characters). Type it here.");
      return;
    }

    if (flow === "reset-password") {
      if (!state.authData.password) {
        if (q.length < 8 || q.length > 128) {
          addMessage("Passwords need to be **8 to 128 characters**. Try again ♡");
          return;
        }
        state.authData.password = q;
        addMessage("Type it again to confirm ♥");
        return;
      }
      if (q !== state.authData.password) {
        addMessage("Those don't match. Let's try again — type your new password ♡");
        state.authData.password = null;
        return;
      }
      const t = showTyping();
      const { ok, data } = await apiCall("/api/auth/reset-password", {
        email: state.authData.email,
        password: state.authData.password,
      });
      t.remove();
      if (!ok || !data.success) {
        addMessage("Hmm — " + (data.message || "could not reset password."));
        resetAuthFlow();
        return;
      }
      resetAuthFlow();
      addMessage("Password reset! ♥✦ You can now sign in. Say **sign in** whenever you're ready.");
      renderNextChips(["Sign in", "What is NIVA?"]);
      return;
    }

    resetAuthFlow();
    addMessage("Let's start fresh ♥ — say **sign up**, **sign in**, or **forgot password**.");
  }

  /* =======================================================
     13. COMPOSE
     ======================================================= */
  function composeReply(query) {
    const q = String(query || "").toLowerCase().trim();
    if (state.lastTopicId && /^(more|tell me more|and\?|and|continue|elaborate|really\?)$/.test(q)) {
      const entry = KB.find(e => e.id === state.lastTopicId);
      if (entry) return { html: entry.answer, next: entry.next, topicId: entry.id, confidence: 1 };
    }
    const intent = matchIntent(q);
    if (intent) return { html: intent.answer(), next: intent.next || [], topicId: null, confidence: 1 };
    const matches = rankMatches(q);
    if (matches.length) {
      if (matches.length === 1) {
        const e = matches[0].entry;
        state.lastTopicId = e.id;
        return { html: e.answer, next: e.next, topicId: e.id, confidence: matches[0].score };
      }
      const parts = matches.map(m => m.entry.answer);
      state.lastTopicId = matches[0].entry.id;
      return {
        html: parts.join("\n\n──\n\n"),
        next: matches[0].entry.next,
        topicId: matches[0].entry.id,
        confidence: matches[0].score,
      };
    }
    return { html: pick(FALLBACKS), next: [], topicId: null, confidence: 0 };
  }

  /* =======================================================
     14. OPEN / CLOSE
     ======================================================= */
  let hasOpened = false;
  function openPanel() {
    if (root.classList.contains("hidden-for-modal")) return;
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    fab.setAttribute("aria-expanded", "true");
    root.classList.add("chat-open");
    if (badge) badge.style.display = "none";

    if (!hasOpened) {
      hasOpened = true;
      const prior = loadHistory();
      if (prior.length) {
        prior.forEach(m => {
          if (m.who === "user") addMessage(m.text, "user");
          else addRaw(m.html, "bot");
        });
      } else {
        const loggedIn = state.user
          ? "♥ Welcome back, **@" + (state.user.username || state.user.displayName || state.user.email?.split("@")[0] || "friend") + "**! "
          : "";
        const greet = `Hi! ♥ I'm **NIVI** — NIVA's little robot guide.\n\n${loggedIn}${PAGE_HINTS[PAGE] || ""}\n\nI can also **sign you up** or **sign you in** right here. Just tell me.`;
        addRaw(renderRich(greet), "bot");
        state.history.push({ who: "bot", html: greet });
        saveHistory();
        renderNextChips(null);
      }
    }
    setTimeout(() => { try { input.focus(); } catch {} }, 200);
  }
  function closePanel() {
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
    fab.setAttribute("aria-expanded", "false");
    root.classList.remove("chat-open");
  }

  fab.addEventListener("click", () => {
    panel.classList.contains("open") ? closePanel() : openPanel();
  });
  closeBtn.addEventListener("click", closePanel);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.classList.contains("open")) closePanel();
  });

  /* =======================================================
     15. MODAL ROBOT
     ======================================================= */
  const EMOTIONS = {
    neutral:   { emoji: "♥" },
    happy:     { emoji: "🎉" },
    sad:       { emoji: "🥺" },
    think:     { emoji: "🤔" },
  };

  let modalRoot = null;
  let modalRobot = null;
  let modalBubble = null;
  let currentEmotion = "neutral";
  let lastNarratedPane = null;

  function buildModalRobot() {
    const wrap = document.createElement("div");
    wrap.className = "nivi-modal-root";
    wrap.innerHTML = `
      <div class="nivi-modal-robot" id="niviModalRobot" aria-live="polite">
        <div class="nivi-modal-antenna"></div>
        <div class="nivi-modal-arm left"></div>
        <div class="nivi-modal-arm right"></div>
        <div class="nivi-modal-ear left"></div>
        <div class="nivi-modal-ear right"></div>
        <div class="nivi-modal-head">
          <div class="nivi-modal-face">
            <div class="nivi-modal-eye left"></div>
            <div class="nivi-modal-eye right"></div>
            <div class="nivi-modal-mouth"></div>
          </div>
        </div>
        <div class="nivi-modal-body"><div class="nivi-modal-heart">♥</div></div>
      </div>
      <div class="nivi-modal-bubble" id="niviModalBubble">
        <span class="nivi-modal-emotion">♥</span>
        <span class="nivi-modal-text">Hi! I'm here to help. 💗</span>
      </div>
    `;
    return wrap;
  }

  function ensureModalRobot() {
    const card = document.querySelector(".modal-card");
    if (!card) return null;
    if (!modalRoot || !card.contains(modalRoot)) {
      modalRoot = buildModalRobot();
      card.appendChild(modalRoot);
      modalRobot = modalRoot.querySelector("#niviModalRobot");
      modalBubble = modalRoot.querySelector("#niviModalBubble");
    }
    return modalRoot;
  }

  function setEmotion(emotion) {
    currentEmotion = emotion || "neutral";
    if (!modalRobot) return;
    modalRobot.classList.remove("happy", "sad");
    if (currentEmotion === "happy") modalRobot.classList.add("happy");
    else if (currentEmotion === "sad") modalRobot.classList.add("sad");
    if (modalBubble) {
      modalBubble.classList.remove("happy", "sad");
      if (currentEmotion === "happy" || currentEmotion === "sad") {
        modalBubble.classList.add(currentEmotion);
      }
    }
  }

  function speak(text, emotion = "neutral", extraHtml = "") {
    if (!modalBubble) return;
    const emoji = EMOTIONS[emotion]?.emoji || "♥";
    const textEl = modalBubble.querySelector(".nivi-modal-text");
    const emojiEl = modalBubble.querySelector(".nivi-modal-emotion");
    if (textEl) textEl.innerHTML = renderRich(text) + (extraHtml || "");
    if (emojiEl) emojiEl.textContent = emoji;
    modalBubble.style.animation = "none";
    void modalBubble.offsetWidth;
    modalBubble.style.animation = "";
    setEmotion(emotion);
  }

  function forgotPasswordHintHtml() {
    return `<br><button type="button" class="nivi-forgot-btn" data-nivi-forgot="1">💗 Forgot password?</button>`;
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-nivi-forgot]");
    if (!btn) return;
    const link = document.querySelector("#toForgotPassword") || document.querySelector("#backToLogin");
    if (link) { link.click(); return; }
    const forgotPane = document.getElementById("forgotPane");
    if (forgotPane) {
      document.querySelectorAll('[id$="Pane"]').forEach(p => { if (p.closest(".modal-card")) p.hidden = true; });
      forgotPane.hidden = false;
    }
  });

  const PANE_GUIDES = {
    loginPane: {
      emotion: "neutral",
      text: "Hi! I'm NIVI ♥ Sign in here — type your email or username, then your password. I'll cheer you on!",
    },
    registerPane: {
      emotion: "neutral",
      text: "Let's make you an account ✦ First pick a **username** — something you love. Then add your email.",
    },
    verifyPane: {
      emotion: "think",
      text: "Check your inbox ♥ — paste the 6-digit code here so I know it's really you.",
    },
    setPasswordPane: {
      emotion: "think",
      text: "Choose a password between 8 and 128 characters ♡. Repeat it below — I'm watching for typos!",
    },
    forgotPane: {
      emotion: "neutral",
      text: "No stress — enter your email and I'll send you a reset code 💕",
    },
    verifyResetPane: {
      emotion: "think",
      text: "Type the reset code from your inbox ♥ — same as before!",
    },
    resetPane: {
      emotion: "think",
      text: "New password time ✦ 8–128 characters — type it twice to confirm.",
    },
  };

  function guidePane(paneId) {
    const guide = PANE_GUIDES[paneId];
    if (!guide) return;
    if (lastNarratedPane === paneId) return;
    lastNarratedPane = paneId;
    if (paneId === "loginPane") state.loginFailCount = 0;
    speak(guide.text, guide.emotion);
  }

  function narrateError(paneId, errorText) {
    const e = String(errorText || "").toLowerCase();

    if (e.includes("username") && (e.includes("taken") || e.includes("already"))) {
      speak(
        "Ohh... that username is already taken 🥺 Can you think of another one? I really want this to be special for you!",
        "sad"
      );
      return;
    }

    if (e.includes("incorrect email") || e.includes("incorrect email/username") ||
        (e.includes("password") && (e.includes("incorrect") || e.includes("wrong") || e.includes("match") || e.includes("invalid")))) {
      state.loginFailCount += 1;
      if (state.loginFailCount >= 3) {
        speak(
          "Oh... did you forget your password? 🥺 Don't worry, I'm here to help you...",
          "sad",
          forgotPasswordHintHtml()
        );
        return;
      }
      const nth = state.loginFailCount === 1
        ? "Oh oh! That password isn't quite right 🥺"
        : "Hmm... still not that one 🥺";
      speak(nth + " Try again — I believe in you!", "sad");
      return;
    }

    if (e.includes("incorrect code") || (e.includes("invalid") && e.includes("code")) || e.includes("code didn't work")) {
      speak(
        "Ohh... that's not the right code... 🥺 Could you please check your email one more time? I really hope we can get this right... 💗",
        "sad"
      );
      return;
    }

    if (e.includes("enter a valid email") || e.includes("invalid email")) {
      speak("Hmm, that email doesn't look right 🥺 Something like you@example.com works best!", "sad");
      return;
    }

    if (e.includes("at least 8") || e.includes("at most 128") || e.includes("8 and 128") || e.includes("between 8 and 128")) {
      speak("Almost! Your password needs 8–128 characters 💕 Try a slightly longer one!", "sad");
      return;
    }

    if (e.includes("passwords do not match") || e.includes("do not match")) {
      speak("Oh no — those passwords don't match 🥺 Type them again carefully?", "sad");
      return;
    }

    if (e.includes("already exists") || e.includes("already registered")) {
      speak("Ah Ah!, that email already has an account ✦ Try **Sign In** instead — or reset your password!", "sad");
      return;
    }

    if (e.includes("verify your email") || e.includes("needs verification")) {
      speak("Almost there! Check your email — I just sent a fresh code ♥", "sad");
      return;
    }

    if (e.includes("too many")) {
      speak("Oh no... too many tries. 😔 Give it a few minutes and try again — I'll be right here.", "sad");
      return;
    }

    if (e.includes("expired")) {
      speak("Oh no, that code expired 🥺 Say **resend** and I'll get you a new one!", "sad");
      return;
    }

    speak("Hmm, something went wrong: " + (errorText || "try again") + " 🥺", "sad");
  }

  function narrateSuccess(message) {
    state.loginFailCount = 0;
    speak("Yay! " + (message || "You're in! ✦"), "happy");
  }

  function observeModalErrors() {
    const errors = document.querySelectorAll(".modal-error");
    errors.forEach(el => {
      if (el.dataset.niviBound === "1") return;
      el.dataset.niviBound = "1";
      const observer = new MutationObserver(() => {
        const text = (el.textContent || "").trim();
        if (!text) return;
        const pane = el.closest('[id$="Pane"]');
        const paneId = pane ? pane.id : "";
        if (el.classList.contains("success")) narrateSuccess(text);
        else narrateError(paneId, text);
      });
      observer.observe(el, { childList: true, characterData: true, subtree: true });
    });
  }

  function observePaneChanges() {
    const panes = document.querySelectorAll('[id$="Pane"]');
    panes.forEach(pane => {
      if (pane.dataset.niviBound === "1") return;
      pane.dataset.niviBound = "1";
      const observer = new MutationObserver(() => {
        const modal = document.getElementById("authModal");
        if (!modal || !modal.classList.contains("show")) return;
        if (pane.hidden) return;
        guidePane(pane.id);
      });
      observer.observe(pane, { attributes: true, attributeFilter: ["hidden"] });
    });
  }

  function observeAuthModal() {
    const modal = document.getElementById("authModal");
    if (!modal) return;

    const update = () => {
      const open = modal.classList.contains("show");
      if (open) {
        root.classList.add("hidden-for-modal");
        ensureModalRobot();
        const visiblePane = Array.from(document.querySelectorAll('[id$="Pane"]'))
          .find(p => !p.hidden && p.closest(".modal-card"));
        if (visiblePane) guidePane(visiblePane.id);
        observeModalErrors();
        observePaneChanges();
      } else {
        root.classList.remove("hidden-for-modal");
        lastNarratedPane = null;
        state.loginFailCount = 0;
        if (badge && badge.style.display === "none") {
          badge.style.display = "";
          badge.style.opacity = "1";
        }
      }
    };

    const observer = new MutationObserver(update);
    observer.observe(modal, { attributes: true, attributeFilter: ["class"] });
    update();
  }

  /* =======================================================
     16. RESPOND
     ======================================================= */
  async function respond(question) {
    if (state.busy) return;
    state.busy = true;
    if (sendBtn) sendBtn.disabled = true;
    quick.querySelectorAll("button").forEach(b => b.disabled = true);

    const text = String(question || "").trim();

    if (state.authFlow) {
      const typing = showTyping();
      await new Promise(r => setTimeout(r, 300));
      typing.remove();
      await handleAuthInput(text);
      state.history.push({ who: "user", text });
      saveHistory();
      state.busy = false;
      if (sendBtn) sendBtn.disabled = false;
      quick.querySelectorAll("button").forEach(b => b.disabled = false);
      return;
    }

    if (/^resend$/i.test(text) && (state.authFlow === "verify-email" || state.authFlow === "verify-reset")) {
      const typing = showTyping();
      const purpose = state.authFlow === "verify-reset" ? "reset" : "verify";
      const { ok, data } = await apiCall("/api/auth/resend-code", {
        email: state.authData.email, purpose,
      });
      typing.remove();
      if (ok && data.success) {
        addMessage("Done! A fresh code is on its way to **" + state.authData.email + "** ♥");
      } else {
        addMessage("Hmm — " + (data.message || "couldn't resend. Try again in a moment."));
      }
      state.busy = false;
      if (sendBtn) sendBtn.disabled = false;
      quick.querySelectorAll("button").forEach(b => b.disabled = false);
      return;
    }

    const authIntent = matchAuthIntent(text);
    if (authIntent) {
      addMessage(text, "user");
      state.history.push({ who: "user", text });
      saveHistory();
      await startAuthFlow(authIntent.id);
      state.busy = false;
      if (sendBtn) sendBtn.disabled = false;
      quick.querySelectorAll("button").forEach(b => b.disabled = false);
      return;
    }

    const typing = showTyping();
    const reply = composeReply(text);
    let finalHtml = reply.html;
    let finalNext = reply.next;
    if (!reply.confidence) {
      const remote = await askServer(text);
      if (remote) { finalHtml = remote; finalNext = []; }
    }
    const plain = finalHtml.replace(/<[^>]+>/g, "");
    const delay = Math.min(1600, 350 + plain.length * 2);

    setTimeout(() => {
      typing.remove();
      addRaw(renderRich(finalHtml), "bot");
      state.history.push({ who: "user", text });
      state.history.push({ who: "bot", html: finalHtml });
      saveHistory();
      renderNextChips(finalNext);
      state.busy = false;
      if (sendBtn) sendBtn.disabled = false;
      quick.querySelectorAll("button").forEach(b => b.disabled = false);
      body.scrollTop = body.scrollHeight;
    }, delay);
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    addMessage(text, "user");
    state.history.push({ who: "user", text });
    input.value = "";
    respond(text);
  });

  quick.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-q]");
    if (!btn) return;
    const q = btn.dataset.q;
    addMessage(q, "user");
    state.history.push({ who: "user", text: q });
    respond(q);
  });

  /* =======================================================
     17. BOOT
     ======================================================= */
  (async () => {
    await checkCurrentUser();
    observeAuthModal();
    if (badge) {
      setTimeout(() => {
        if (!panel.classList.contains("open")) {
          badge.style.transition = "opacity .4s ease";
          badge.style.opacity = "0";
          setTimeout(() => { badge.style.display = "none"; }, 420);
        }
      }, 12000);
    }
  })();

  window.NIVI = {
    open: openPanel,
    close: closePanel,
    ask: (q) => { openPanel(); respond(q); },
    version: "3.4.0",
    speak: (text, emotion) => { ensureModalRobot(); speak(text, emotion); },
    narrateError: (paneId, text) => { ensureModalRobot(); narrateError(paneId, text); },
  };
})();