"""Adds the "Look up details" button (POST /lookup) to the page. Used by build-web.py and applied once to web/index.html."""

ERR_ANCHOR = "      internal: 'The server had a problem. Please try again in a moment.',\n"
ERR_NEW = ERR_ANCHOR + (
    "      lookup_limit: \"You have used today's lookups. Try again tomorrow, or fill the details in yourself.\",\n"
    "      lookup_unavailable: 'Look up is not available right now. You can fill the details in yourself.',\n")

FORM_ANCHOR = "    function AddEditView({ drink, onSave, onCancel }) {\n"
COMPONENT = r"""    // "Look up details": asks the Worker for suggestions and fills EMPTY fields only. Nothing is overwritten and nothing is saved
    // until the person saves the drink. Facts only (no ratings, prices or tasting notes).
    const LOOKUP_LABELS = { wineColor:'colour', grape:'grape', region:'region', appellation:'appellation', whiskyStyle:'style', whiskyRegion:'region' };
    function LookupBar({ form, setForm, isNew }) {
      const [state, setState] = useState({ phase:'idle', text:'' });
      const can = String(form.name||'').trim().length > 1 && state.phase !== 'busy';
      async function run() {
        setState({ phase:'busy', text:'' });
        try {
          const r = await api('POST', '/lookup', { type: form.type, name: String(form.name).trim(), producer: String(form.producer||'').trim() });
          const s = (r && r.suggestions) || {};
          const filled = [];
          setForm(f => {
            const u = { ...f };
            // Colour and style start on a default (red, bourbon), so on a NEW drink a value still equal to the default counts as unset.
            const unset = k => !u[k] || (isNew && (k === 'wineColor' || k === 'whiskyStyle') && u[k] === EMPTY_FORM[k]);
            for (const k of Object.keys(LOOKUP_LABELS)) if (s[k] && unset(k)) { u[k] = s[k]; filled.push(LOOKUP_LABELS[k]); }
            return u;
          });
          setTimeout(() => setState({ phase:'done', text: filled.length ? 'Suggested: ' + filled.join(', ') + '. Check before saving.' : 'Nothing to add: no confident suggestion, or those fields are already filled.' }), 0);
        } catch (e) {
          setState({ phase:'error', text: e instanceof ApiError ? e.message : 'Look up failed. Please try again.' });
        }
      }
      return (
        <div style={{display:'flex',alignItems:'center',gap:'12px',flexWrap:'wrap'}}>
          <button type="button" onClick={run} disabled={!can}
            style={{padding:'7px 14px',borderRadius:'6px',fontSize:'12px',border:'1px solid #C8922A',background:'#1C1208',color:'#C8922A',opacity:can?1:0.4}}>
            {state.phase==='busy' ? 'Looking up...' : 'Look up details'}
          </button>
          <span style={{fontSize:'12px',color:state.phase==='error'?'#C0604A':'#8A6A50'}}>
            {state.phase==='idle' ? 'Fills empty fields only (and a colour or style you have not changed). Suggestions can be wrong, so check them.' : state.text}
          </span>
        </div>
      );
    }

"""
PROD_ANCHOR = """              <FField label="Producer"><input value={form.producer} onChange={e=>set('producer',e.target.value)} placeholder={form.type==='wine'?'Winery':'Distillery'}/></FField>
            </FRow>
"""

def apply(src):
    for a in (ERR_ANCHOR, FORM_ANCHOR, PROD_ANCHOR):
        assert src.count(a) == 1, a[:60]
    src = src.replace(ERR_ANCHOR, ERR_NEW)
    src = src.replace(FORM_ANCHOR, COMPONENT + FORM_ANCHOR)
    src = src.replace(PROD_ANCHOR, PROD_ANCHOR + "            <LookupBar form={form} setForm={setForm} isNew={!isEdit}/>\n")
    return src
