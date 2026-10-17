# BO1 Zombies - Mobile WebGPU Port

Porting sperimentale di Call of Duty: Black Ops Zombies (motore KisakBlack) per browser mobile, ottimizzato per Android via WebGPU.

Progetto sviluppato per scopi educativi e di ricerca su WebAssembly/WebGPU: dimostra che un motore desktop complesso puo' girare fluidamente su smartphone.

## Caratteristiche
- Motore: KisakBlack (fork decompilato di CoD T5)
- Stack: WebAssembly + Emscripten + WebGPU
- Piattaforma testata: Android (Chrome 155+), GPU Adreno 740
- Prestazioni: mirror blit ottimizzato (latest-frame-wins + zero-copy), dedup draw call, cache pipeline
- Controlli: touch completo (joystick, look, fire, ADS, ricarica, salto), layout editor, pannello impostazioni

## Cosa NON include
Solo codice. Nessun asset, mappa, modello o suono proprietario di Activision.
Le mappe vengono scaricate a runtime dal giocatore, non sono ridistribuite qui.

## Setup
git clone https://github.com/TUO_USERNAME/bo1z-mobile.git
cd bo1z-mobile
npm install
./build-mobile.sh
nohup env -u PREFIX node server/index.ts > ~/server.log 2>&1 &

Apri Chrome su http://127.0.0.1:8484/kino

## Disclaimer
Tutti i marchi e gli asset appartengono ad Activision. Progetto non affiliato. Codice con licenza GPLv3 (ereditata da KisakBlack).
