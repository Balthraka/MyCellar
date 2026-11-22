"""Page save fixes from the Packr audit lessons (applied by build-web.py and once to web/index.html):
 1. saves never overlap: every drink save/delete goes through one queue and works on the LATEST copy of the drink, so a double
    click or two quick stock changes cannot send the same base version twice (which gave a false "changed on another device" 409);
 2. settings saves (locations, rating scale) are retried after 5, 15 and 60 s when the network fails or the server answers 5xx;
 3. a rating-scale edit still waiting for its 700 ms timer is saved at once (keepalive) when the page is hidden or closed;
 4. a 401 shows a message on the sign-in screen instead of silently dropping the person there."""

def rep(src, old, new, count=1):
    assert src.count(old) == count, (src.count(old), old[:80])
    return src.replace(old, new)

def apply(src):
    # --- api(): optional keepalive -------------------------------------------------------------------------------
    src = rep(src, "async function api(method, path, body) {", "async function api(method, path, body, opts) {")
    src = rep(src, "res = await fetch(API_BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }); }",
                   "res = await fetch(API_BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, keepalive: !!(opts && opts.keepalive) }); }")
    src = rep(src, "async saveSettings(patch, version) { const r = await api('PUT', '/settings', { ...patch, version }); return r.version; },",
                   "async saveSettings(patch, version, opts) { const r = await api('PUT', '/settings', { ...patch, version }, opts); return r.version; },")

    # --- App state: a synchronous copy of the drinks and the save queue -------------------------------------------
    src = rep(src, "      const [drinks,    setDrinks]    = useState([]);\n",
"""      const [drinks,    setDrinks]    = useState([]);
      // `drinksRef` is always the newest list (updated at once, not at the next render), so queued saves start from the latest copy.
      const drinksRef = useRef([]);
      const saveChain = useRef(Promise.resolve());
      const pendingScale = useRef(null);
      const flushRef = useRef(() => {});
      function setDrinksNow(u) { const next = typeof u === 'function' ? u(drinksRef.current) : u; drinksRef.current = next; setDrinks(next); }
      // One save at a time: a task starts only when the one before it has finished (whether it worked or not).
      function enqueue(task) { const run = saveChain.current.then(task, task); saveChain.current = run.catch(() => {}); return run; }
""")
    src = rep(src, "        setDrinks(drinks);\n        settingsVer.current", "        setDrinksNow(drinks);\n        settingsVer.current")

    src = rep(src, "setDrinks(prev => prev.map(d => map.get(d.id) || d));", "setDrinksNow(prev => prev.map(d => map.get(d.id) || d));")

    # --- persistDrink / removeDrink: queued, latest version ---------------------------------------------------------
    src = rep(src, """      async function persistDrink(updated) {
        try {
          const saved = await store.upsert(updated);
          setDrinks(prev => prev.some(d => d.id === saved.id) ? prev.map(d => d.id === saved.id ? saved : d) : [...prev, saved]);
          return saved;
        } catch (e) { await fail(e, 'Failed to save. Check your connection and try again.'); return null; }
      }
""", """      async function persistNow(updated) {
        // Only this tab's own earlier save can make the held copy newer than the form's copy (a double click), so use its version.
        const cur = drinksRef.current.find(d => d.id === updated.id);
        const toSave = cur && cur._v != null && cur._v > (updated._v ?? 0) ? { ...updated, _v: cur._v } : updated;
        try {
          const saved = await store.upsert(toSave);
          setDrinksNow(prev => prev.some(d => d.id === saved.id) ? prev.map(d => d.id === saved.id ? saved : d) : [...prev, saved]);
          return saved;
        } catch (e) { await fail(e, 'Failed to save. Check your connection and try again.'); return null; }
      }
      const persistDrink = updated => enqueue(() => persistNow(updated));
      // Changes one drink from its LATEST copy (so two quick changes both land); `make` returns the new drink or null for nothing to do.
      const changeDrink = (drinkId, make) => enqueue(async () => {
        const drink = drinksRef.current.find(d => d.id === drinkId);
        const updated = drink && make(drink);
        return updated ? persistNow(updated) : null;
      });
""")
    src = rep(src, """      async function removeDrink(id) {
        const d = drinks.find(x => x.id === id);
        try {
          await store.remove(d || { id });
          setDrinks(prev => prev.filter(x => x.id !== id));
          setSelected(null);
        } catch (e) { await fail(e, 'Failed to delete drink. Check your connection and try again.'); }
      }
""", """      const removeDrink = id => enqueue(async () => {
        const d = drinksRef.current.find(x => x.id === id);
        try {
          await store.remove(d || { id });
          setDrinksNow(prev => prev.filter(x => x.id !== id));
          setSelected(null);
        } catch (e) { await fail(e, 'Failed to delete drink. Check your connection and try again.'); }
      });
""")

    # --- stock operations: computed from the latest copy inside the queue ---------------------------------------------
    src = rep(src, """        const drink = drinks.find(d=>d.id===drinkId);
        if (!drink) return;
        const updated = {...drink, stock:[...(drink.stock||[]), entry]};
        const saved = await persistDrink(updated);
        if (saved) setSelected(saved);""",
"""        const saved = await changeDrink(drinkId, drink => ({...drink, stock:[...(drink.stock||[]), entry]}));
        if (saved) setSelected(saved);""")
    src = rep(src, """        const drink = drinks.find(d=>d.id===drinkId);
        if (!drink) return;
        const entry = (drink.stock||[]).find(s=>s.id===stockId);
        if (!entry) return;
        const finishQty = Math.min(qty||entry.quantity, entry.quantity);
        let newStock;""", """        const saved = await changeDrink(drinkId, drink => {
        const entry = (drink.stock||[]).find(s=>s.id===stockId);
        if (!entry) return null;
        const finishQty = Math.min(qty||entry.quantity, entry.quantity);
        let newStock;""")
    src = rep(src, """        const updated = {...drink, stock:newStock};
        const saved = await persistDrink(updated);
        if (saved) setSelected(saved);
      }
      async function removeStock""", """        return {...drink, stock:newStock};
        });
        if (saved) setSelected(saved);
      }
      async function removeStock""")
    src = rep(src, """        const drink = drinks.find(d=>d.id===drinkId);
        if (!drink) return;
        const updated = {...drink, stock:(drink.stock||[]).filter(s=>s.id!==stockId)};
        const saved = await persistDrink(updated);
        if (saved) setSelected(saved);""", """        const saved = await changeDrink(drinkId, drink => ({...drink, stock:(drink.stock||[]).filter(s=>s.id!==stockId)}));
        if (saved) setSelected(saved);""")
    src = rep(src, """        const drink = drinks.find(d=>d.id===drinkId);
        if (!drink) return;
        const entry = (drink.stock||[]).find(s=>s.id===stockId);
        if (!entry) return;
        const moveQty = Math.min(qty||entry.quantity, entry.quantity);
        let newStock;""", """        const saved = await changeDrink(drinkId, drink => {
        const entry = (drink.stock||[]).find(s=>s.id===stockId);
        if (!entry) return null;
        const moveQty = Math.min(qty||entry.quantity, entry.quantity);
        let newStock;""")
    src = rep(src, """        const updated = {...drink, stock:newStock};
        const saved = await persistDrink(updated);
        if (saved) setSelected(saved);
      }

      // Settings saves""", """        return {...drink, stock:newStock};
        });
        if (saved) setSelected(saved);
      }

      // Settings saves""")

    # --- settings: retry, keepalive flush ------------------------------------------------------------------------------
    src = rep(src, """      function saveSettings(patch) {
        settingsChain.current = settingsChain.current.then(async () => {
          try { settingsVer.current = await store.saveSettings(patch, settingsVer.current); }
          catch (e) { await fail(e, 'Failed to save settings. Check your connection.'); }
        });
        return settingsChain.current;
      }""", """      // A network error or a 5xx is retried after 5, 15 and 60 seconds (the screen already shows the change, so say it is not saved yet);
      // a 4xx (including a 409) is never retried.
      function saveSettings(patch, opts) {
        settingsChain.current = settingsChain.current.then(async () => {
          const waits = [5000, 15000, 60000];
          for (let attempt = 0; ; attempt++) {
            try {
              settingsVer.current = await store.saveSettings(patch, settingsVer.current, opts);
              setAppError(m => (m && m.indexOf('Settings are not saved yet') === 0 ? null : m));
              return;
            } catch (e) {
              const retryable = e instanceof ApiError && (e.status === 0 || e.status >= 500);
              if (!retryable || (opts && opts.keepalive)) { await fail(e, 'Failed to save settings. Check your connection.'); return; }
              if (attempt >= waits.length) { setAppError('Settings were not saved. Check your connection and make the change again.'); return; }
              setAppError('Settings are not saved yet. Trying again...');
              await new Promise(r => setTimeout(r, waits[attempt]));
            }
          }
        });
        return settingsChain.current;
      }""")
    src = rep(src, """        clearTimeout(scaleTimer.current);
        scaleTimer.current = setTimeout(() => saveSettings({ scale: ns }), 700);   // typing in the chips saves once, not per keystroke
      }""", """        clearTimeout(scaleTimer.current);
        pendingScale.current = ns;
        scaleTimer.current = setTimeout(() => { pendingScale.current = null; saveSettings({ scale: ns }); }, 700);   // typing in the chips saves once, not per keystroke
      }
      // A scale edit still waiting for its timer is saved at once when the page is hidden or closed.
      flushRef.current = () => {
        if (pendingScale.current) { const ns = pendingScale.current; pendingScale.current = null; clearTimeout(scaleTimer.current); saveSettings({ scale: ns }, { keepalive: true }); }
      };
      useEffect(() => {
        const onHide = () => { if (document.visibilityState === 'hidden') flushRef.current(); };
        const onGone = () => flushRef.current();
        document.addEventListener('visibilitychange', onHide); window.addEventListener('pagehide', onGone);
        return () => { document.removeEventListener('visibilitychange', onHide); window.removeEventListener('pagehide', onGone); };
      }, []);""")

    # --- a 401 explains itself ---------------------------------------------------------------------------------------------
    src = rep(src, "function LoginScreen({ onSignedIn }) {", "function LoginScreen({ onSignedIn, notice }) {")
    src = rep(src, "{err && <div style={{marginTop:'20px'", "{(err || notice) && <div style={{marginTop:'20px'")
    src = rep(src, "lineHeight:'1.5'}}>{err}</div>}", "lineHeight:'1.5'}}>{err || notice}</div>}")
    src = rep(src, """      useEffect(() => { onUnauthorized = () => { session.clear(); setSess(null); }; }, []);""",
                   """      const [ended, setEnded] = useState(false);
      useEffect(() => { onUnauthorized = () => { session.clear(); setSess(null); setEnded(true); }; }, []);""")
    src = rep(src, "function signedIn(r) { session.set({ token: r.token, user: r.user }); setSess(session.get()); }",
                   "function signedIn(r) { session.set({ token: r.token, user: r.user }); setEnded(false); setSess(session.get()); }")
    src = rep(src, "if (!sess) return <LoginScreen onSignedIn={signedIn}/>;",
                   "if (!sess) return <LoginScreen onSignedIn={signedIn} notice={ended ? ERROR_TEXT.unauthorized + ' Anything not saved before that was not kept.' : null}/>;")
    return src
