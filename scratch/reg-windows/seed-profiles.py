import json, sys
path = sys.argv[1]
d = json.load(open(path))
for i, (pid, name, color) in enumerate([("p-reg2", "Work", "blue"), ("p-reg3", "Side", "green")]):
    d["profiles"][pid] = {"id": pid, "name": name, "color": color, "icon": None, "createdAt": 1795180000000 + i}
    if pid not in d["profileOrder"]:
        d["profileOrder"].append(pid)
d["settings"]["unloadProfilesAfter"] = "5m"
d["settings"]["memorySaver"] = True
json.dump(d, open(path, "w"))
