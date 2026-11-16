import random
import sqlite3
import sys
import time

count = int(sys.argv[1])
database = sys.argv[2]
random.seed(2095)
words = ["café", "naïve", "日本語のページ", "ελληνικά", "straße", "поиск", "عربى", "search", "news", "video", "docs", "issue", "release", "😀"]
now = int((time.time() + 11644473600) * 1_000_000)
connection = sqlite3.connect(database)
before = connection.execute("SELECT count(*) FROM urls").fetchone()[0]
rows = []
for index in range(count):
    host = f"site{index % 4000}.example-{index % 11}.com"
    path = "-".join(random.choice(words) for _ in range(6))
    url = f"https://{host}/path/{index}/{path}?q={index}&ref=abcdefghijklmnopqrstuvwxyz0123456789&utm_source=probe{index}"
    title = f"Page {index} — " + " ".join(random.choice(words) for _ in range(9))
    rows.append((url, title, 2 + index % 7, index % 3, now - index * 45_000_000, 0))
connection.executemany("INSERT INTO urls(url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?, ?)", rows)
connection.commit()
after = connection.execute("SELECT count(*) FROM urls").fetchone()[0]
print(f"seeded {count} pages into {database}: {before} before, {after} after")
