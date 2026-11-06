"""Retake the README screenshots in docs/.

Fills the browser version with sample notes, then snaps the list view, the
gallery and the [[ link picker. Run `npm run dev` first, then:

    pip install playwright && playwright install chromium
    python3 scripts/screenshots.py
"""
import json, time, datetime, sys
from playwright.sync_api import sync_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else "docs"
now = int(time.time() * 1000)
H, D = 3600_000, 86400_000

def f(body, ago):
    return {"body": body, "created": now - ago - D, "modified": now - ago}

MAIN = ("a notes app that feels like a typing test\n\n"
        "no toolbar. no formatting menu. just you, a blinking caret, and the words.\n\n"
        "link notes with [[roadmap]], tag them #ideas, and a little stats bar keeps score while you type.")

files = {
    "ideas/a notes app that feels like a typing test.md": f(MAIN, 60_000),
    "ideas/weekend.md": f("weekend\nclimbing saturday\nfarmers market sunday", D),
    "reading list.md": f("reading list\nthe pragmatic programmer\nthinking fast and slow\nshape up", D + 2 * H),
    "work/standup.md": f("standup\nshipped [[version history]]\nnext: #links and #tags", D + 4 * H),
    "work/roadmap.md": f("roadmap\nstars for notes and folders\nclear version history\n#ideas: themes, find and replace", D + 6 * H),
    "recipes/banana bread.md": f("banana bread\n3 ripe bananas\n2 cups flour\n1/2 cup sugar\nan egg", 3 * D),
    "personal/journal.md": f("journal\nwrote a notes app today. it feels nice to type in. #ideas", 4 * D),
    "work/version history.md": f("version history\nevery save keeps a copy for 90 days", 5 * D),
}
meta = {"pinned": ["reading list.md"], "starredFolders": ["work"]}
files[".monkeynotes.json"] = {"body": json.dumps(meta), "created": now, "modified": now}
fs = {"files": files, "dirs": ["ideas", "work", "recipes", "personal"]}

days = {}
for i in range(9):
    d = datetime.date.today() - datetime.timedelta(days=i)
    days[d.isoformat()] = {"chars": 2200 if i == 0 else 3400, "ms": 25 * 60_000 if i == 0 else 25 * 60_000, "best": 41}

def state(view_mode, path):
    return json.dumps({"version": 2, "settingsRevision": 99,
        "settings": {"viewMode": view_mode},
        "view": {"folderId": "__all__", "notePath": path, "collapsed": []},
        "stats": {"days": days}, "lastUpdateCheck": now})

MAIN_PATH = "ideas/a notes app that feels like a typing test.md"

def page_with(p, view_mode, path):
    page = p.new_page(viewport={"width": 1280, "height": 760}, device_scale_factor=2)
    page.add_init_script(
        "if (!sessionStorage.getItem('seeded')) { localStorage.clear();"
        f"localStorage.setItem('monkeynotes:fs', {json.dumps(json.dumps(fs))});"
        f"localStorage.setItem('monkeynotes:state', {json.dumps(state(view_mode, path))});"
        "sessionStorage.setItem('seeded', '1'); }")
    page.goto("http://localhost:1420")
    page.wait_for_selector(".note, .card")
    page.wait_for_timeout(600)
    return page

def caret_end(page):
    page.evaluate("(() => { const t = document.querySelector('#editor'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); t.dispatchEvent(new Event('select')); })()")

with sync_playwright() as p:
    b = p.chromium.launch()

    # 1. list view, caret at the end of the main note
    page = page_with(b, "list", MAIN_PATH)
    caret_end(page)
    page.add_style_tag(content=".caret { animation: none !important; opacity: 1 !important; }")
    page.wait_for_timeout(800)
    page.screenshot(path=f"{OUT}/screenshot.png")
    page.close()

    # 2. gallery view
    page = page_with(b, "grid", MAIN_PATH)
    page.mouse.move(5, 700)
    page.wait_for_timeout(500)
    page.screenshot(path=f"{OUT}/gallery.png")
    page.close()

    # 3. the [[ link picker
    page = page_with(b, "list", "work/standup.md")
    caret_end(page)
    page.keyboard.press("Enter")
    page.keyboard.type("see [[", delay=40)
    page.wait_for_timeout(200)
    page.keyboard.type("ro", delay=60)
    page.wait_for_timeout(500)
    page.screenshot(path=f"{OUT}/links.png")
    page.close()
    b.close()
