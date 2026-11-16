import os
import shutil
import sqlite3
import sys
import tempfile

source = sys.argv[1]
if not os.path.exists(source):
    print(f"no history at {source}")
    sys.exit(0)
copy = os.path.join(tempfile.mkdtemp(), "History")
shutil.copyfile(source, copy)
connection = sqlite3.connect(copy)
urls = connection.execute("SELECT count(*) FROM urls").fetchone()[0]
visits = connection.execute("SELECT count(*) FROM visits").fetchone()[0]
print(f"engine history {source}: {urls} pages, {visits} visits, {os.path.getsize(source)} bytes")
