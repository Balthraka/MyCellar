#!/usr/bin/env python3
"""Builds web/index.html from the original MyCellar page (read-only source) by swapping the
storage layer for the API, and adding login + account. Usage: build-web.py <original index.html> <out>"""
import sys, re, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lookup_patch, pin_patch, saves_patch, audit_patch, lookup_skip_patch
src = open(sys.argv[1], encoding='utf-8').read()

def cut(s, start, end, new):
    a = s.index(start); b = s.index(end, a)
    return s[:a] + new + s[b:]

# 1. head: drop the Supabase script comment, add Google sign-in script
src = src.replace("""  <!-- SUPABASE: uncomment when you fill in credentials below -->
  <!-- <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script> -->
""", """  <script src="https://accounts.google.com/gsi/client" async defer></script>
""")
src = src.replace("const { useState, useEffect, useContext, createContext, useMemo } = React;",
                  "const { useState, useEffect, useContext, createContext, useMemo, useRef } = React;")

# 2. config + storage -> API layer
DATA_LAYER = r"""    // ═══════════════════════════════════════════════════════════════════════
    //  CONFIG — public identifiers only. No secrets belong in this file.
    // ═══════════════════════════════════════════════════════════════════════
    const API_BASE         = 'https://mycellar-api.YOUR-SUBDOMAIN.workers.dev';
    const GOOGLE_CLIENT_ID = '';   // from Google Cloud; the sign-in button stays hidden until set
    const MS_CLIENT_ID     = '';   // Microsoft button is hidden while this is empty
    const SESSION_KEY      = 'mycellar-session-v1';   // unique per app: every app on github.io shares one origin
    // ═══════════════════════════════════════════════════════════════════════

    // ─── API ──────────────────────────────────────────────────────────────
    // The Worker's error bodies carry only a code ({error}); the page turns every code it can receive into a sentence.
    const ERROR_TEXT = {
      body_too_large: 'That is too much data to send at once. Try a smaller change.',
      invalid: 'Some of that information is not valid, so it was not saved.',
      invalid_json: 'Something went wrong sending that. Please try again.',
      invalid_nonce: 'Sign-in could not be checked. Please try again.',
      invalid_token: 'Sign-in could not be checked. Please try again.',
      unauthorized: 'Your session has ended. Please sign in again.',
      not_found: 'That item no longer exists.',
      method_not_allowed: 'Something went wrong sending that. Please try again.',
      conflict: 'This was changed on another device or tab.',
      forbidden: 'You are not allowed to do that.',
      not_invited: "That email address hasn't been invited to this cellar.",
      email_not_verified: 'Google reports that email address as not verified.',
      account_already_linked: 'That email is already linked to a different account.',
      provider_not_configured: 'Sign-in is not available yet.',
      origin_not_allowed: 'This page is not allowed to use the sign-in service.',
      internal: 'The server had a problem. Please try again in a moment.',
    };
    class ApiError extends Error {
      constructor(status, code, message) { super(ERROR_TEXT[code] || message || code); this.status = status; this.code = code; }
    }
    const session = {
      get() { try { const r = localStorage.getItem(SESSION_KEY); const s = r ? JSON.parse(r) : null; return s && s.token ? s : null; } catch { return null; } },
      set(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {} },
      clear() { try { localStorage.removeItem(SESSION_KEY); } catch {} },
    };
    let onUnauthorized = () => {};
    async function api(method, path, body) {
      const s = session.get();
      const headers = {};
      if (s) headers.Authorization = 'Bearer ' + s.token;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let res;
      try { res = await fetch(API_BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }); }
      catch { throw new ApiError(0, 'network', 'Could not reach the server. Check your connection.'); }
      let data = null; try { data = await res.json(); } catch {}
      if (!res.ok) {
        if (res.status === 401 && s) onUnauthorized();
        throw new ApiError(res.status, (data && data.error) || 'error', data && data.message);
      }
      return data;
    }

    // Data model: drinks[] where each drink has embedded stock[]. Money is whole cents on
    // the server (price_cents); the page keeps dollars in `price`, and `_v` is the version
    // the server last gave us (a stale edit is refused with a 409).
    const toCents = p => (p === null || p === undefined || p === '') ? null : Math.round(Number(p) * 100);
    const fromApiDrink = ({ version, price_cents, ...d }) => ({ ...d, price: price_cents == null ? null : price_cents / 100, _v: version });
    const toApiDrink = ({ _v, price, ...d }) => ({ ...d, price_cents: toCents(price) });

    const store = {
      async load() { const r = await api('GET', '/cellar'); return { drinks: r.drinks.map(fromApiDrink), settings: r.settings }; },
      async upsert(d) { const r = await api('PUT', '/drinks/' + encodeURIComponent(d.id), { drink: toApiDrink(d), version: d._v ?? null }); return { ...d, _v: r.version }; },
      // Atomic per request of up to 50 drinks.
      async upsertMany(ds) {
        const out = [];
        for (let i = 0; i < ds.length; i += 50) {
          const chunk = ds.slice(i, i + 50);
          const r = await api('POST', '/drinks/bulk', { items: chunk.map(d => ({ drink: toApiDrink(d), version: d._v ?? null })) });
          const vm = new Map(r.versions.map(v => [v.id, v.version]));
          chunk.forEach(d => out.push({ ...d, _v: vm.get(d.id) }));
        }
        return out;
      },
      async remove(d) { await api('DELETE', '/drinks/' + encodeURIComponent(d.id) + (d._v ? '?version=' + d._v : '')); },
      async saveSettings(patch, version) { const r = await api('PUT', '/settings', { ...patch, version }); return r.version; },
      op(name, body) { return api('POST', '/ops/' + name, body || {}); },
    };

"""
src = cut(src, "    // ═══════════════════════════════════════════════════════════════════════\n    //  CONFIG", "    // ─── Constants", DATA_LAYER)

# 3. sidebar footer: show who is signed in
src = src.replace("function Sidebar({ view, onNav, onAdd, drinks }) {", "function Sidebar({ view, onNav, onAdd, drinks, user }) {")
src = src.replace("""<div style={{fontSize:'9px',color:'#6A5040',textTransform:'uppercase',letterSpacing:'.06em'}}>{STORAGE_MODE} storage</div>""",
                  """<div title={user.email} style={{fontSize:'10px',color:'#6A5040',letterSpacing:'.02em',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:'170px'}}>{user.name || user.email}</div>""")
src = src.replace("<Sidebar view={view} onNav={navTo} onAdd={startAdd} drinks={drinks}/>", "<Sidebar view={view} onNav={navTo} onAdd={startAdd} drinks={drinks} user={user}/>")

# 4. Account box in settings
ACCOUNT = r"""    function AccountBox({ user, onRename, onSignOut, onDelete }) {
      const [name, setName] = useState(user.name || '');
      const [msg, setMsg] = useState('');
      const [del, setDel] = useState(false);
      const [phrase, setPhrase] = useState('');
      async function save() {
        try { await onRename(name.trim()); setMsg('Saved'); } catch (e) { setMsg(e.message || 'Could not save'); }
      }
      return (
        <div style={{marginBottom:'28px',border:'1px solid #1C1208',borderRadius:'8px',padding:'14px 16px',background:'#0F0906'}}>
          <div style={{fontSize:'13px',fontWeight:'600',color:'#C0A890'}}>Account</div>
          <div style={{fontSize:'11px',color:'#5A4030',margin:'2px 0 12px'}}>Signed in as {user.email}</div>
          <div style={{display:'flex',gap:'8px',marginBottom:'6px'}}>
            <input value={name} onChange={e=>{setName(e.target.value);setMsg('');}} placeholder="Display name" maxLength={80}/>
            <Btn onClick={save} disabled={!name.trim()} style={{fontSize:'12px',padding:'7px 14px',flexShrink:0}}>Save</Btn>
          </div>
          <div style={{fontSize:'11px',color:'#7A5840',minHeight:'14px',marginBottom:'10px'}}>{msg}</div>
          <div style={{display:'flex',gap:'8px',flexWrap:'wrap'}}>
            <Btn onClick={onSignOut} style={{fontSize:'12px',padding:'7px 14px'}}>Sign out</Btn>
            <Btn onClick={()=>setDel(!del)} style={{fontSize:'12px',padding:'7px 14px',color:'#C8602A'}}>Delete my account</Btn>
          </div>
          {del && (
            <div style={{marginTop:'12px',paddingTop:'12px',borderTop:'1px solid #1C1208'}}>
              <p style={{fontSize:'12px',color:'#8A7060',lineHeight:'1.6',marginBottom:'10px'}}>This permanently deletes your account and everything in your cellar: drinks, tasting notes, ratings, locations. There is no undo.</p>
              <div style={{fontSize:'12px',color:'#6A5040',marginBottom:'8px'}}>Type <strong style={{color:'#C8602A',fontFamily:'monospace'}}>DELETE ACCOUNT</strong> to confirm:</div>
              <div style={{display:'flex',gap:'8px'}}>
                <input value={phrase} onChange={e=>setPhrase(e.target.value)} placeholder="DELETE ACCOUNT" style={{fontFamily:'monospace'}}/>
                <Btn onClick={onDelete} disabled={phrase.trim().toUpperCase()!=='DELETE ACCOUNT'}
                  style={{fontSize:'12px',padding:'7px 14px',flexShrink:0,background:phrase.trim().toUpperCase()==='DELETE ACCOUNT'?'#8B2020':'#160E08',color:phrase.trim().toUpperCase()==='DELETE ACCOUNT'?'#F0E6D3':'#3A2818'}}>Delete</Btn>
              </div>
            </div>
          )}
        </div>
      );
    }

"""
src = src.replace("    function SettingsView({ onClose, onDangerOp, onUpdateScale }) {", ACCOUNT + "    function SettingsView({ onClose, onDangerOp, onUpdateScale, user, onRename, onSignOut, onDeleteAccount }) {")
src = src.replace("""          <div style={{padding:'16px 18px',maxWidth:'580px'}}>

            {/* Rating Scale Editor */}""", """          <div style={{padding:'16px 18px',maxWidth:'580px'}}>

            <AccountBox user={user} onRename={onRename} onSignOut={onSignOut} onDelete={onDeleteAccount}/>

            {/* Rating Scale Editor */}""")
src = src.replace("<SettingsView onClose={()=>navTo('cellar')} onDangerOp={handleDangerOp} onUpdateScale={updateScale}/>",
                  "<SettingsView onClose={()=>navTo('cellar')} onDangerOp={handleDangerOp} onUpdateScale={updateScale} user={user} onRename={renameUser} onSignOut={onSignOut} onDeleteAccount={deleteAccount}/>")

# 5. App: state, loading, persistence
a = src.index("    function App() {")
b = src.index("      // Stock operations")
APP_TOP = r"""    function App({ user, onSignOut, onUserChange }) {
      const [drinks,    setDrinks]    = useState([]);
      const [locations, setLocations] = useState(DEFAULT_LOCATIONS);
      const [scale,     setScale]     = useState(DEFAULT_SCALE);
      const [view,      setView]      = useState('cellar');
      const [editing,   setEditing]   = useState(null);
      const [selected,  setSelected]  = useState(null);
      const [loading,   setLoading]   = useState(true);
      const [appError,  setAppError]  = useState(null);
      const settingsVer   = useRef(0);
      const settingsChain = useRef(Promise.resolve());
      const scaleTimer    = useRef(null);

      function applyCellar({ drinks, settings }) {
        setDrinks(drinks);
        settingsVer.current = settings.version;
        // System locations always come fresh from defaults — they can't be user-edited.
        const systemLocs = DEFAULT_LOCATIONS.filter(l => l.system);
        setLocations(settings.locations ? [...settings.locations.filter(l => !l.system), ...systemLocs] : DEFAULT_LOCATIONS);
        setScale(settings.scale || DEFAULT_SCALE);
      }
      async function reload() {
        try { applyCellar(await store.load()); setSelected(null); }
        catch (e) { setAppError(e.message || 'Could not load your cellar.'); }
      }
      // 409 = this item was changed elsewhere (another tab or device): reload so the next try is current.
      async function fail(e, fallback) {
        if (e instanceof ApiError && e.status === 409) {
          setAppError('This was changed on another device or tab. Your cellar has been reloaded, please try again.');
          setEditing(null); setView('cellar');
          await reload();
        } else setAppError(e instanceof ApiError && (e.code === 'network' || ERROR_TEXT[e.code]) ? e.message : fallback);
      }

      useEffect(() => {
        (async () => {
          try { applyCellar(await store.load()); }
          catch (e) { setAppError(e.message || 'Could not load your cellar.'); }
          setLoading(false);
        })();
      }, []);

      // Saves one drink and puts the server's new version on it. Returns the saved drink or null.
      async function persistDrink(updated) {
        try {
          const saved = await store.upsert(updated);
          setDrinks(prev => prev.some(d => d.id === saved.id) ? prev.map(d => d.id === saved.id ? saved : d) : [...prev, saved]);
          return saved;
        } catch (e) { await fail(e, 'Failed to save. Check your connection and try again.'); return null; }
      }
      async function saveDrink(drink) {
        const saved = await persistDrink(drink);
        if (saved) { setEditing(null); setView('cellar'); }
      }
      async function removeDrink(id) {
        const d = drinks.find(x => x.id === id);
        try {
          await store.remove(d || { id });
          setDrinks(prev => prev.filter(x => x.id !== id));
          setSelected(null);
        } catch (e) { await fail(e, 'Failed to delete drink. Check your connection and try again.'); }
      }

"""
src = src[:a] + APP_TOP + src[b:]

# stock ops: persist through persistDrink
blockA = """        try {
          await store.upsert(updated);
          setDrinks(prev => prev.map(d=>d.id===drinkId?updated:d));
          setSelected(updated);
        } catch(e) { setAppError('Failed to save. Check your connection.'); }"""
assert blockA in src
src = src.replace(blockA, """        const saved = await persistDrink(updated);
        if (saved) setSelected(saved);""")
blockB = """        await store.upsert(updated);
        setDrinks(prev => prev.map(d=>d.id===drinkId?updated:d));
        setSelected(updated);"""
assert src.count(blockB) == 3
src = src.replace(blockB, """        const saved = await persistDrink(updated);
        if (saved) setSelected(saved);""")

# settings, bulk save, danger ops
a = src.index("      function updateLocations(nl)")
b = src.index("      function navTo(v)")
APP_MID = r"""      // Settings saves go through one queue so each uses the version the last one returned.
      function saveSettings(patch) {
        settingsChain.current = settingsChain.current.then(async () => {
          try { settingsVer.current = await store.saveSettings(patch, settingsVer.current); }
          catch (e) { await fail(e, 'Failed to save settings. Check your connection.'); }
        });
        return settingsChain.current;
      }
      function updateLocations(nl) { setLocations(nl); saveSettings({ locations: nl.filter(l => !l.system) }); }
      function updateScale(ns) {
        setScale(ns);
        clearTimeout(scaleTimer.current);
        scaleTimer.current = setTimeout(() => saveSettings({ scale: ns }), 700);   // typing in the chips saves once, not per keystroke
      }
      // Batch-save multiple drinks (used when migrating orphaned stock to Unassigned)
      async function saveDrinks(drinkList) {
        try {
          const saved = await store.upsertMany(drinkList);
          const map = new Map(saved.map(d => [d.id, d]));
          setDrinks(prev => prev.map(d => map.get(d.id) || d));
        } catch (e) { await fail(e, 'Failed to move bottles. Check your connection.'); throw e; }
      }
      // The bulk operations run on the server in one atomic step; then we reload.
      async function handleDangerOp(id) {
        try {
          if      (id === 'unassign')     await store.op('unassign');
          else if (id === 'clearstock')   await store.op('clearstock');
          else if (id === 'clearall')     await store.op('clearstock', { locations: [] });
          else if (id === 'deletedrinks') await store.op('delete-drinks');
          else if (id === 'factory')      await store.op('delete-drinks', { locations: [] });
          else if (id === 'demo')         await store.op('replace-all', { drinks: SAMPLE_DRINKS.map(toApiDrink), locations: DEFAULT_LOCATIONS.filter(l => !l.system) });
          await reload();
          setView('cellar');
        } catch(e) { await fail(e, 'Operation failed. Please try again.'); }
      }
      async function renameUser(name) {
        try { const r = await api('PATCH', '/me', { name, version: user.version }); onUserChange(r.user); }
        catch (e) { throw new Error(e.status === 409 ? 'Your profile changed elsewhere. Sign in again.' : (e.message || 'Could not save')); }
      }
      async function deleteAccount() {
        try { await api('DELETE', '/me'); session.clear(); window.location.reload(); }
        catch (e) { setAppError('Could not delete the account. Try again.'); }
      }
"""
src = src[:a] + APP_MID + src[b:]

# 6. login + root
a = src.index("    ReactDOM.createRoot(document.getElementById('root'))")
b = src.index("  </script>", a)
ROOT = r"""    // ─── Sign-in ──────────────────────────────────────────────────────────
    const SIGNIN_ERRORS = {
      not_invited: "That email address hasn't been invited to this cellar.",
      email_not_verified: 'Google reports that email address as not verified.',
      account_already_linked: 'That email is already linked to a different account.',
      token_expired: 'Sign-in took too long. Please try again.',
      origin_not_allowed: 'This page is not allowed to use the sign-in service.',
      invalid_token: 'Sign-in could not be checked. Please try again.',
      provider_not_configured: 'Sign-in is not available yet.',
    };
    function LoginScreen({ onSignedIn }) {
      const [err, setErr]   = useState(null);
      const [busy, setBusy] = useState(false);
      const btnRef = useRef(null);
      async function exchange(path, idToken, nonce) {
        setBusy(true); setErr(null);
        try { onSignedIn(await api('POST', path, nonce ? { idToken, nonce } : { idToken })); }
        catch (e) { setErr(SIGNIN_ERRORS[e.code] || e.message || 'Sign-in failed.'); setBusy(false); }
      }
      useEffect(() => {
        if (!GOOGLE_CLIENT_ID) return;
        let tries = 0;
        const t = setInterval(() => {
          if (window.google && window.google.accounts && window.google.accounts.id) {
            clearInterval(t);
            window.google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: r => exchange('/auth/google', r.credential) });
            if (btnRef.current) window.google.accounts.id.renderButton(btnRef.current, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', width: 260 });
          } else if (++tries > 100) clearInterval(t);
        }, 100);
        return () => clearInterval(t);
      }, []);
      // Microsoft (personal accounts) returns an id_token in the URL fragment.
      useEffect(() => {
        if (!MS_CLIENT_ID || !window.location.hash.includes('id_token=')) return;
        const p = new URLSearchParams(window.location.hash.slice(1));
        const tok = p.get('id_token');
        let nonce = null; try { nonce = sessionStorage.getItem('mycellar-ms-nonce'); } catch {}
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
        try {
          const claims = JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
          if (!nonce || claims.nonce !== nonce || p.get('state') !== nonce) { setErr('Sign-in could not be verified. Please try again.'); return; }
        } catch { setErr('Sign-in failed.'); return; }
        exchange('/auth/microsoft', tok, nonce);
      }, []);
      function startMicrosoft() {
        const nonce = uid() + uid();
        try { sessionStorage.setItem('mycellar-ms-nonce', nonce); } catch {}
        window.location.href = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?' + new URLSearchParams({
          client_id: MS_CLIENT_ID, response_type: 'id_token', redirect_uri: window.location.origin + window.location.pathname,
          response_mode: 'fragment', scope: 'openid profile email', nonce, state: nonce });
      }
      return (
        <div style={{display:'flex',height:'100%',alignItems:'center',justifyContent:'center',background:'#0C0806',padding:'24px'}}>
          <div style={{maxWidth:'340px',width:'100%',textAlign:'center'}}>
            <div style={{fontSize:'44px',marginBottom:'8px'}}>🍾</div>
            <h1 style={{fontFamily:"'Playfair Display', serif",fontSize:'30px',fontWeight:'700',color:'#F0E6D3'}}>My Cellar</h1>
            <p style={{color:'#7A5840',fontSize:'13px',margin:'8px 0 28px',lineHeight:'1.6'}}>Sign in to open your cellar.</p>
            {busy && <div style={{color:'#C8922A',fontSize:'13px',marginBottom:'16px'}}>Signing you in…</div>}
            <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:'12px',opacity:busy?0.4:1,pointerEvents:busy?'none':'auto'}}>
              {GOOGLE_CLIENT_ID && <div ref={btnRef}/>}
              {MS_CLIENT_ID && <Btn onClick={startMicrosoft} style={{width:'260px',padding:'10px 16px',borderRadius:'20px'}}>Sign in with Microsoft</Btn>}
              {!GOOGLE_CLIENT_ID && !MS_CLIENT_ID && <div style={{color:'#8A6040',fontSize:'12px'}}>Sign-in is not set up yet.</div>}
            </div>
            {err && <div style={{marginTop:'20px',background:'#2A0808',border:'1px solid #8B2020',color:'#E88080',padding:'10px 14px',borderRadius:'8px',fontSize:'12px',lineHeight:'1.5'}}>{err}</div>}
          </div>
        </div>
      );
    }

    function Root() {
      const [sess, setSess] = useState(() => session.get());
      useEffect(() => { onUnauthorized = () => { session.clear(); setSess(null); }; }, []);
      // The sign-in reply carries no profile version, so fetch it once for the rename stale-edit check.
      useEffect(() => { if (sess && sess.user.version == null) api('GET', '/me').then(r => userChanged(r.user)).catch(() => {}); }, [sess && sess.token]);
      function signedIn(r) { session.set({ token: r.token, user: r.user }); setSess(session.get()); }
      async function signOut() { try { await api('POST', '/me/logout', {}); } catch {} session.clear(); setSess(null); }
      function userChanged(u) { const s = { ...sess, user: u }; session.set(s); setSess(s); }
      if (!sess) return <LoginScreen onSignedIn={signedIn}/>;
      return <App key={sess.user.id} user={sess.user} onSignOut={signOut} onUserChange={userChanged}/>;
    }

    ReactDOM.createRoot(document.getElementById('root')).render(<ErrorBoundary><Root/></ErrorBoundary>);
"""
src = src[:a] + ROOT + src[b:]

# 7. drop the Supabase setup comment at the bottom
a = src.index("  <!--\n  SUPABASE SETUP")
b = src.index("  -->", a) + len("  -->\n")
src = src[:a] + src[b:]

# 8. the Look up details button
src = lookup_patch.apply(src)

# 9. pin the CDN scripts (exact versions + integrity hashes)
src = pin_patch.apply(src)

# 10. saves never overlap, settings retries, flush on close, 401 notice
src = saves_patch.apply(src)

# 11. audit fixes (delete confirmation, load failure screen, 409 keeps the form, local dates, export, text colours, ...)
src = audit_patch.apply(src)
src = lookup_skip_patch.apply(src)   # 12. no AI call when there is nothing to fill

open(sys.argv[2], 'w', encoding='utf-8').write(src)
for bad in ('supabase', 'Supabase', 'SUPABASE', 'STORAGE_MODE', 'localStore', 'locStore', 'scaleStore'):
    assert bad not in src, bad
print('ok', len(src))
