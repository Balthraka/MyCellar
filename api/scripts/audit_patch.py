"""Page fixes from the full audit of 2026-11-22 (applied by build-web.py after saves_patch.py, and once to web/index.html).

Each edit must match exactly once, so a changed page makes this fail loudly instead of half-applying.
  1. Btn passes `disabled` to the real button; account deletion checks the exact phrase itself and cannot run twice
  2. a failed first load shows "could not open your cellar" with Try again (not an empty cellar)
  3. a 409 on the edit form keeps the form open (Save again replaces the other change, Cancel keeps it)
  4. dates are the person's local date, not UTC
  5. a new whisky defaults to the Whisky Globe (the id is whisky-globe)
  6. Manage Locations saves go through the save queue
  7. Settings: "Download my data", invite-needed wording on account deletion
  8. Google script blocked: a message instead of silence
  9. inputs are 16px on phones (stops iPhone zoom on tap)
 10. text colours only: low-contrast text made readable; danger-zone phrases and buttons readable
"""
import re

# text colour -> lighter muted colour (contrast >= 4.7 on the panel colour #1C1208). Only used inside `color:` properties.
TEXT_MAP = {
    '#1A1008': '#90806B', '#2A1808': '#94816A', '#3A2818': '#94816A', '#4A3020': '#9A836C', '#4A3828': '#97846D',
    '#5A4030': '#9C856E', '#6A5030': '#9E8768', '#6A5040': '#9E8771', '#7A5840': '#A3886E', '#7A6050': '#A18A75',
    '#8A6040': '#AA896B', '#8A6A50': '#A88C71', '#8A7060': '#A68E7A',
    '#5070A0': '#607EAA', '#3A4A60': '#73839A', '#6A8A3A': '#8DAB60',
}


def rep(src, old, new, count=1):
    n = src.count(old)
    assert n == count, f'expected {count} match(es), found {n}: {old[:70]!r}'
    return src.replace(old, new)


def apply(src):
    # 1. Btn
    src = rep(src, "function Btn({ onClick, variant='ghost', style:sx, children }) {", "function Btn({ onClick, variant='ghost', style:sx, disabled, children }) {")
    src = rep(src, "return <button onClick={onClick} style={{padding:'6px 13px',borderRadius:'5px',fontSize:'12px',...v[variant],...sx}}>{children}</button>;",
              "return <button onClick={onClick} disabled={disabled} style={{padding:'6px 13px',borderRadius:'5px',fontSize:'12px',...v[variant],...sx,...(disabled?{cursor:'not-allowed'}:{})}}>{children}</button>;")

    # 7 + 1. AccountBox: exact phrase, no double run, export button, invite wording
    a = src.index('    function AccountBox(')
    b = src.index('    function SettingsView(')
    src = src[:a] + ACCOUNT_BOX + '\n' + src[b:]
    src = rep(src, "function SettingsView({ onClose, onDangerOp, onUpdateScale, user, onRename, onSignOut, onDeleteAccount }) {",
              "function SettingsView({ onClose, onDangerOp, onUpdateScale, user, onRename, onSignOut, onDeleteAccount, onExport }) {")
    src = rep(src, "<AccountBox user={user} onRename={onRename} onSignOut={onSignOut} onDelete={onDeleteAccount}/>",
              "<AccountBox user={user} onRename={onRename} onSignOut={onSignOut} onDelete={onDeleteAccount} onExport={onExport}/>")
    src = rep(src, "onSignOut={onSignOut} onDeleteAccount={deleteAccount}/>}",
              "onSignOut={onSignOut} onDeleteAccount={deleteAccount} onExport={exportData}/>}")
    src = rep(src, "      async function deleteAccount() {",
              EXPORT_FN + "      async function deleteAccount() {")

    # 2. first load failure
    src = rep(src, "      const [appError,  setAppError]  = useState(null);\n",
              "      const [appError,  setAppError]  = useState(null);\n      const [loadFailed, setLoadFailed] = useState(null);\n      const conflictId = useRef(null);\n")
    src = rep(src, """      useEffect(() => {
        (async () => {
          try { applyCellar(await store.load()); }
          catch (e) { setAppError(e.message || 'Could not load your cellar.'); }
          setLoading(false);
        })();
      }, []);
""", """      async function openCellar() {
        setLoading(true); setLoadFailed(null);
        try { applyCellar(await store.load()); }
        catch (e) { setLoadFailed(e.message || 'Could not load your cellar.'); }
        setLoading(false);
      }
      useEffect(() => { openCellar(); }, []);
""")
    src = rep(src, "      const sp = { drinks, selected,", LOAD_FAILED_SCREEN + "      const sp = { drinks, selected,")

    # 3. 409 on the form keeps the form
    src = rep(src, """      async function persistNow(updated) {
        // Only this tab's own earlier save can make the held copy newer than the form's copy (a double click), so use its version.
        const cur = drinksRef.current.find(d => d.id === updated.id);
        const toSave = cur && cur._v != null && cur._v > (updated._v ?? 0) ? { ...updated, _v: cur._v } : updated;
        try {
          const saved = await store.upsert(toSave);
          setDrinksNow(prev => prev.some(d => d.id === saved.id) ? prev.map(d => d.id === saved.id ? saved : d) : [...prev, saved]);
          return saved;
        } catch (e) { await fail(e, 'Failed to save. Check your connection and try again.'); return null; }
      }
      const persistDrink = updated => enqueue(() => persistNow(updated));""",
              """      // keepForm: the save comes from the Add/Edit form. On a 409 the form stays open with what was typed; the cellar is reloaded, and
      // pressing Save again then replaces the other change (the held copy is newer, so its version is used) while Cancel keeps it.
      async function persistNow(updated, keepForm) {
        // Only this tab's own earlier save (a double click), or the reload after a 409 on the form, can make the held copy newer than the form's copy.
        const cur = drinksRef.current.find(d => d.id === updated.id);
        let toSave = cur && cur._v != null && cur._v > (updated._v ?? 0) ? { ...updated, _v: cur._v } : updated;
        if (!cur && conflictId.current === updated.id) toSave = { ...updated, _v: null };   // deleted elsewhere: Save adds it again
        try {
          const saved = await store.upsert(toSave);
          setDrinksNow(prev => prev.some(d => d.id === saved.id) ? prev.map(d => d.id === saved.id ? saved : d) : [...prev, saved]);
          if (conflictId.current === saved.id) { conflictId.current = null; setAppError(m => (m && m.indexOf('This drink was changed') === 0 ? null : m)); }
          return saved;
        } catch (e) {
          if (keepForm && e instanceof ApiError && e.status === 409) {
            conflictId.current = updated.id;
            await reload();
            setAppError('This drink was changed on another device or tab. Your changes are still in the form. Press Save again to replace the other change with yours, or Cancel to keep the other change.');
            return null;
          }
          await fail(e, 'Failed to save. Check your connection and try again.'); return null;
        }
      }
      const persistDrink = (updated, keepForm) => enqueue(() => persistNow(updated, keepForm));""")
    src = rep(src, "        const saved = await persistDrink(drink);\n        if (saved) { setEditing(null); setView('cellar'); }",
              "        const saved = await persistDrink(drink, true);\n        if (saved) { setEditing(null); setView('cellar'); }")

    # 4. local dates
    src = rep(src, "const today = () => new Date().toISOString().split('T')[0];",
              "const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };   // the person's own date, not UTC")

    # 5. whisky default location
    src = rep(src, "'whiskey-globe'", "'whisky-globe'", count=2)

    # 6. saveDrinks through the queue
    src = rep(src, """      async function saveDrinks(drinkList) {
        try {
          const saved = await store.upsertMany(drinkList);
          const map = new Map(saved.map(d => [d.id, d]));
          setDrinksNow(prev => prev.map(d => map.get(d.id) || d));
        } catch (e) { await fail(e, 'Failed to move bottles. Check your connection.'); throw e; }
      }""", """      // Goes through the same queue as every other drink save, and uses the newest version of each drink this tab holds.
      function saveDrinks(drinkList) {
        return enqueue(async () => {
          try {
            const list = drinkList.map(d => { const cur = drinksRef.current.find(x => x.id === d.id); return cur && cur._v != null && cur._v > (d._v ?? 0) ? { ...d, _v: cur._v } : d; });
            const saved = await store.upsertMany(list);
            const map = new Map(saved.map(d => [d.id, d]));
            setDrinksNow(prev => prev.map(d => map.get(d.id) || d));
          } catch (e) { await fail(e, 'Failed to move bottles. Check your connection.'); throw e; }
        });
      }""")

    # 8. Google script blocked
    src = rep(src, "          } else if (++tries > 100) clearInterval(t);",
              "          } else if (++tries > 100) { clearInterval(t); setErr('Google sign-in could not load. An ad blocker or a network filter may be blocking it. Try another browser or network.'); }")

    # 9. 16px inputs on phones
    src = rep(src, "      .det-close { display: none; } .det-back { display: block; }\n    }",
              "      .det-close { display: none; } .det-back { display: block; }\n      input, textarea, select { font-size: 16px !important; }   /* below 16px an iPhone zooms in when a field is tapped */\n    }")

    # 10. colours (text only)
    src = rep(src, "title:'Clear stock and wipe locations',", "title:'Clear stock and wipe locations',")  # (anchor check: exists)
    src = rep(src, "    function AccountBox(", DANGER_TEXT + "    function AccountBox(")
    src = rep(src, "color: active===o.id ? o.color : '#C0A890'", "color: active===o.id ? DANGER_TEXT[o.id][0] : '#C0A890'")
    src = rep(src, "Type <strong style={{color:o.color,fontFamily:'monospace'}}>", "Type <strong style={{color:DANGER_TEXT[o.id][0],fontFamily:'monospace'}}>")
    src = rep(src, "color:confirmed?'#0C0806':'#3A2818',border:", "color:confirmed?DANGER_TEXT[o.id][1]:'#3A2818',border:")

    def fix(m):
        return re.sub(r'#[0-9A-Fa-f]{6}\b', lambda h: TEXT_MAP.get(h.group(0).upper(), h.group(0)), m.group(0))
    src = re.sub(r'(?<![A-Za-z.])color\s*:\s*[^,}]*', fix, src)
    return src


DANGER_TEXT = """    // Text colours for the danger-zone titles, phrases and buttons (the accent colours in DANGER_OPS stay for borders and backgrounds):
    // [text on the dark panel, text on the confirm button]
    const DANGER_TEXT = { unassign:['#C8922A','#0C0806'], clearstock:['#C8602A','#0C0806'], clearall:['#E06060','#F0E6D3'],
      deletedrinks:['#E06060','#F0E6D3'], factory:['#E85555','#F0E6D3'], demo:['#6BA3C8','#F0E6D3'] };

"""

ACCOUNT_BOX = """    function AccountBox({ user, onRename, onSignOut, onDelete, onExport }) {
      const [name, setName] = useState(user.name || '');
      const [msg, setMsg] = useState('');
      const [del, setDel] = useState(false);
      const [phrase, setPhrase] = useState('');
      const [busy, setBusy] = useState(false);
      // The exact phrase (surrounding spaces ignored). The Delete button is disabled until it matches, and doDelete checks it again.
      const confirmed = phrase.trim() === 'DELETE ACCOUNT';
      async function save() {
        if (!name.trim()) return;
        try { await onRename(name.trim()); setMsg('Saved'); } catch (e) { setMsg(e.message || 'Could not save'); }
      }
      async function doExport() {
        try { await onExport(); setMsg('Your data was downloaded.'); } catch (e) { setMsg(e.message || 'Could not download your data.'); }
      }
      async function doDelete() {
        if (!confirmed || busy) return;
        setBusy(true);
        try { await onDelete(); } finally { setBusy(false); }
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
            <Btn onClick={doExport} style={{fontSize:'12px',padding:'7px 14px'}}>Download my data</Btn>
            <Btn onClick={()=>setDel(!del)} style={{fontSize:'12px',padding:'7px 14px',color:'#C8602A'}}>Delete my account</Btn>
          </div>
          {del && (
            <div style={{marginTop:'12px',paddingTop:'12px',borderTop:'1px solid #1C1208'}}>
              <p style={{fontSize:'12px',color:'#8A7060',lineHeight:'1.6',marginBottom:'10px'}}>This permanently deletes your account and everything in your cellar: drinks, tasting notes, ratings, locations. There is no undo. To use My Cellar again you would need a new invitation.</p>
              <div style={{fontSize:'12px',color:'#6A5040',marginBottom:'8px'}}>Type <strong style={{color:'#C8602A',fontFamily:'monospace'}}>DELETE ACCOUNT</strong> to confirm:</div>
              <div style={{display:'flex',gap:'8px'}}>
                <input value={phrase} onChange={e=>setPhrase(e.target.value)} placeholder="DELETE ACCOUNT" style={{fontFamily:'monospace'}}/>
                <Btn onClick={doDelete} disabled={!confirmed||busy}
                  style={{fontSize:'12px',padding:'7px 14px',flexShrink:0,background:confirmed&&!busy?'#8B2020':'#160E08',color:confirmed&&!busy?'#F0E6D3':'#3A2818'}}>{busy?'Deleting...':'Delete'}</Btn>
              </div>
            </div>
          )}
        </div>
      );
    }
"""

EXPORT_FN = """      // Downloads everything in the same shape scripts/import-local.mjs reads (drinks with prices in dollars, locations, rating scale).
      async function exportData() {
        const r = await api('GET', '/cellar');
        const data = { app: 'My Cellar', exportedAt: new Date().toISOString(),
          drinks: r.drinks.map(fromApiDrink).map(({ _v, ...d }) => d),
          locations: (r.settings.locations || []), scale: r.settings.scale || null };
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = 'my-cellar-' + today() + '.json';
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
"""

LOAD_FAILED_SCREEN = """      if (loadFailed) return (
        <div style={{display:'flex',height:'100%',alignItems:'center',justifyContent:'center',background:'#0C0806',padding:'24px'}}>
          <div style={{maxWidth:'340px',width:'100%',textAlign:'center'}}>
            <div style={{fontFamily:"'Playfair Display', serif",fontSize:'20px',color:'#C8922A',marginBottom:'10px'}}>Could not open your cellar</div>
            <p style={{color:'#A68E7A',fontSize:'13px',lineHeight:'1.6',marginBottom:'18px'}}>{loadFailed} Your data is safe; it just could not be loaded.</p>
            <div style={{display:'flex',gap:'10px',justifyContent:'center'}}>
              <Btn onClick={openCellar} variant="primary" style={{padding:'9px 20px',fontSize:'13px'}}>Try again</Btn>
              <Btn onClick={onSignOut} style={{padding:'9px 20px',fontSize:'13px'}}>Sign out</Btn>
            </div>
          </div>
        </div>
      );
"""
