# BO1 Zombies - Mobile WebGPU Port (Experimental / Educational)

This repository is a technical study and educational project focused on adapting an existing open-source web engine (KisakBlack) to run on mobile devices (Android) using WebAssembly and WebGPU.

The primary goal of this project is purely educational: to explore and learn how to optimize heavy WebAssembly/WebGPU workloads for modern mobile hardware. It demonstrates that a complex desktop-oriented engine can be adapted to run smoothly on a smartphone browser.

## Features
- Engine: KisakBlack (an open-source decompiled fork of CoD T5).
- Stack: WebAssembly + Emscripten + WebGPU.
- Tested Platform: Android (Chrome 155+), Adreno 740 GPU.
- Performance: optimized mirror blit (latest-frame-wins + zero-copy), draw call deduplication, pipeline cache handling.
- Controls: full touch interface (joystick, look, fire, ADS, reload, jump), layout editor, and settings panel.

## What this repository does NOT include (Legal Disclaimer)
**This repository contains ONLY source code.**
It does NOT contain, host, or distribute any proprietary game assets, including but not limited to maps, textures, models, sounds, or game data.
The maps and game files are downloaded at runtime by the user from third-party sources. We do not provide, endorse, or support the distribution of copyrighted materials. This project is a non-commercial educational study of an existing open-source repository.

## Setup & Installation

To build and run the project locally, follow these steps:

```bash
# 1. Clone the repository
git clone https://github.com/renenero95-mod/bo1-W-z-mobile.git
cd bo1-W-z-mobile

# 2. Install dependencies and build
npm install
./build-mobile.sh

# 3. Start the local server (Termux/Android)
nohup env -u PREFIX node server/index.ts > ~/server.log 2>&1 &
```

## How to Play
Open Chrome on your Android device and navigate to a map:
http://127.0.0.1:8484/kino (or nacht, moon, ascension, etc.)
The URL is clean: the port automatically forces WebGPU on Android devices.

## Disclaimer
Call of Duty: Black Ops and all related assets are trademarks of Activision. This project is NOT affiliated with, endorsed by, or sponsored by Activision.
This repository is an educational fork of the open-source KisakBlack engine, distributed under the GPLv3 license (inherited from the original project).
