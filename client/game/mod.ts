import lateJoin from '../../mod/maps/bo1z/late_join.gsc?raw';

// The engine reads its files over the game's through fs_game, from the map's directory (mods/bo1z under fs_basepath).
export const MOD = 'mods/bo1z';

export async function installMod(opfsRoot: string) {
  let directory = await navigator.storage.getDirectory();
  for (const name of [...opfsRoot.split('/').slice(2), ...MOD.split('/'), 'maps', 'bo1z']) directory = await directory.getDirectoryHandle(name, { create: true });
  const file = await (await directory.getFileHandle('late_join.gsc', { create: true })).createWritable();
  await file.write(lateJoin);
  await file.close();
}
