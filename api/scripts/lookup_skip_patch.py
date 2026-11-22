"""Look up details: when every field the lookup could fill is already filled, say so and do not call the Worker (saves the free AI allowance).
Applied by build-web.py after audit_patch.py. Uses the same 'unset' rule as the fill: empty, or (new drink) still the default colour or style."""

ANCHOR = """      async function run() {
        setState({ phase:'busy', text:'' });
"""
NEW = """      async function run() {
        const keys = form.type === 'wine' ? ['wineColor','grape','region','appellation'] : ['whiskyStyle','whiskyRegion'];
        if (!keys.some(k => !form[k] || (isNew && (k === 'wineColor' || k === 'whiskyStyle') && form[k] === EMPTY_FORM[k]))) {
          setState({ phase:'done', text:'Nothing to look up: those fields are already filled in.' });
          return;
        }
        setState({ phase:'busy', text:'' });
"""

def apply(src):
    assert src.count(ANCHOR) == 1, 'lookup run() anchor'
    return src.replace(ANCHOR, NEW)
