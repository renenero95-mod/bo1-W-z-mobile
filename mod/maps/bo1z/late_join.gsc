// A player who arrives once the game has started: the zombies scripts place players and thaw them only at the start
// (_zombiemode::coop_player_spawn_placement, _zombiemode_utility::fade_in), so it would stay frozen where it spawned,
// with no respawn point for the end of the round. This does for it what the start does for the others.
#include common_scripts\utility;

main()
{
	while ( !IsDefined( level.flag ) || !IsDefined( level.flag["all_players_spawned"] ) )
		wait( 0.05 );
	flag_wait( "all_players_spawned" );

	for ( ;; )
	{
		level waittill( "connected", player );
		player thread late_join();
	}
}

late_join()
{
	self endon( "disconnect" );
	self waittill( "spawned_player" );
	// _zombiemode::onPlayerSpawned freezes a first spawn on the same notify.
	wait( 0.05 );

	structs = getstructarray( "initial_spawn_points", "targetname" );
	self.spectator_respawn = structs[ self.entity_num % structs.size ];
	origin = maps\_zombiemode::check_for_valid_spawn_near_team( self );
	if ( !IsDefined( origin ) )
		origin = self.spectator_respawn.origin;

	self SetOrigin( origin );
	self SetPlayerAngles( self.spectator_respawn.angles );
	self FreezeControls( false );
}
