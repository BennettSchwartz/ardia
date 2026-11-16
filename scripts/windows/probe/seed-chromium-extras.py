import base64
import ctypes
import ctypes.wintypes
import json
import os
import random
import sqlite3
import sys
import time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

profile_root = sys.argv[1]
bookmark_count = int(sys.argv[2])
password_count = int(sys.argv[3])
profile = os.path.join(profile_root, "Default")
random.seed(2103)


class Blob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def unprotect(data):
    buffer = ctypes.create_string_buffer(data, len(data))
    given = Blob(len(data), buffer)
    taken = Blob()
    if not ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(given), None, None, None, None, 0, ctypes.byref(taken)):
        raise OSError("CryptUnprotectData failed")
    result = ctypes.string_at(taken.pbData, taken.cbData)
    ctypes.windll.kernel32.LocalFree(taken.pbData)
    return result


now = int((time.time() + 11644473600) * 1_000_000)
folders = []
for folder in range(50):
    children = []
    for index in range(bookmark_count // 50):
        number = folder * 1000 + index
        children.append({"type": "url", "name": f"Bookmark {number} — café 日本語", "url": f"https://bookmark{number}.example.net/page/{number}", "date_added": str(now), "id": str(1000 + number), "guid": f"00000000-0000-4000-8000-{number:012d}"})
    folders.append({"type": "folder", "name": f"Folder {folder}", "children": children, "date_added": str(now), "date_modified": str(now), "id": str(100 + folder), "guid": f"00000000-0000-4000-9000-{folder:012d}"})
bookmarks = {
    "checksum": "",
    "roots": {
        "bookmark_bar": {"children": folders, "date_added": str(now), "date_modified": str(now), "id": "1", "name": "Bookmarks bar", "type": "folder", "guid": "0bc5d13f-2cba-5d74-951f-3f233fe6c908"},
        "other": {"children": [], "date_added": str(now), "date_modified": "0", "id": "2", "name": "Other bookmarks", "type": "folder", "guid": "82b081ec-3dd3-529c-8475-ab6c344590dd"},
        "synced": {"children": [], "date_added": str(now), "date_modified": "0", "id": "3", "name": "Mobile bookmarks", "type": "folder", "guid": "4cf2e351-0e85-532b-bb37-df045d8f8d0f"},
    },
    "version": 1,
}
with open(os.path.join(profile, "Bookmarks"), "w", encoding="utf-8") as file:
    json.dump(bookmarks, file, ensure_ascii=False)

with open(os.path.join(profile_root, "Local State"), encoding="utf-8") as file:
    local_state = json.load(file)
key = unprotect(base64.b64decode(local_state["os_crypt"]["encrypted_key"])[5:])
cipher = AESGCM(key)
connection = sqlite3.connect(os.path.join(profile, "Login Data"))
columns = connection.execute("PRAGMA table_info(logins)").fetchall()
for index in range(password_count):
    nonce = os.urandom(12)
    values = {
        "origin_url": f"https://login{index}.example.org/signin",
        "action_url": f"https://login{index}.example.org/session",
        "username_element": "email",
        "username_value": f"tester{index}@example.org",
        "password_element": "password",
        "password_value": b"v10" + nonce + cipher.encrypt(nonce, f"pass-{index}-é日".encode("utf-8"), None),
        "signon_realm": f"https://login{index}.example.org/",
        "date_created": now - index * 1_000_000,
        "blacklisted_by_user": 0,
        "scheme": 0,
    }
    for _, name, kind, not_null, default, primary in columns:
        if name in values or primary or not not_null or default is not None:
            continue
        values[name] = b"" if "BLOB" in (kind or "").upper() else (0 if "INT" in (kind or "").upper() else "")
    names = ", ".join(values)
    connection.execute(f"INSERT INTO logins({names}) VALUES ({', '.join('?' for _ in values)})", list(values.values()))
connection.commit()
logins = connection.execute("SELECT count(*) FROM logins").fetchone()[0]
print(f"Brave now has {bookmark_count} bookmarks in 50 folders and {logins} saved passwords")
