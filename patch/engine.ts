import { type Edit, type Import, type Instruction, instructions, leb, type Module, parse, rebuild, sleb, stringAddress, stringAt } from './wasm.ts';

const I32 = 0x7f;
const IMPORTS: Import[] = [
  { module: 'env', name: 'kb_net_send', params: [I32, I32, I32, I32], results: [] },
  { module: 'env', name: 'kb_net_recv', params: [I32, I32, I32], results: [I32] },
  { module: 'env', name: 'kb_net_resolve', params: [I32, I32, I32], results: [I32] },
  { module: 'env', name: 'kb_net_command', params: [I32, I32], results: [I32] },
  { module: 'env', name: 'kb_net_multiplayer', params: [], results: [I32] },
];
const get = (local: number) => [0x20, ...leb(local)];
const i32 = (value: number) => [0x41, ...sleb(value)];
const PACKET_BUFFER = 135824384;

// One site per inlined NET_SendPacket, in body order. Values read from its loopback branch:
// sock = chan->sock or the netsrc_t argument, len = datalen written at slot+1264, data = the memory.copy source.
type Site = { sock: number; len: number; data: number | [number]; adr: [number, number] };
const SENDS: Record<string, Site[]> = {
  'NET_OutOfBandPrint(netsrc_t, netadr_t, char const*)': [{ sock: 0, len: 4, data: PACKET_BUFFER, adr: [1, 0] }],
  'NET_OutOfBandData(netsrc_t, netadr_t, unsigned char const*, int)': [{ sock: 0, len: 2, data: PACKET_BUFFER, adr: [1, 0] }],
  'Netchan_TransmitNextFragment(netchan_t*)': [{ sock: 0, len: 5, data: [8], adr: [2, 1408] }],
  'Netchan_Transmit(netchan_t*, int, char*, bool)': [{ sock: 1, len: 5, data: [7], adr: [4, 1456] }],
  'Netchan_Process(netchan_t*, msg_t*)': [
    { sock: 1, len: 5, data: [4], adr: [3, 2288] },
    { sock: 2, len: 9, data: [12], adr: [3, 2288] },
  ],
};

const isSimd = (ins: Instruction | undefined, sub: number) => ins?.op === 0xfd && ins.sub === sub;

// Inserted bytes are not renumbered: a call to a defined function must already target its shifted index.
function callDefined(module: Module, name: string) {
  const index = module.names.get(name);
  if (index === undefined) throw new Error(`missing function: ${name}`);
  return [0x10, ...leb(index + IMPORTS.length)];
}

function find(module: Module, name: string, matches: (list: Instruction[], k: number) => boolean, expected: number) {
  const index = module.names.get(name);
  if (index === undefined) throw new Error(`missing function: ${name}`);
  const body = module.bodies[index - module.importedFuncs];
  const list = [...instructions(module.bytes, body.code, body.end)];
  const found = list.flatMap((_, k) => (matches(list, k) ? [k] : []));
  if (found.length !== expected) throw new Error(`${name}: ${found.length} site(s) instead of ${expected}`);
  return { index, body, list, found };
}

function patches(module: Module) {
  const [send, recv, resolve, command, multiplayer] = IMPORTS.map((_, i) => [0x10, ...leb(module.importedFuncs + i)]);
  const edits = new Map<number, Edit[]>();
  const add = (index: number, edit: Edit) => edits.set(index, [...(edits.get(index) ?? []), edit]);

  for (const [name, sites] of Object.entries(SENDS)) {
    const copiesAddress = (list: Instruction[], k: number) => list[k].op === 0x20 && list[k + 1].op === 0x20
      && isSimd(list[k + 2], 0) && isSimd(list[k + 3], 11) && list[k + 4]?.op === 0x0b;
    const { index, list, found } = find(module, name, copiesAddress, sites.length);
    found.forEach((k, i) => {
      const { sock, len, data, adr: [local, offset] } = sites[i];
      if (list[k + 1].index !== local || list[k + 2].offset !== offset) throw new Error(`${name} site ${i}: unexpected address`);
      const address = offset ? [...get(local), ...i32(offset), 0x6a] : get(local);
      const bytes = [...get(sock), ...get(len), ...(Array.isArray(data) ? get(data[0]) : i32(data)), ...address, ...send];
      add(index, { at: list[k + 4].at, end: list[k + 4].at, bytes });
    });
  }

  const loop = find(module, 'NET_GetLoopPacket(netsrc_t, netadr_t*, msg_t*)', (_, k) => k === 0, 1);
  add(loop.index, { at: loop.body.code, end: loop.body.code, bytes: [...get(0), ...get(1), ...get(2), ...recv, 0x04, 0x40, ...i32(1), 0x0f, 0x0b] });

  // Original failure (type NA_BAD, return 0): $2 = host NUL-terminated in place of the ':', $0 = port or 0, $1 = netadr_t.
  const failed = (list: Instruction[], k: number) => list[k].op === 0x20 && list[k].index === 1 && list[k + 1].op === 0x41 && list[k + 1].value === 1
    && list[k + 2].op === 0x36 && list[k + 3].op === 0x41 && list[k + 3].value === 0 && list[k + 4]?.op === 0x0b;
  const adr = find(module, 'NET_StringToAdr(char const*, netadr_t*)', failed, 1);
  const [k] = adr.found;
  add(adr.index, { at: adr.list[k].at, end: adr.list[k + 4].at, bytes: [...get(2), ...get(0), ...get(1), ...resolve] });

  // Inlined Sys_IsLANAddress reduced to type == NA_LOOPBACK: an NA_IP address silently dropped the connection.
  const lan = (list: Instruction[], k: number) => list[k].op === 0x20 && list[k].index === 0 && list[k + 1].op === 0x28 && list[k + 1].offset === 16
    && list[k + 2].op === 0x41 && list[k + 2].value === 2 && list[k + 3].op === 0x46 && list[k + 4]?.op === 0x04;
  const connect = find(module, 'CL_Connect_f()', lan, 1);
  const [c] = connect.found;
  const loadType = module.bytes.subarray(connect.list[c].at, connect.list[c + 1].end);
  // (20 >> type) & 1: bits 2 (NA_LOOPBACK) and 4 (NA_IP).
  add(connect.index, { at: connect.list[c].at, end: connect.list[c + 4].at, bytes: [...i32(20), ...loadType, 0x76, ...i32(1), 0x71] });

  // A guest connects from its command line: the front end's "map frontend" would drop that connection (CA_CONNECTING = 4).
  const setState = find(module, 'CL_SetLocalClientConnectionState(int, connstate_t)', (_, k) => k === 0, 1);
  const connectionState = setState.list.find((ins, k) => ins.op === 0x41 && setState.list[k + 1]?.op === 0x20 && setState.list[k + 2]?.op === 0x36)!.value!;
  const frontEnd = module.names.get('Com_LoadFrontEnd()');
  const startup = find(module, 'main', (list, k) => list[k].op === 0x10 && list[k].index === frontEnd, 1);
  const [s] = startup.found;
  add(startup.index, { at: startup.list[s].at, end: startup.list[s].end,
    bytes: [...i32(connectionState), 0x28, 0x02, 0x00, ...i32(4), 0x48, 0x04, 0x40, ...callDefined(module, 'Com_LoadFrontEnd()'), 0x0b] });

  // zombiemode picks the entity field tables: a guest, with no map loaded, takes it from the host's map name before the
  // baselines, as Com_LoadLevelFastFiles does from the same name on the host.
  const strncmp = module.names.get('I_strncmp(char const*, char const*, int)');
  const modeSet = find(module, 'Com_LoadLevelFastFiles(char*)', (list, k) => list[k].op === 0x41 && list[k + 1]?.op === 0x28
    && list[k + 3]?.op === 0x04 && list[k + 9]?.op === 0x10 && list[k + 9].index === strncmp, 1);
  const zombiemode = modeSet.list[modeSet.found[0]].value!;
  const readString = module.names.get('MSG_ReadString(msg_t*, char*, unsigned int)');
  const gamestate = find(module, 'CL_ParseGamestate(int, msg_t*)', (list, k) => list[k].op === 0x10 && list[k].index === readString && list[k - 2]?.op === 0x22, 2);
  const [m] = gamestate.found;
  add(gamestate.index, { at: gamestate.list[m + 1].end, end: gamestate.list[m + 1].end, bytes: [...i32(zombiemode), 0x28, 0x02, 0x00,
    ...get(gamestate.list[m - 2].index!), ...callDefined(module, 'Com_IsZombieMap(char const*)'), ...i32(0), ...callDefined(module, 'Dvar_SetBoolFromSource(dvar_s*, bool, DvarSetSource)')] });

  // Without a local server, a client compiles the server scripts for their anim trees, whose order and anims the
  // network refers to by index: in zombies, the host's list (G_InitGame) instead of MP's gametype and level scripts.
  const text = (value: string) => i32(stringAddress(module, value));
  const call = (name: string) => callDefined(module, name);
  const LOAD = 'Scr_LoadScript(scriptInstance_t, char*)', SPAWN_STRING = 'G_SpawnString(SpawnVar const*, char const*, char const*, char const**)';
  const parseSpawnVars = module.names.get('G_ParseSpawnVars(SpawnVar*)');
  const entities = find(module, 'G_InitGame(int, int, int, int, bool, SPSaveGame**)', (list, k) => list[k].op === 0x41
    && list[k + 1]?.op === 0x10 && list[k + 1].index === parseSpawnVars && list[k + 3]?.op === 0x03 && stringAt(module, list[k + 16]?.value ?? 0) === 'actor_', 1);
  const spawnVar = entities.list[entities.found[0]].value!;
  const findTree = module.names.get('Scr_FindAnimTree(scriptInstance_t, char const*)');
  const actorTree = find(module, 'G_InitGame(int, int, int, int, bool, SPSaveGame**)', (list, k) => list[k].op === 0x41
    && list[k + 2]?.op === 0x10 && list[k + 2].index === findTree, 1);
  const actorAnims = actorTree.list[actorTree.found[0]].value!;
  // Frame of the inlined CGScr_LoadScripts: $2 = 112 bytes (va args at 0, file name at 32), $3 = mapname, $4 = file name.
  const slot = (offset: number) => [...get(2), 0x28, 0x02, ...leb(offset)];
  const loadFile = (file: string) => [...i32(0), ...text(file), ...call(LOAD), 0x1a];
  const loadFormatted = (format: string, arg: number[]) => [...get(2), ...arg, 0x36, 0x02, 0x00,
    ...get(4), ...i32(64), ...text(format), ...get(2), ...call('Com_sprintf(char*, unsigned int, char const*, ...)'), 0x1a,
    ...i32(0), ...get(4), ...call(LOAD), 0x1a];
  const ANIMSCRIPTS = ['zombie_combat', 'zombie_death', 'zombie_init', 'zombie_pain', 'zombie_move', 'zombie_scripted', 'zombie_stop',
    'zombie_dog_combat', 'zombie_dog_death', 'zombie_dog_init', 'zombie_dog_pain', 'zombie_dog_move', 'zombie_dog_scripted',
    'zombie_dog_stop', 'zombie_dog_flashed', 'zombie_dog_turn'];
  const loadLabel = module.names.get('CGScr_LoadScriptAndLabel(scriptInstance_t, char const*, char const*, ScriptFunctions*)');
  const complete = find(module, 'CL_DownloadsComplete(int)', (list, k) => list[k].op === 0x41 && list[k].value === 0
    && list[k + 1]?.op === 0x41 && stringAt(module, list[k + 1].value!) === 'maps/mp/_destructible' && list[k + 4]?.op === 0x10 && list[k + 4].index === loadLabel, 1);
  const [d] = complete.found;
  const levelScript = complete.list.flatMap((ins, k) => (k > d && ins.op === 0x10 && ins.index === loadLabel ? [k] : []))[3];
  add(complete.index, { at: complete.list[d].at, end: complete.list[d].at, bytes: [
    ...call('Com_IsSPLevel()'), 0x04, 0x40,
    ...get(2), ...i32(32), 0x6a, 0x21, ...leb(4),
    ...loadFile('maps/_callbacksetup'), ...loadFile('maps/_destructible'),
    ...ANIMSCRIPTS.flatMap(name => loadFormatted('animscripts/%s', text(name))),
    ...loadFormatted('maps/%s', get(3)),
    ...call('G_ResetEntityParsePoint()'),
    0x02, 0x40, 0x03, 0x40,
    ...i32(spawnVar), ...call('G_ParseSpawnVars(SpawnVar*)'), 0x45, 0x0d, ...leb(1),
    ...i32(spawnVar), ...text('classname'), ...text(''), ...get(2), ...i32(96), 0x6a, ...call(SPAWN_STRING), 0x1a,
    ...slot(96), ...text('actor_'), ...i32(6), ...call('strncmp'), 0x45,
    0x04, 0x40, ...loadFormatted('aitype/%s', [...slot(96), ...i32(6), 0x6a]),
    0x05, ...slot(96), ...text('node_negotiation_begin'), ...call('I_stricmp(char const*, char const*)'), 0x45,
    0x04, 0x40, ...i32(spawnVar), ...text('animscript'), ...text(''), ...get(2), ...i32(100), 0x6a, ...call(SPAWN_STRING), 0x1a,
    ...slot(100), 0x2d, 0x00, 0x00, 0x04, 0x40, ...loadFormatted('animscripts/traverse/%s', slot(100)), 0x0b,
    0x0b, 0x0b,
    0x0c, ...leb(0), 0x0b, 0x0b,
    0x05,
  ] });
  add(complete.index, { at: complete.list[levelScript].end, end: complete.list[levelScript].end, bytes: [0x0b] });
  // The zombies' tree, which the host takes from its own scripts (G_SP_FindActorAnimTree), before the trees close.
  const loadAnim = module.names.get('BG_LoadAnim(char const*)');
  const anim = complete.list.findIndex((ins, k) => k > levelScript && ins.op === 0x10 && ins.index === loadAnim);
  add(complete.index, { at: complete.list[anim].end, end: complete.list[anim].end, bytes: [...call('Com_IsSPLevel()'), 0x04, 0x40,
    ...i32(actorAnims), ...text('generic_human'), ...call('Scr_FindAnimTree(scriptInstance_t, char const*)'), 0x36, 0x02, 0x00, 0x0b] });
  // Freeing those scripts empties the list, which MP no longer reads but zombies does (Scr_GetClientAnims): its count
  // survives the free, its trees live in the level's hunk.
  const clientAnims = find(module, 'Scr_GetClientAnims(unsigned int, scriptInstance_t)', (list, k) => list[k].op === 0x41
    && list[k - 1]?.op === 0x22 && list[k + 1]?.op === 0x6a && list[k + 2]?.op === 0x28, 1);
  const clientTrees = clientAnims.list[clientAnims.found[0]].value!;
  const freeScripts = module.names.get('Scr_FreeScripts(scriptInstance_t, unsigned char)');
  const free = complete.list.findIndex((ins, k) => ins.op === 0x10 && ins.index === freeScripts && complete.list[k - 1].op === 0x41);
  add(complete.index, { at: complete.list[free - 1].at, end: complete.list[free - 1].at, bytes: [...i32(clientTrees), ...i32(clientTrees), 0x28, 0x02, 0x00] });
  add(complete.index, { at: complete.list[free].end, end: complete.list[free].end, bytes: [...i32(0), ...call('Com_IsSPLevel()'), 0x1b, 0x36, 0x02, 0x00] });

  // The mod's late-join script (mod/, read through fs_game) runs after the level's main from the first slot of an extra
  // zone's level script (g_modZoneLevelScripts, empty without bo1_mod_zones). Compiled last, so the anim trees keep their order.
  const zoneName = module.names.get('DB_GetModExtraZoneName(int, char*, int)');
  const zones = find(module, 'G_InitGame(int, int, int, int, bool, SPSaveGame**)', (list, k) => list[k].op === 0x41 && list[k + 1]?.op === 0x41
    && list[k + 1].value === 0 && list[k + 2]?.op === 0x36 && list[k + 8]?.op === 0x10 && list[k + 8].index === zoneName, 2);
  const zoneScript = zones.list[zones.found[0]].value!;
  const postCompile = module.names.get('Scr_PostCompileScripts(scriptInstance_t)');
  const compiled = zones.list.findIndex((ins, k) => ins.op === 0x10 && ins.index === postCompile && zones.list[k - 1].op === 0x41);
  // Its name, which the engine does not hold, goes on the stack.
  const path = new TextEncoder().encode('maps/bo1z/late_join');
  const name = new Uint8Array((path.length + 4) & ~3);
  name.set(path);
  const words = new DataView(name.buffer);
  const nameOnStack = [...name].flatMap((_, i) => (i % 4 ? [] : [0x23, 0x00, ...i32(words.getInt32(i, true)), 0x36, 0x02, ...leb(i)]));
  add(zones.index, { at: zones.list[compiled - 1].at, end: zones.list[compiled - 1].at, bytes: [
    ...call('Com_IsSPLevel()'), 0x04, 0x40, ...i32(zoneScript), 0x28, 0x02, 0x00, 0x45, 0x04, 0x40,
    0x23, 0x00, ...i32(32), 0x6b, 0x24, 0x00, ...nameOnStack,
    ...i32(zoneScript), 0x23, 0x00, ...text('main'), ...i32(0),
    ...call('GScr_LoadScriptAndLabel(scriptInstance_t, char const*, char const*, int)'), 0x36, 0x02, 0x00,
    0x23, 0x00, ...i32(32), 0x6a, 0x24, 0x00,
    0x0b, 0x0b,
  ] });

  // In multiplayer, neither a menu (CL_PauseGame) nor the page's intro hold (cl_paused) may freeze the host: inlined
  // SV_CheckPaused left a joining player's challenge unanswered. In solo, the game's pause stays.
  const pause = find(module, 'CL_PauseGame(bool)', (_, k) => k === 0, 1);
  add(pause.index, { at: pause.body.code, end: pause.body.code, bytes: [...multiplayer, 0x04, 0x40, ...i32(0), 0x21, ...leb(0), 0x0b] });

  // Released (2) at once: held, an armed guest drew MisaDev4's paused gun (CG_AddViewWeapon) from a never-set placement, 450 to 490 asserts in 8 s.
  const setIntByName = module.names.get('Dvar_SetIntByName(char const*, int)');
  const hold = find(module, 'BrowserFrame(void*)', (list, k) => list[k].op === 0x41 && list[k + 1]?.op === 0x41 && list[k + 1].value === 1
    && list[k + 2]?.op === 0x36 && stringAt(module, list[k + 3]?.value ?? 0) === 'cl_paused' && list[k + 4]?.value === 1
    && list[k + 5]?.op === 0x10 && list[k + 5].index === setIntByName, 1);
  const [h] = hold.found;
  add(hold.index, { at: hold.list[h].at, end: hold.list[h].at, bytes: [...multiplayer, 0x04, 0x40, ...i32(hold.list[h].value!), ...i32(2), 0x36, 0x02, 0x00, 0x0c, 0x01, 0x0b] });

  // Escape during the load that follows connect (no connection nor game yet) raised
  // Com_Error(ERR_DISCONNECT, "Bad server address"): the joining player's game stopped 0.5 s after connect.
  const comError = module.names.get('Com_Error(errorParm_t, char const*, ...)');
  const escapeError = (list: Instruction[], k: number) => list[k].op === 0x41 && list[k + 1]?.op === 0x28 && list[k + 2]?.op === 0x45
    && list[k + 3]?.op === 0x0d && list[k + 3].index === 0 && list[k + 4]?.op === 0x41 && list[k + 4].value === 3
    && list[k + 5]?.op === 0x41 && list[k + 6]?.op === 0x41 && list[k + 6].value === 0
    && list[k + 7]?.op === 0x10 && list[k + 7].index === comError && list[k + 8]?.op === 0x0b;
  const keys = find(module, 'CL_KeyEvent(int, int, int, unsigned int)', escapeError, 1);
  const [e] = keys.found;
  add(keys.index, { at: keys.list[e].at, end: keys.list[e + 8].at, bytes: [] });

  // vel.gg's collision-tree history took each caller as a JavaScript stack trace: 9 % of the main thread with two players.
  const returnAddress = module.names.get('emscripten_return_address');
  for (const name of ['CG_LinkEntityColl(int, unsigned int, float const*, float const*)', 'CG_UnlinkEntityColl(int, unsigned int)']) {
    const site = find(module, name, (list, k) => list[k].op === 0x10 && list[k].index === returnAddress, 1);
    const [r] = site.found;
    add(site.index, { at: site.list[r].at, end: site.list[r].end, bytes: [0x1a, ...i32(0)] });
  }

  // A joining client's attachedVehEntNum stayed 0 until its first ClientEndFrame (11 to 23 ms): a host's snapshot then asserted (1 Moon join in 9).
  const spawn = find(module, 'ClientSpawn(gentity_s*, float const*, float const*)', (list, k) => list[k].op === 0x41 && list[k].value === 1023
    && list[k + 1]?.op === 0x36 && list[k + 4]?.op === 0x36, 1);
  const [vehicleAt, indexAt] = [spawn.list[spawn.found[0] + 1].offset!, spawn.list[spawn.found[0] + 4].offset!];
  const joining = find(module, 'ClientConnect(unsigned int, unsigned int)', (list, k) => list[k].op === 0x36 && list[k].offset === indexAt, 1);
  const [j] = joining.found;
  add(joining.index, { at: joining.list[j].end, end: joining.list[j].end, bytes: [...get(joining.list[j - 2].index!), ...i32(1023), 0x36, 0x02, ...leb(vehicleAt)] });

  // A zone's sound patches applied under SOUND_BANK took SOUND_LOOKUP_CACHE, SND_FindAliasId's order reversed: a guest's CG_Init
  // runs while its map loads, and both threads waited on each other for good (1 Moon load in 4). The lookup takes SOUND_BANK itself.
  const enterAt = module.names.get('Sys_EnterCriticalSectionAt(CriticalSection, char const*, int)');
  const aliasLookup = module.names.get('SND_BankAliasLookup(unsigned int)');
  const patchLock = find(module, 'SND_PatchApply(SndPatch const*)', (list, k) => list[k].op === 0x41 && list[k + 3]?.op === 0x10
    && list[k + 3].index === enterAt && list[k + 5]?.index === aliasLookup && list[k + 6]?.value === list[k].value, 1);
  const [p] = patchLock.found;
  add(patchLock.index, { at: patchLock.list[p].at, end: patchLock.list[p + 4].at, bytes: [] });
  add(patchLock.index, { at: patchLock.list[p + 6].at, end: patchLock.list[p + 8].at, bytes: [] });

  // Fatal assertions: none known left in a lobby, kept until its games over, downs and revives have run without it.
  const asserts = find(module, 'Assert_MyHandler(char const*, int, int, char const*, ...)', (list, k) => list[k].op === 0x00 && list[k + 1]?.op === 0x0b && k + 2 === list.length, 1);
  const frameSize = asserts.list.find(ins => ins.op === 0x41)!.value!;
  const frameBase = asserts.list.find(ins => ins.op === 0x22)!.index!;
  const [u] = asserts.found;
  add(asserts.index, { at: asserts.list[u].at, end: asserts.list[u].end, bytes: [...get(frameBase), ...i32(frameSize), 0x6a, 0x24, ...leb(0), ...i32(1)] });

  // An effect without a material on the joining player: a read at address 176, then unreachable; the caller skips the draw on 0.
  const technique = find(module, 'Material_GetTechnique(Material const*, unsigned char)', (list, k) => list[k].op === 0x00 && k + 2 === list.length, 1);
  const techniqueFrame = technique.list.find(ins => ins.op === 0x41)!.value!;
  const techniqueBase = technique.list.find(ins => ins.op === 0x22)!.index!;
  const [t] = technique.found;
  add(technique.index, { at: technique.body.code, end: technique.body.code, bytes: [...get(0), 0x45, 0x04, 0x40, ...i32(0), 0x0f, 0x0b] });
  add(technique.index, { at: technique.list[t].at, end: technique.list[t].end, bytes: [0x1a, ...get(techniqueBase), ...i32(techniqueFrame), 0x6a, 0x24, ...leb(0), ...i32(0)] });

  // A teammate has no DObj until the zombies script gives it a model (8 s after a map_restart): its overhead name raised ERR_DROP.
  const noDObj = (list: Instruction[], k: number) => list[k].op === 0x41 && list[k].value === 1 && list[k + 1]?.op === 0x41
    && list[k + 2]?.op === 0x41 && list[k + 2].value === 0 && list[k + 3]?.op === 0x10 && list[k + 3].index === comError && list[k + 4]?.op === 0x0b;
  const tag = find(module, 'CachedTag_UpdateTagInternal(centity_s const*, cached_client_tag_t*, unsigned int, int, bool)', noDObj, 1);
  const [g] = tag.found;
  add(tag.index, { at: tag.list[g].at, end: tag.list[g + 4].at, bytes: [] });

  // A command posted by the page (kbnet.command) goes to Cbuf_AddText, through a 512-byte buffer taken on the stack.
  const STACK = [0x23, ...leb(0)];
  const events = find(module, 'Com_EventLoop()', (_, k) => k === 0, 1);
  add(events.index, { at: events.body.code, end: events.body.code, bytes: [
    ...STACK, ...i32(512), 0x6b, 0x24, ...leb(0),
    ...STACK, ...i32(512), ...command, 0x04, 0x40, ...i32(0), ...STACK, ...callDefined(module, 'Cbuf_AddText(int, char const*)'), 0x0b,
    ...STACK, ...i32(512), 0x6a, 0x24, ...leb(0),
  ] });
  return edits;
}

export function patchEngine(original: Uint8Array) {
  const module = parse(new Uint8Array(original));
  const wasm = rebuild(module, { imports: IMPORTS, edits: patches(module) });
  if (!WebAssembly.validate(wasm)) throw new Error('The patched wasm is invalid');
  return wasm;
}
