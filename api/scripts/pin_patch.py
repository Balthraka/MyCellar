"""Pins the page's three CDN scripts to exact versions on jsDelivr with sha384 integrity (hashes computed from the npm
packages: react@18.3.1, react-dom@18.3.1, @babel/standalone@7.29.15). Used by build-web.py and applied once to web/index.html."""

OLD = """  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone@7/babel.min.js"></script>
"""
NEW = """  <script src="https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js" integrity="sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z" crossorigin="anonymous"></script>
  <script src="https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js" integrity="sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1" crossorigin="anonymous"></script>
  <script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7.29.15/babel.min.js" integrity="sha384-Ss/vAy5WJ/pgOuQj8fpWo8I/lIbCYJW0kNY8PbhsygEsxmwpdsXz47HC5+sIUypz" crossorigin="anonymous"></script>
"""

def apply(src):
    assert src.count(OLD) == 1, 'unpinned script block not found exactly once'
    return src.replace(OLD, NEW)
