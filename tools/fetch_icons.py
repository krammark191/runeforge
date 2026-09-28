#!/usr/bin/env python3
"""Fetch item icons from the Valheim Wiki (valheim.wiki → valheim.weirdgloop.org) keyed by prefab name.

Resolution order for every non-hash-only prefab in data/items.json:
  1. the wiki's "Trophies" table (icon file + <code>ID</code> in the same row),
  2. the wiki's "Item IDs" table (prefab → article), then that article's infobox image — the infobox whose
     `id` equals the prefab, or the article's only infobox when the Item IDs table vouches for it,
  3. the article whose title is the item's display name, infobox `id` must match,
  4. full-text search for the prefab (infoboxes render "Internal ID <prefab>").
Images are fetched as 64px thumbnails. Anything that is not a PNG of at most 160px wide is rejected — that is
how a screenshot from a gallery page gets filtered out.

Writes data/icons.json = { prefab: "assets/icons/<file>" }. Re-runs only fetch prefabs missing from the
manifest unless --force is given.

Usage: python3 tools/fetch_icons.py [--force] [--limit N]
"""
import json, os, re, ssl, struct, sys, time, urllib.parse, urllib.request

# python.org builds on macOS ship without a CA bundle; use certifi or the system one.
try:
    import certifi
    _CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _CTX = ssl.create_default_context(cafile='/etc/ssl/cert.pem' if os.path.exists('/etc/ssl/cert.pem') else None)
urllib.request.install_opener(urllib.request.build_opener(urllib.request.HTTPSHandler(context=_CTX)))

API = 'https://valheim.weirdgloop.org/api.php'
UA = 'Runeforge icon fetcher (https://github.com/krammark191/runeforge)'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_DIR = os.path.join(ROOT, 'assets', 'icons')
MANIFEST = os.path.join(ROOT, 'data', 'icons.json')
PAUSE = 0.25
MAX_WIDTH = 160
SKIP_PREFIX = ('Hair', 'Beard')  # character customisation prefabs, never in an inventory
ALIASES = {  # prefab → wiki file, checked by hand where the article's infobox id differs from the game's
    'AtgeirHimminAfl': 'Himminafl.png', 'StaffLightning': 'Dundr.png', 'SwordIronFire': 'Dyrnwyn.png',
    'Flametal': 'Flametal.png', 'FlametalOre': 'Flametal Ore.png', 'Voidplasm': 'Ectoplasm.png',
    'TrinketBloodGoldHealth': 'Neckstabber.png', 'Lantern_hooded': 'Hooded Lantern.png', 'FirConeFrost': 'Timberwood Cone.png',
    'FishAnglerRaw': 'Raw Fish.png', 'StaffSkeleton': 'Dead Raiser.png', 'TrophyForestTroll': 'Troll Trophy.png',
    'TrophyDraugrFem': 'Draugr Trophy.png',
}

force = '--force' in sys.argv
limit = int(sys.argv[sys.argv.index('--limit') + 1]) if '--limit' in sys.argv else None


def api(**params):
    params.update(format='json', formatversion='2')
    req = urllib.request.Request(API + '?' + urllib.parse.urlencode(params), headers={'User-Agent': UA})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                time.sleep(PAUSE)
                return json.load(r)
        except Exception:  # noqa: BLE001
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        time.sleep(PAUSE)
        return r.read()


def chunks(seq, n):
    seq = list(seq)
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def infoboxes(wikitext):
    """Yield (id, image) for each infobox-like template in the page."""
    for part in re.split(r'\{\{\s*infobox', wikitext, flags=re.I)[1:]:
        m_id = re.search(r'\|\s*(?:id|internal[_ ]?id)\s*=\s*([^\n|}]+)', part, re.I)
        m_img = re.search(r'\|\s*(?:image|icon|image1)\s*=\s*([^\n|}]+)', part, re.I)
        yield (m_id.group(1).strip() if m_id else None, m_img.group(1).strip() if m_img else None)


def query_pages(titles):
    """titles → {asked title: {'wikitext', 'pageimage', 'title'}} with redirects/normalisation folded back."""
    out = {}
    for batch in chunks(titles, 50):
        d = api(action='query', titles='|'.join(batch), prop='revisions|pageimages', rvprop='content', rvslots='main',
                piprop='original', redirects=1)
        q = d.get('query', {})
        back = {r['to']: r['from'] for r in q.get('redirects', [])}
        norm = {n['to']: n['from'] for n in q.get('normalized', [])}
        for p in q.get('pages', []):
            if p.get('missing'):
                continue
            title = p['title']
            asked = norm.get(back.get(title, title), back.get(title, title))
            wt = ''
            if p.get('revisions'):
                wt = p['revisions'][0].get('slots', {}).get('main', {}).get('content', '')
            out[asked] = {'wikitext': wt, 'pageimage': (p.get('original') or {}).get('source'), 'title': title}
    return out


def pick_image(prefab, page, vouched=False):
    """('file', name) | ('url', src) | None."""
    boxes = list(infoboxes(page['wikitext']))
    for iid, img in boxes:
        if iid and iid.lower() == prefab.lower():
            return ('file', img) if img else (('url', page['pageimage']) if page['pageimage'] else None)
    if vouched:
        imgs = [img for _, img in boxes if img]
        if len(imgs) == 1:
            return ('file', imgs[0])
    return None


def item_ids_table():
    """The wiki's Item IDs page: prefab → article title."""
    page = query_pages(['Item IDs']).get('Item IDs')
    out = {}
    if not page:
        return out
    for line in page['wikitext'].splitlines():
        m = re.match(r'\|\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\].*\|\|\s*([A-Za-z0-9_]+)\s*$', line.strip())
        if m:
            out.setdefault(m.group(2), m.group(1).strip())
    return out


def trophies_table():
    """The wiki's Trophies page: prefab → icon file."""
    page = query_pages(['Trophies']).get('Trophies')
    out = {}
    if not page:
        return out
    for row in page['wikitext'].split('|-'):
        m_file = re.search(r'\[\[File:([^\]|]+)', row)
        m_id = re.search(r'<code>\s*([A-Za-z0-9_]+)\s*</code>', row)
        if m_file and m_id:
            out[m_id.group(1)] = m_file.group(1).strip()
    return out


def search_prefab(prefab):
    d = api(action='query', list='search', srsearch=f'"{prefab}"', srlimit=5, srwhat='text')
    for hit in d.get('query', {}).get('search', []):
        page = query_pages([hit['title']]).get(hit['title'])
        if page:
            got = pick_image(prefab, page)
            if got:
                return got
    return None


def resolve_files(filenames):
    """File names → 64px thumb URLs (or the full URL when the file is already small)."""
    out = {}
    for batch in chunks(sorted(set(filenames)), 50):
        d = api(action='query', titles='|'.join('File:' + f for f in batch), prop='imageinfo', iiprop='url',
                iiurlwidth=64, redirects=1)
        q = d.get('query', {})
        norm = {n['to']: n['from'] for n in q.get('normalized', [])}
        back = {r['to']: r['from'] for r in q.get('redirects', [])}
        for p in q.get('pages', []):
            ii = (p.get('imageinfo') or [{}])[0]
            url = ii.get('thumburl') or ii.get('url')
            if not url:
                continue
            title = p['title']
            asked = norm.get(back.get(title, title), back.get(title, title))
            out[asked[len('File:'):]] = url
    return out


def png_width(data):
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        return None
    return struct.unpack('>I', data[16:20])[0]


def main():
    items = json.load(open(os.path.join(ROOT, 'data', 'items.json')))['items']
    prefabs = [p for p, e in items.items() if not e.get('hashOnly') and not p.startswith(SKIP_PREFIX)]
    if limit:
        prefabs = prefabs[:limit]
    os.makedirs(ICON_DIR, exist_ok=True)
    manifest = json.load(open(MANIFEST)) if os.path.exists(MANIFEST) and not force else {}
    todo = [p for p in prefabs if force or p not in manifest]
    print(f'{len(prefabs)} prefabs, {len(todo)} to fetch')

    want = {}  # prefab → ('file', name) | ('url', src)

    # 0. Hand-checked file names for items whose article uses a different id than the game.
    for p in todo:
        if p in ALIASES:
            want[p] = ('file', ALIASES[p])

    # 1. Trophies table.
    troph = trophies_table()
    for p in todo:
        if p in troph:
            want[p] = ('file', troph[p])
    print(f'trophies table: {sum(1 for p in todo if p in want)}')

    # 2. Item IDs table → article.
    ids = item_ids_table()
    need = [p for p in todo if p not in want and p in ids]
    pages = query_pages(sorted({ids[p] for p in need}))
    for p in need:
        page = pages.get(ids[p])
        got = pick_image(p, page, vouched=True) if page else None
        if got:
            want[p] = got
    print(f'item IDs table: {len(ids)} rows, matched {len(want)} so far')

    # 3. Display-name article.
    need = [p for p in todo if p not in want]
    pages = query_pages(sorted({items[p]['name'] for p in need if items[p]['name']}))
    for p in need:
        page = pages.get(items[p]['name'])
        got = pick_image(p, page) if page else None
        if got:
            want[p] = got
    print(f'display name: matched {len(want)} so far')

    # 3b. "<display name>.png" — the wiki's usual file naming — verified against imageinfo below
    #     (a file that does not exist simply resolves to nothing).
    for p in [p for p in todo if p not in want]:
        if items[p]['name']:
            want[p] = ('file', items[p]['name'] + '.png')
    print(f'aliases/display-name files: {len(want)} candidates')

    # 4. Search (only for prefabs with no candidate at all).
    need = [p for p in todo if p not in want]
    for i, p in enumerate(need):
        got = search_prefab(p)
        if got:
            want[p] = got
        if i % 25 == 0:
            print(f'  search {i}/{len(need)}', flush=True)
    unresolved = [p for p in todo if p not in want]
    print(f'search: matched {len(want)} total, {len(unresolved)} unresolved')

    # Resolve file names to URLs.
    urls = {p: v for p, (kind, v) in want.items() if kind == 'url'}
    file_urls = resolve_files(v for kind, v in want.values() if kind == 'file')
    for p, (kind, v) in want.items():
        if kind == 'file':
            u = file_urls.get(v) or file_urls.get(v.replace('_', ' ')) or file_urls.get(v[0].upper() + v[1:])
            if u:
                urls[p] = u
            else:
                unresolved.append(p)

    # Download + validate.
    rejected = []
    for i, (p, u) in enumerate(sorted(urls.items())):
        rel = f'assets/icons/{p}.png'
        dest = os.path.join(ROOT, rel)
        try:
            data = fetch(u)
            w = png_width(data)
            if w is None or w > MAX_WIDTH:
                rejected.append((p, w))
                continue
            with open(dest, 'wb') as f:
                f.write(data)
            manifest[p] = rel
        except Exception as e:  # noqa: BLE001
            print(f'  ! {p}: {e}')
            unresolved.append(p)
        if i % 50 == 0:
            print(f'  download {i}/{len(urls)}', flush=True)
            json.dump(dict(sorted(manifest.items())), open(MANIFEST, 'w'), indent=0)

    json.dump(dict(sorted(manifest.items())), open(MANIFEST, 'w'), indent=0)
    unresolved = sorted(set(unresolved) | {p for p, _ in rejected})
    print(f'done: {len(manifest)} in manifest, {len(rejected)} rejected (not a small PNG), {len(unresolved)} without icon')
    if rejected:
        print('rejected:', rejected[:30])
    if unresolved:
        print('missing:', ', '.join(unresolved[:120]), '...' if len(unresolved) > 120 else '')


if __name__ == '__main__':
    main()
