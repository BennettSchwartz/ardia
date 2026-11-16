import random
import sqlite3
import sys
import time

shape = sys.argv[1]
database = sys.argv[2]
random.seed(2097)
connection = sqlite3.connect(database)
columns = [row[1] for row in connection.execute("PRAGMA table_info(visits)")]
now = int((time.time() + 11644473600) * 1_000_000)
words = ["café", "日本語", "ελληνικά", "поиск", "😀", "news", "docs", "video"]


def add_page(url, title, visits, newest):
    cursor = connection.execute(
        "INSERT INTO urls(url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (CAST(? AS TEXT), CAST(? AS TEXT), ?, 0, ?, 0)",
        (url, title, visits, newest),
    )
    page = cursor.lastrowid
    connection.executemany(
        "INSERT INTO visits(url, visit_time, transition) VALUES (?, ?, ?)",
        [(page, newest - step * 3_600_000_000, 0x30000000) for step in range(visits)],
    )


def normal_pages(count, visits):
    for index in range(count):
        url = f"https://visits{index % 3000}.example-{index % 13}.org/{index}/{'-'.join(random.choice(words) for _ in range(5))}?id={index}"
        title = f"Visited {index} — " + " ".join(random.choice(words) for _ in range(8))
        add_page(url, title, visits, now - index * 30_000_000)
        if index % 5000 == 0:
            connection.commit()


if shape.startswith("visits-"):
    pages, visits = (int(part) for part in shape[len("visits-"):].split("x"))
    normal_pages(pages, visits)
elif shape == "malformed":
    normal_pages(1000, 3)
    bad = [
        (b"https://lone-surrogate.example/\xed\xa0\x80", b"lone high surrogate \xed\xa0\x80 in a title"),
        (b"https://lone-low.example/", b"lone low surrogate \xed\xb0\x80 here"),
        (b"https://invalid-utf8.example/\xff\xfe", b"invalid utf-8 \xff\xfe\xc3\x28 bytes"),
        (b"https://overlong.example/", b"overlong \xc0\xaf slash"),
        (b"https://nul.example/a\x00b", b"title with a NUL \x00 inside"),
        (b"https://control.example/", b"controls \x01\x02\x1b\x7f and a quote \" and a backslash \\"),
        (b"https://truncated.example/", b"truncated sequence at the end \xe6\x97"),
    ]
    for offset, (url, title) in enumerate(bad):
        add_page(url, title, 2, now - offset * 1_000_000)
elif shape == "huge":
    normal_pages(1000, 3)
    add_page(b"https://huge-title.example/", ("Megabyte title " + "é" * 500_000).encode("utf-8"), 2, now)
    add_page(("data:text/html," + "a" * 1_000_000).encode("utf-8"), b"a data URL of a megabyte", 2, now - 1_000_000)
    add_page(("https://long-url.example/" + "p" * 2_000_000).encode("utf-8"), b"a two-megabyte URL", 2, now - 2_000_000)
else:
    raise SystemExit(f"unknown shape {shape}")
connection.commit()
urls = connection.execute("SELECT count(*) FROM urls").fetchone()[0]
visits = connection.execute("SELECT count(*) FROM visits").fetchone()[0]
print(f"seeded the engine's history ({shape}): now {urls} pages, {visits} visits; visits columns: {len(columns)}")
