#!/usr/bin/env python3
"""Browser check of web/index.html in headless Chrome against the REAL Worker running locally (nothing is deployed, made-up data).
Not part of `npm test` (needs Chrome, Playwright for Python and local copies of React and Babel).
  pip install playwright
  mkdir vendor && cd vendor && npm i react@18.3.1 react-dom@18.3.1 @babel/standalone@7.29.15      (anywhere outside the repo)
  python test-web/web_test.py --vendor <that folder>/node_modules [--page web/index.html] [--chrome <path to chrome>]
The scripts are served from the local copies with the page's integrity hashes still in force, so a page that loads proves the hashes
match the npm packages. Google sign-in and Workers AI are not available here: a session is planted, and /lookup is faked in the browser.
Exit code 1 if any check fails."""
import argparse, http.server, json, os, subprocess, sys, threading, time, urllib.request
from playwright.sync_api import sync_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--vendor', required=True); ap.add_argument('--page', default='web/index.html'); ap.add_argument('--chrome')
ap.add_argument('--only-saves', action='store_true', help='only the save-behaviour checks (for comparing an older page)')
A = ap.parse_args()
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
API, PAGE_PORT = 'http://localhost:8787', 8080

worker = subprocess.Popen(['node', os.path.join(ROOT, 'scripts', 'local-worker.mjs'), '--port', '8787', '--origin', f'http://localhost:{PAGE_PORT}'],
                          stdout=subprocess.PIPE, text=True, cwd=ROOT)
info = json.loads(worker.stdout.readline()); TOKEN = info['token']
html = open(A.page, encoding='utf-8').read().replace('https://mycellar-api.YOUR-SUBDOMAIN.workers.dev', API)

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = html.replace("const GOOGLE_CLIENT_ID = '';", "const GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';") if 'gid=1' in self.path else html
        self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(body.encode())
    def log_message(self, *a): pass
srv = http.server.HTTPServer(('localhost', PAGE_PORT), H); threading.Thread(target=srv.serve_forever, daemon=True).start()

def call(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or 'null')
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or 'null')

V = A.vendor
FILES = {'react@18.3.1/umd': V + '/react/umd/react.production.min.js', 'react-dom@18.3.1/umd': V + '/react-dom/umd/react-dom.production.min.js',
         '@babel/standalone@7.29.15': V + '/@babel/standalone/babel.min.js'}
CORS = {'access-control-allow-origin': f'http://localhost:{PAGE_PORT}', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS'}
faults = {'put_drinks_abort': 0, 'put_settings_abort': 0, 'force_401': False, 'lookup': None, 'block_cellar': False, 'hold_delete': False}
held = []   # DELETE /me requests the test is holding back
seen = []   # (time, method, path) of API calls

def route(r):
    u, m = r.request.url, r.request.method
    for k, v in FILES.items():
        if k in u: return r.fulfill(path=v, content_type='application/javascript')
    if 'gsi/client' in u: return r.fulfill(body='', content_type='application/javascript')
    if 'fonts.g' in u: return r.fulfill(body='', content_type='text/css')
    if u.startswith(API):
        path = u[len(API):]
        if m != 'OPTIONS': seen.append((time.time(), m, path))
        if path == '/lookup' and faults['lookup'] is not None:
            if m == 'OPTIONS': return r.fulfill(status=204, headers=CORS)
            return r.fulfill(status=200, headers={**CORS, 'content-type': 'application/json'}, body=json.dumps({'suggestions': faults['lookup']}))
        if m != 'OPTIONS' and faults['block_cellar'] and path == '/cellar':
            return r.fulfill(status=503, headers={**CORS, 'content-type': 'application/json'}, body='{"error":"internal"}')
        if m == 'DELETE' and path == '/me' and faults['hold_delete']: held.append(r); return
        if m != 'OPTIONS':
            if faults['force_401']: return r.fulfill(status=401, headers={**CORS, 'content-type': 'application/json'}, body='{"error":"unauthorized"}')
            if path.startswith('/drinks/') and m == 'PUT' and faults['put_drinks_abort'] > 0: faults['put_drinks_abort'] -= 1; return r.abort()
            if path == '/settings' and m == 'PUT' and faults['put_settings_abort'] > 0: faults['put_settings_abort'] -= 1; return r.abort()
    r.continue_()

results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok))); print(('PASS ' if ok else 'FAIL ') + name + (f'   [{detail}]' if detail and not ok else ''), flush=True)

def text(pg): return pg.inner_text('body')   # what the person sees (text(pg) would include the page's own script text)
def visible_buttons(pg): return pg.eval_on_selector_all('button', 'els=>els.filter(e=>e.offsetParent).map(e=>e.innerText.trim()).filter(Boolean)')
errs = []
def fresh(b, session=True, tz=None, width=1200, url='/', wait=True, now=None):
    kw = {'timezone_id': tz} if tz else {}
    ctx = b.new_context(viewport={'width': width, 'height': 800}, accept_downloads=True, **kw); ctx.route('**/*', route)
    if now: ctx.clock.set_fixed_time(now)
    if session:
        s = {'token': TOKEN, 'user': {'id': 'u1', 'email': 'tester@example.test', 'name': '', 'version': 1}}
        ctx.add_init_script("if(!localStorage.getItem('mycellar-session-v1')) localStorage.setItem('mycellar-session-v1', %s)" % json.dumps(json.dumps(s)))
    pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'http://localhost:{PAGE_PORT}{url}')
    if wait: pg.wait_for_selector('text=My Cellar', state='attached', timeout=30000)
    pg.wait_for_timeout(1200)
    return ctx, pg

def stock_drink(i, n):
    return {'id': i, 'type': 'wine', 'name': 'Test Wine ' + i, 'producer': 'P', 'stock': [
        {'id': f'{i}s{k}', 'location': 'wine-fridge', 'sublocation': 'Top Shelf', 'quantity': 1, 'dateAdded': '2024-01-01', 'status': 'in_stock'} for k in range(n)]}

try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=A.chrome, args=['--no-sandbox']) if A.chrome else p.chromium.launch(args=['--no-sandbox'])
        if not A.only_saves:
            ctx, pg = fresh(b)
            check('page loads with the pinned scripts (integrity hashes match the npm files; not blank)', 'My Cellar' in text(pg) and pg.evaluate('typeof React') == 'object')
            check('empty cellar opens signed in', 'Add Drink' in text(pg))
            ctx.close()

            # Look up details: fills empty fields only, then Save stores them
            faults['lookup'] = {'wineColor': 'red', 'grape': 'Cabernet Sauvignon blend', 'region': 'Bordeaux, France', 'appellation': 'Margaux AOC'}
            ctx, pg = fresh(b)
            pg.click('text=Add Drink >> visible=true >> nth=0'); pg.wait_for_selector('h1:has-text("Add Drink")')
            pg.fill('input[placeholder="e.g. Château Margaux"]', 'Chateau Margaux'); pg.fill('input[placeholder="e.g. Bordeaux, France"]', 'My own region')
            pg.click('button:has-text("Look up details")'); pg.wait_for_timeout(900)
            grape = pg.input_value('input[placeholder="e.g. Cabernet Sauvignon"]'); region = pg.input_value('input[placeholder="e.g. Bordeaux, France"]')
            check('Look up details fills the empty grape field', grape == 'Cabernet Sauvignon blend', grape)
            check('Look up details does not overwrite what was typed', region == 'My own region', region)
            check('Look up details says what it suggested', 'Suggested:' in text(pg))
            pg.click('button:has-text("Add Drink") >> visible=true >> nth=-1'); pg.wait_for_timeout(1200)
            st, c = call('GET', '/cellar'); d = [x for x in c['drinks'] if x['name'] == 'Chateau Margaux']
            check('the looked-up drink saved with the suggestion and the typed region', d and d[0].get('grape') == 'Cabernet Sauvignon blend' and d[0].get('region') == 'My own region', str(d))
            faults['lookup'] = None; ctx.close()

        if not A.only_saves:
            # Look up details does not call the Worker (and so does not use the free AI allowance) when everything it could fill is filled
            full = stock_drink('lk1', 1); full.update({'wineColor': 'red', 'grape': 'Merlot', 'region': 'Pomerol, France', 'appellation': 'Pomerol AOC'}); call('PUT', '/drinks/lk1', {'drink': full, 'version': None})
            faults['lookup'] = {'grape': 'Should not be asked'}
            ctx, pg = fresh(b)
            pg.click('text=Test Wine lk1 >> visible=true >> nth=0'); pg.wait_for_timeout(300)
            pg.click('button:has-text("Edit") >> visible=true >> nth=0'); pg.wait_for_selector('h1:has-text("Edit Drink")')
            seen.clear(); pg.click('button:has-text("Look up details")'); pg.wait_for_timeout(700)
            check('Look up details with every field filled: no request is sent and the page says why', not [x for x in seen if x[2] == '/lookup'] and 'already filled in' in text(pg) and pg.input_value('input[placeholder="e.g. Cabernet Sauvignon"]') == 'Merlot')
            pg.fill('input[placeholder="e.g. Cabernet Sauvignon"]', ''); pg.click('button:has-text("Look up details")'); pg.wait_for_timeout(900)
            check('Look up details with one field empty: the request is sent and only that field is filled', len([x for x in seen if x[2] == '/lookup']) == 1 and pg.input_value('input[placeholder="e.g. Cabernet Sauvignon"]') == 'Should not be asked' and pg.input_value('input[placeholder="e.g. Bordeaux, France"]') == 'Pomerol, France')
            faults['lookup'] = None; ctx.close()

        # --- two quick stock removals on one drink (the overlap case) ---
        call('PUT', '/drinks/ov1', {'drink': stock_drink('ov1', 3), 'version': None})
        ctx, pg = fresh(b)
        pg.click('text=Test Wine ov1 >> visible=true >> nth=0'); pg.wait_for_timeout(500)
        n = pg.evaluate("""()=>{const bs=[...document.querySelectorAll('button')].filter(b=>b.offsetParent&&b.innerText.trim()==='✕'&&/bottle/.test(b.parentElement.parentElement.innerText));
                          bs.slice(0,2).forEach(b=>b.click()); return bs.length}""")
        pg.wait_for_timeout(1500)
        st, c = call('GET', '/cellar'); d = [x for x in c['drinks'] if x['id'] == 'ov1'][0]
        check('two quick stock removals: both saved (1 of 3 bottles left)', n >= 2 and len(d['stock']) == 1, f"buttons {n}, stock left {len(d['stock'])}")
        check('two quick stock removals: no false "changed on another device" message', 'changed on another device' not in text(pg))
        ctx.close()

        # --- a failed drink save keeps the form open and can be retried ---
        call('PUT', '/drinks/fs1', {'drink': stock_drink('fs1', 1), 'version': None})
        ctx, pg = fresh(b)
        pg.click('text=Test Wine fs1 >> visible=true >> nth=0'); pg.wait_for_timeout(400)
        pg.click('button:has-text("Edit") >> visible=true >> nth=0'); pg.wait_for_selector('h1:has-text("Edit Drink")')
        pg.fill('input[placeholder="Winery"]', 'Edited producer'); faults['put_drinks_abort'] = 1
        pg.click('button:has-text("Save Changes")'); pg.wait_for_timeout(1000)
        check('failed save: a message is shown and the form (with the edit) stays open', ('Could not reach the server' in text(pg) or 'Failed to save' in text(pg)) and pg.input_value('input[placeholder="Winery"]') == 'Edited producer')
        pg.click('button:has-text("Save Changes")'); pg.wait_for_timeout(1200)
        st, c = call('GET', '/cellar'); d = [x for x in c['drinks'] if x['id'] == 'fs1'][0]
        check('failed save: pressing Save again works', d.get('producer') == 'Edited producer' and 'Edit Drink' not in text(pg), d.get('producer'))
        ctx.close()

        # --- settings: retried after a network failure ---
        ctx, pg = fresh(b)
        pg.click('button[title="Cellar Management"] >> visible=true'); pg.wait_for_selector('text=Personal Rating Scale')
        faults['put_settings_abort'] = 1; t0 = time.time(); pg.click('button:has-text("Reset") >> visible=true >> nth=0'); pg.wait_for_timeout(1600)
        shown = 'not saved yet' in text(pg)
        st, c = call('GET', '/cellar'); early = c['settings'].get('scale')
        pg.wait_for_timeout(5500); st, c = call('GET', '/cellar'); late = c['settings'].get('scale')
        check('settings save fails once: the page says it is not saved yet', shown)
        check('settings save fails once: it is retried and saved by itself', early is None and late and late[0][0] == 80 and 'not saved yet' not in text(pg), f'early={early} late={late}')
        ctx.close()

        # --- rating scale edit saved when the page is hidden before the 700 ms timer ---
        ctx, pg = fresh(b)
        pg.click('button[title="Cellar Management"] >> visible=true'); pg.wait_for_selector('text=Personal Rating Scale')
        pg.fill('input[placeholder="Label"] >> nth=0', 'Closing label')
        pg.evaluate("()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'hidden'});document.dispatchEvent(new Event('visibilitychange'))}")
        pg.wait_for_timeout(350); st, c = call('GET', '/cellar'); sc = c['settings'].get('scale')
        check('closing the tab saves a scale edit that was still waiting for its timer', sc and sc[0][1] == 'Closing label', str(sc))
        ctx.close()

        # --- an expired session explains itself ---
        ctx, pg = fresh(b)
        pg.click('text=Test Wine ov1 >> visible=true >> nth=0'); pg.wait_for_timeout(300)
        faults['force_401'] = True
        pg.click('button:has-text("Edit") >> visible=true >> nth=0'); pg.wait_for_selector('h1:has-text("Edit Drink")')
        pg.click('button:has-text("Save Changes")'); pg.wait_for_timeout(1000); faults['force_401'] = False
        check('401: signed out with a message that says the session ended', 'session has ended' in text(pg))
        ctx.close()

        if not A.only_saves:
            # ===== audit fixes (2026-11-22) =====
            # first load fails: a clear screen with Try again, not an empty cellar
            faults['block_cellar'] = True
            ctx, pg = fresh(b, wait=False); pg.wait_for_selector('text=Could not open your cellar', timeout=30000)
            t = text(pg)
            check('load failure: "Could not open your cellar" with Try again and Sign out, no empty cellar', 'Try again' in t and 'Sign out' in t and 'Add Drink' not in t, t[:200])
            faults['block_cellar'] = False; pg.click('button:has-text("Try again")'); pg.wait_for_selector('text=Add Drink', timeout=15000)
            check('load failure: Try again opens the cellar', 'Could not open your cellar' not in text(pg))
            ctx.close()

            # a 409 on the edit form keeps the form and what was typed; Save again replaces the other change; Cancel keeps it
            call('PUT', '/drinks/cf1', {'drink': stock_drink('cf1', 1), 'version': None})
            ctx, pg = fresh(b)
            pg.click('text=Test Wine cf1 >> visible=true >> nth=0'); pg.wait_for_timeout(300)
            pg.click('button:has-text("Edit") >> visible=true >> nth=0'); pg.wait_for_selector('h1:has-text("Edit Drink")')
            st, c = call('GET', '/cellar'); v = [x for x in c['drinks'] if x['id'] == 'cf1'][0]['version']
            other = stock_drink('cf1', 1); other['producer'] = 'Other device'; call('PUT', '/drinks/cf1', {'drink': other, 'version': v})
            pg.fill('input[placeholder="Winery"]', 'Typed here'); pg.click('button:has-text("Save Changes")'); pg.wait_for_timeout(1500)
            st, c = call('GET', '/cellar'); d = [x for x in c['drinks'] if x['id'] == 'cf1'][0]
            check('409 on the form: the form stays open with what was typed, and says what happened',
                  'Edit Drink' in text(pg) and pg.input_value('input[placeholder="Winery"]') == 'Typed here' and 'changed on another device' in text(pg), text(pg)[:200])
            check('409 on the form: nothing was overwritten yet', d.get('producer') == 'Other device', d.get('producer'))
            pg.click('button:has-text("Save Changes")'); pg.wait_for_timeout(1500)
            st, c = call('GET', '/cellar'); d = [x for x in c['drinks'] if x['id'] == 'cf1'][0]
            check('409 on the form: Save again replaces the other change and closes the form', d.get('producer') == 'Typed here' and 'Edit Drink' not in text(pg), d.get('producer'))
            ctx.close()

            # dates are the person's own date (UTC+11, 09:00 on 23 Nov is still 22 Nov in UTC)
            ctx, pg = fresh(b, tz='Pacific/Noumea', now='2026-11-23T09:00:00+11:00')
            pg.click('text=Add Drink >> visible=true >> nth=0'); pg.wait_for_selector('h1:has-text("Add Drink")')
            pg.fill('input[placeholder="e.g. Château Margaux"]', 'Morning Test Wine'); pg.click('button:has-text("Add Drink") >> visible=true >> nth=-1'); pg.wait_for_timeout(1500)
            st, c = call('GET', '/cellar'); d = [x for x in c['drinks'] if x['name'] == 'Morning Test Wine']
            check('local date: a bottle added at 09:00 UTC+11 on 23 Nov is dated 2026-11-23 (UTC would say 22)', d and d[0]['stock'][0]['dateAdded'] == '2026-11-23', str(d and d[0]['stock'][0]['dateAdded']))
            ctx.close()

            # whisky default location, invite wording, 16px inputs on a phone, download my data
            ctx, pg = fresh(b)
            pg.click('text=Add Drink >> visible=true >> nth=0'); pg.wait_for_selector('h1:has-text("Add Drink")'); pg.click('button:has-text("Whisky")'); pg.wait_for_timeout(300)
            sel = pg.eval_on_selector_all('select', "els=>els.map(e=>e.options[e.selectedIndex]&&e.options[e.selectedIndex].text)")
            check('a new whisky defaults to the Whisky Globe', sel and sel[0] == 'Whisky Globe', str(sel))
            desk = pg.eval_on_selector('input', "e=>getComputedStyle(e).fontSize"); ctx.close()
            ctx, pg = fresh(b, width=390); pg.click('text=Add >> visible=true >> nth=-1'); pg.wait_for_selector('h1:has-text("Add Drink")')
            phone = pg.eval_on_selector('input', "e=>getComputedStyle(e).fontSize"); ctx.close()
            check('inputs are 16px on a phone (no iPhone zoom) and unchanged on desktop', phone == '16px' and desk == '13px', f'phone {phone} desktop {desk}')
            ctx, pg = fresh(b)
            pg.click('button[title="Cellar Management"] >> visible=true'); pg.wait_for_selector('text=Personal Rating Scale')
            st, c = call('GET', '/cellar')
            with pg.expect_download() as dl: pg.click('button:has-text("Download my data")')
            f = dl.value; exp = json.load(open(f.path(), encoding='utf-8'))
            check('Download my data: a my-cellar-<date>.json with every drink (prices in dollars, no version numbers)',
                  f.suggested_filename.startswith('my-cellar-') and f.suggested_filename.endswith('.json') and len(exp['drinks']) == len(c['drinks']) and all('_v' not in d and 'version' not in d for d in exp['drinks']), f.suggested_filename)
            pg.click('text=Delete my account'); pg.wait_for_selector('text=DELETE ACCOUNT')
            check('account deletion says a new invitation would be needed', 'need a new invitation' in text(pg))
            ctx.close()

            # Google's script blocked or missing: a message instead of silence
            ctx, pg = fresh(b, session=False, url='/?gid=1'); pg.wait_for_selector('text=Google sign-in could not load', timeout=20000)
            check('Google script blocked: the sign-in screen says so', 'ad blocker' in text(pg)); ctx.close()

            # ---- DELETE MY ACCOUNT: real mouse clicks. This runs LAST (it deletes the test user). ----
            ctx, pg = fresh(b)
            pg.click('button[title="Cellar Management"] >> visible=true'); pg.wait_for_selector('text=Personal Rating Scale')
            pg.click('text=Delete my account'); pg.wait_for_selector('text=DELETE ACCOUNT')
            btn = pg.locator('button:text-is("Delete")')
            def real_click():
                bb = btn.bounding_box(); pg.mouse.click(bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2)
            def deletes(): return [x for x in seen if x[1] == 'DELETE' and x[2] == '/me']
            seen.clear()
            check('Delete: the button is disabled while the box is empty', btn.is_disabled())
            real_click(); real_click(); pg.wait_for_timeout(700)
            check('Delete: clicking it with an EMPTY box sends nothing', not deletes() and 'Sign in to open your cellar' not in text(pg), str(deletes()))
            box = pg.locator('input[placeholder="DELETE ACCOUNT"]')
            for wrong in ['DELETE', 'delete account', 'DELETE ACCOUNTS', 'DELETE  ACCOUNT', 'ACCOUNT']:
                box.fill(wrong); real_click(); pg.wait_for_timeout(250)
            pg.wait_for_timeout(500)
            check('Delete: clicking it with a WRONG phrase (5 tries) sends nothing', not deletes() and btn.is_disabled(), str(deletes()))
            faults['hold_delete'] = True; box.fill('DELETE ACCOUNT')
            check('Delete: the button becomes enabled only with the exact phrase', not btn.is_disabled())
            real_click(); pg.wait_for_timeout(300)
            busy_btn = pg.locator('button:text-is("Deleting...")')
            check('Delete: while the request is running the button is disabled and says Deleting...', busy_btn.count() == 1 and busy_btn.is_disabled())
            for _ in range(3):
                bb = busy_btn.bounding_box(); pg.mouse.click(bb['x'] + bb['width'] / 2, bb['y'] + bb['height'] / 2); pg.wait_for_timeout(100)
            pg.wait_for_timeout(600)
            check('Delete: three more clicks while it runs send nothing extra (exactly 1 request)', len(deletes()) == 1 and len(held) == 1, f'{len(deletes())} requests')
            faults['hold_delete'] = False; held[0].continue_(); pg.wait_for_selector('text=Sign in to open your cellar', timeout=15000)
            st, _ = call('GET', '/cellar')
            check('Delete: with the exact phrase the account is deleted (token refused afterwards, sign-in screen shown)', st == 401)
            ctx.close()
        b.close()
finally:
    worker.terminate(); srv.shutdown()
    if os.name == 'nt': subprocess.run(['taskkill', '/pid', str(worker.pid), '/T', '/F'], capture_output=True)
bad = [e for e in errs if 'favicon' not in e]
check('no page errors', not bad, str(bad[:3]))
print(f"\n{sum(ok for _, ok in results)} of {len(results)} checks passed"); sys.exit(0 if all(ok for _, ok in results) else 1)
