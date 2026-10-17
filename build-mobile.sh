#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "=== 1. Vite build ==="
npx vite build

MJS="dist/artifacts/KisakBlack-web.mjs"
POLY="dist/webgpu-polyfill.js"

if [ ! -f "$MJS" ]; then echo "MANCA $MJS"; exit 1; fi

echo "=== 2. Patch feature list (array) ==="
python3 - "$MJS" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    data = f.read()
old = '["texture-compression-bc","depth32float-stencil8","float32-filterable","float32-blendable"]'
new = '["texture-compression-bc","depth32float-stencil8","float32-blendable"]'
count = data.count(old)
print(f"Array 4->3: occorrenze {count}")
if count != 1:
    print("ERRORE: attese 1 occorrenza")
    sys.exit(1)
data = data.replace(old, new)
with open(path, "w", encoding="utf-8") as f:
    f.write(data)
print("Patch array applicata.")
PYEOF

echo "=== 3. Patch warmPump (guardia this.warm) ==="
python3 - "$MJS" <<'PYEOF'
import sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    data = f.read()

# Cerca la definizione warmPump(extra=0){
old = "warmPump(extra=0){if(!this.warmQueue?.length"
new = "warmPump(extra=0){if(!this.warm)this.warm={rows:0,queued:0,done:0,failed:0,t0:performance.now(),seeded:0,inflight:0,maxInflight:0,lat:[],compareRows:0,released:false,playing:false,end:false,sweepInflight:0,sweepDone:0,sweepRows:0,sweepT0:0};if(!this.warmQueue?.length"

count = data.count(old)
print(f"warmPump guardia: occorrenze {count}")
if count != 1:
    print("ERRORE: attese 1 occorrenza del pattern warmPump")
    print("Cerco pattern alternativi...")
    import re
    for m in re.finditer(r'warmPump\(extra=0\)\{', data):
        print(f"  offset={m.start()}: {data[m.start():m.start()+80]!r}")
    sys.exit(1)

data = data.replace(old, new)
with open(path, "w", encoding="utf-8") as f:
    f.write(data)
print("Patch warmPump applicata.")
PYEOF

echo "=== 4. Verifica sintattica ==="
node --check "$MJS" 2>&1; echo "EXIT=$?"

echo "=== 5. Verifica FeatureName intatta ==="
grep -o 'FeatureName.\{0,80\}' "$MJS" | head -1

echo "=== 5.5 Prepend mirror-worker-hook ==="
python3 - "$MJS" <<'PYEOF'
import sys, os
path = sys.argv[1]
hook = "client/public/mirror-worker-hook.js"
if not os.path.exists(hook):
    print("MANCA " + hook)
    sys.exit(1)
with open(hook, "r", encoding="utf-8") as f:
    hookcode = f.read()
with open(path, "r", encoding="utf-8") as f:
    data = f.read()
with open(path, "w", encoding="utf-8") as f:
    f.write(hookcode + "\n" + data)
print("mirror-worker-hook prepended (" + str(len(hookcode)) + " char)")
PYEOF

echo "=== 6. Prepend polyfill ==="
if [ -f "$POLY" ]; then
    cp "$MJS" "$MJS.bak"
    cat "$POLY" "$MJS.bak" > "$MJS"
    rm "$MJS.bak"
    echo "Polyfill prepended."
fi

echo "=== 7. Verifica finale ==="
node --check "$MJS" 2>&1; echo "final-EXIT=$?"
ls -la "$MJS"
