# Which outside hosts the page talks to

The page (`web/index.html`) has no privacy screen of its own. This list is what a privacy sentence must cover. A test (`tests/page.test.js`) fails if the page contacts a host that is not named here, or if a script is not pinned.

| Host | What it is for | What it can see |
|---|---|---|
| `cdn.jsdelivr.net` | React 18.3.1, ReactDOM 18.3.1 and Babel 7.29.15, each pinned to an exact version with a sha384 integrity hash and `crossorigin="anonymous"`, so a changed file is refused and the page stays blank rather than run it | The visitor's IP address and browser details |
| `fonts.googleapis.com` (and the font files it points to on `fonts.gstatic.com`) | The Playfair Display and Inter fonts (a stylesheet, so it cannot carry an integrity hash) | The visitor's IP address and browser details |
| `accounts.google.com` | The "Sign in with Google" button and script. Google serves this script itself, so it cannot be pinned with a hash | Google sees that the visitor opened the page |
| `login.microsoftonline.com` | Microsoft sign-in, only if it is switched on (`MS_CLIENT_ID` empty = hidden) | Microsoft sees the sign-in |
| The MyCellar Worker on Cloudflare (`mycellar-api.<subdomain>.workers.dev`) | All cellar data, and the "Look up details" request (drink type, name and producer go to Cloudflare Workers AI) | Everything the visitor saves, and the name and producer they look up |
| GitHub Pages | Serves the page | The visitor's IP address |

Integrity hashes were computed from the npm packages (`react@18.3.1`, `react-dom@18.3.1`, `@babel/standalone@7.29.15`), not from the CDN. The first load of the real page must be checked: if a hash were wrong, the page would be blank.

Proposed sentence for the sign-in screen (not added: it is a visible change): "My Cellar loads its code from jsDelivr, its fonts from Google Fonts and sign-in from Google (and Microsoft if enabled). Those services see your IP address. Your cellar is stored with Cloudflare."
