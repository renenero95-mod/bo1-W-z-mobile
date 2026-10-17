import os, shutil

os.makedirs("screenshots", exist_ok=True)
files = ["1.jpg", "2.jpg", "3.jpg", "4.jpg"]
dest = ["gameplay1.jpg", "settings.jpg", "gameplay2.jpg", "gameplay3.jpg"]

for src, dst in zip(files, dest):
    try:
        shutil.copy(f"/storage/emulated/0/Download/{src}", f"screenshots/{dst}")
    except Exception as e:
        print(f"Errore con {src}: {e}")

with open('README.md', 'r', encoding='utf-8') as f:
    content = f.read()

images_md = """
## Screenshots

*Screenshots shown for educational and technical demonstration purposes only.*

**Gameplay & Touch Controls:**
![Gameplay 1](screenshots/gameplay1.jpg)
![Gameplay 2](screenshots/gameplay2.jpg)
![Gameplay 3](screenshots/gameplay3.jpg)

**Custom Settings Panel:**
![Settings](screenshots/settings.jpg)

"""

if "## Screenshots" not in content:
    content = content.replace("## What this repository does NOT include", images_md + "## What this repository does NOT include")

with open('README.md', 'w', encoding='utf-8') as f:
    f.write(content)
print("README aggiornato con le immagini!")
