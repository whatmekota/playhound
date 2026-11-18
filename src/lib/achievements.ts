/**
 * Achievements: badges earned from what playhound already knows (the stats,
 * the library, the session log) and from a handful of counted moments (an
 * edit saved, a share card made, panic pressed). Private and local, like the
 * stats they come from.
 *
 * Each one reads a number off the facts and is earned when it reaches its
 * target, so counted ones show how far along they are. Pure: the facts are
 * gathered elsewhere (useAchievements) and handed in.
 */

import type { SessionLog } from './sessionLog'

export type AchievementGroup = 'watching' | 'edging' | 'finishing' | 'time' | 'library' | 'scripts' | 'devices' | 'features' | 'meta'

export const ACHIEVEMENT_GROUPS: { id: AchievementGroup, label: string, icon: string }[] = [
  { id: 'watching', label: 'Watching', icon: 'i-carbon-play-outline' },
  { id: 'edging', label: 'Edging', icon: 'i-carbon-hourglass' },
  { id: 'finishing', label: 'Finishing', icon: 'i-carbon-flag' },
  { id: 'time', label: 'Time and dates', icon: 'i-carbon-calendar' },
  { id: 'library', label: 'Library', icon: 'i-carbon-catalog' },
  { id: 'scripts', label: 'Making things', icon: 'i-carbon-edit' },
  { id: 'devices', label: 'Devices', icon: 'i-carbon-plug' },
  { id: 'features', label: 'Exploring', icon: 'i-carbon-explore' },
  { id: 'meta', label: 'Achievements', icon: 'i-carbon-trophy' },
]

/** 1 bronze, 2 silver, 3 gold, 4 platinum. */
export type AchievementTier = 1 | 2 | 3 | 4

export const TIER_LABEL: Record<AchievementTier, string> = { 1: 'Bronze', 2: 'Silver', 3: 'Gold', 4: 'Platinum' }

/** Everything the achievements read. */
export interface AchievementFacts {
  watchMs: number
  plays: number
  /** Different videos played. */
  videosPlayed: number
  /** The most plays of any one video. */
  mostPlays: number
  finishes: number
  /** Different videos finished to. */
  videosFinished: number
  edges: number
  sessions: number
  longestSessionMs: number
  maxEdgesInSession: number
  maxFinishesInSession: number
  maxVideosInSession: number
  /** In one session, the most edges called before its first finish. */
  edgesBeforeFinish: number
  /** Shortest time from a session's start to its first finish, ms; null with none. */
  fastestFinishMs: number | null
  /** Longest session that ended in a finish, ms. */
  longestFinishedSessionMs: number
  /** Fastest and slowest script rate at a finish, strokes a minute; 0 / null when unknown. */
  finishTopSpm: number
  finishLowSpm: number | null
  heartMax: number
  heartSessions: number
  /** Edges by who called them: key, heart, programme, rule… */
  edgeSources: Record<string, number>
  daysActive: number
  bestStreak: number
  weekendDays: number
  /** Plays started in each hour of the day (0–23). */
  hours: number[]
  /** Plays on a weekday between 12 and 1 pm. */
  lunchPlays: number
  /** Special days played on: 'xmas', 'newyear', 'halloween', 'valentine', 'aprilfools', 'friday13', 'leap', 'birthday'. */
  specialDays: string[]
  library: {
    videos: number
    scripted: number
    multiAxis: number
    starred: number
    tagged: number
  }
  playlists: number
  biggestPlaylist: number
  bookmarks: number
  patterns: number
  rules: number
  programmes: number
  plugins: number
  /** Counted moments (see achievementEvents): 'edit-save', 'panic', 'device:handy'… */
  counters: Record<string, number>
  /** Achievements earned so far, for the ones about achievements. */
  earned: number
}

export interface AchievementDef {
  id: string
  title: string
  description: string
  icon: string
  group: AchievementGroup
  tier: AchievementTier
  /** Shown as a secret until it is earned. */
  hidden?: boolean
  /** Where the facts are on the way to `target`. */
  value: (f: AchievementFacts) => number
  /** Earned at this; 1 for a yes-or-no one. */
  target: number
  /** How to show progress: a count, or hours. */
  unit?: 'count' | 'hours'
}

const H = 3_600_000
const c = (f: AchievementFacts, k: string) => f.counters[k] ?? 0
const yes = (b: boolean) => (b ? 1 : 0)

/** Many of a kind: "Play 10 videos", "Play 100 videos"… */
function ladder(
  base: Omit<AchievementDef, 'id' | 'title' | 'description' | 'tier' | 'target'>,
  id: string,
  steps: [target: number, title: string, description: string, tier: AchievementTier][],
): AchievementDef[] {
  return steps.map(([target, title, description, tier]) => ({ ...base, id: `${id}-${target}`, title, description, tier, target }))
}

export const ACHIEVEMENTS: AchievementDef[] = [
  // ── Watching ────────────────────────────────────────────────────────────
  { id: 'first-play', title: 'Press play', description: 'Play your first video', icon: 'i-carbon-play-filled-alt', group: 'watching', tier: 1, value: f => f.plays, target: 1 },
  ...ladder({ icon: 'i-carbon-play-outline', group: 'watching', value: f => f.plays }, 'plays', [
    [10, 'Regular', 'Play 10 videos', 1],
    [100, 'Frequent flyer', 'Play 100 videos', 2],
    [500, 'Devotee', 'Play 500 videos', 3],
    [2000, 'Lifer', 'Play 2,000 videos', 4],
  ]),
  ...ladder({ icon: 'i-carbon-time', group: 'watching', value: f => f.watchMs / H, unit: 'hours' }, 'hours', [
    [1, 'First hour', 'Watch for an hour in all', 1],
    [10, 'Ten hours in', 'Watch for 10 hours in all', 2],
    [50, 'Fifty', 'Watch for 50 hours in all', 3],
    [200, 'Two hundred', 'Watch for 200 hours in all', 4],
  ]),
  ...ladder({ icon: 'i-carbon-collapse-categories', group: 'watching', value: f => f.videosPlayed }, 'videos', [
    [25, 'Sampler', 'Play 25 different videos', 1],
    [100, 'Connoisseur', 'Play 100 different videos', 2],
    [500, 'Archivist', 'Play 500 different videos', 3],
    [1000, 'Seen it all', 'Play 1,000 different videos', 4],
  ]),
  { id: 'repeat-10', title: 'On repeat', description: 'Play the same video 10 times', icon: 'i-carbon-repeat', group: 'watching', tier: 2, value: f => f.mostPlays, target: 10 },
  { id: 'repeat-50', title: 'Comfort video', description: 'Play the same video 50 times', icon: 'i-carbon-repeat-one', group: 'watching', tier: 3, value: f => f.mostPlays, target: 50 },
  { id: 'session-1h', title: 'Settling in', description: 'A session over an hour long', icon: 'i-carbon-hourglass', group: 'watching', tier: 1, value: f => f.longestSessionMs / H, target: 1, unit: 'hours' },
  { id: 'session-2h', title: 'Marathon', description: 'A session over two hours long', icon: 'i-carbon-pedestrian', group: 'watching', tier: 2, value: f => f.longestSessionMs / H, target: 2, unit: 'hours' },
  { id: 'session-4h', title: 'Ultramarathon', description: 'A session over four hours long', icon: 'i-carbon-mountain', group: 'watching', tier: 3, value: f => f.longestSessionMs / H, target: 4, unit: 'hours' },
  { id: 'surfer', title: 'Channel surfer', description: 'Play 20 videos in one session', icon: 'i-carbon-skip-forward', group: 'watching', tier: 2, value: f => f.maxVideosInSession, target: 20 },
  { id: 'binge', title: 'Binge', description: 'Play 50 videos in one session', icon: 'i-carbon-fire', group: 'watching', tier: 3, hidden: true, value: f => f.maxVideosInSession, target: 50 },

  // ── Edging ──────────────────────────────────────────────────────────────
  // A few: plenty of people never edge, toys or not.
  { id: 'first-edge', title: 'Brakes work', description: 'Call your first edge', icon: 'i-carbon-pause-outline', group: 'edging', tier: 1, value: f => f.edges, target: 1 },
  { id: 'edges-25', title: 'Edger', description: 'Call 25 edges', icon: 'i-carbon-hourglass', group: 'edging', tier: 1, value: f => f.edges, target: 25 },
  { id: 'edges-100', title: 'Edge lord', description: 'Call 100 edges', icon: 'i-carbon-hourglass', group: 'edging', tier: 2, value: f => f.edges, target: 100 },
  { id: 'session-edges-5', title: 'Holding on', description: 'Five edges in one session', icon: 'i-carbon-touch-1', group: 'edging', tier: 2, value: f => f.maxEdgesInSession, target: 5 },
  { id: 'heart-edge', title: 'Listen to your heart', description: 'Have the heart-rate guard call an edge for you', icon: 'i-carbon-favorite', group: 'edging', tier: 2, value: f => f.edgeSources.heart ?? 0, target: 1 },

  // ── Finishing ───────────────────────────────────────────────────────────
  { id: 'first-finish', title: 'The end', description: 'Mark your first finish', icon: 'i-carbon-flag-filled', group: 'finishing', tier: 1, value: f => f.finishes, target: 1 },
  ...ladder({ icon: 'i-carbon-flag', group: 'finishing', value: f => f.finishes }, 'finishes', [
    [10, 'Habit', 'Mark 10 finishes', 1],
    [50, 'Seasoned', 'Mark 50 finishes', 2],
    [200, 'Prolific', 'Mark 200 finishes', 3],
    [500, 'Legend', 'Mark 500 finishes', 4],
  ]),
  { id: 'wide-taste', title: 'Wide taste', description: 'Finish to 25 different videos', icon: 'i-carbon-collapse-categories', group: 'finishing', tier: 2, value: f => f.videosFinished, target: 25 },
  { id: 'variety', title: 'Variety is the spice', description: 'Finish to 100 different videos', icon: 'i-carbon-apple', group: 'finishing', tier: 3, value: f => f.videosFinished, target: 100 },
  { id: 'speedrun', title: 'Speedrun', description: 'Finish within three minutes of starting', icon: 'i-carbon-lightning', group: 'finishing', tier: 1, hidden: true, value: f => yes(f.fastestFinishMs !== null && f.fastestFinishMs <= 3 * 60_000), target: 1 },
  { id: 'slow-burn', title: 'Slow burn', description: 'Finish after a session of 90 minutes or more', icon: 'i-carbon-fire', group: 'finishing', tier: 2, value: f => yes(f.longestFinishedSessionMs >= 90 * 60_000), target: 1 },
  { id: 'encore', title: 'Encore', description: 'Two finishes in one session', icon: 'i-carbon-restart', group: 'finishing', tier: 2, hidden: true, value: f => f.maxFinishesInSession, target: 2 },
  { id: 'hat-trick', title: 'Hat trick', description: 'Three finishes in one session', icon: 'i-carbon-trophy', group: 'finishing', tier: 3, hidden: true, value: f => f.maxFinishesInSession, target: 3 },
  { id: 'full-throttle', title: 'Full throttle', description: 'Finish while the script goes at 250 strokes a minute or more', icon: 'i-carbon-meter-alt', group: 'finishing', tier: 2, value: f => yes(f.finishTopSpm >= 250), target: 1 },
  { id: 'gentle-touch', title: 'Gentle touch', description: 'Finish while the script goes slower than 60 strokes a minute', icon: 'i-carbon-cloud', group: 'finishing', tier: 2, hidden: true, value: f => yes(f.finishLowSpm !== null && f.finishLowSpm < 60), target: 1 },
  { id: 'racing-heart', title: 'Racing heart', description: 'Reach 150 beats a minute', icon: 'i-carbon-activity', group: 'finishing', tier: 2, value: f => yes(f.heartMax >= 150), target: 1 },
  { id: 'cardio', title: 'Cardio', description: 'Ten sessions with a heart-rate monitor on', icon: 'i-carbon-favorite-filled', group: 'finishing', tier: 2, value: f => f.heartSessions, target: 10 },

  // ── Time and dates ──────────────────────────────────────────────────────
  { id: 'night-owl', title: 'Night owl', description: 'Play something between 2 and 5 am', icon: 'i-carbon-moon', group: 'time', tier: 1, value: f => f.hours[2] + f.hours[3] + f.hours[4], target: 1 },
  { id: 'early-bird', title: 'Early bird', description: 'Play something between 5 and 7 am', icon: 'i-carbon-sunrise', group: 'time', tier: 1, value: f => f.hours[5] + f.hours[6], target: 1 },
  { id: 'lunch-break', title: 'Lunch break', description: 'Play something on a weekday between 12 and 1 pm', icon: 'i-carbon-restaurant', group: 'time', tier: 1, hidden: true, value: f => f.lunchPlays, target: 1 },
  { id: 'around-the-clock', title: 'Around the clock', description: 'Play something in every hour of the day, over time', icon: 'i-carbon-time', group: 'time', tier: 4, value: f => f.hours.filter(n => n > 0).length, target: 24 },
  { id: 'weekend-warrior', title: 'Weekend warrior', description: 'Play on 10 different weekend days', icon: 'i-carbon-calendar-heat-map', group: 'time', tier: 2, value: f => f.weekendDays, target: 10 },
  ...ladder({ icon: 'i-carbon-fire', group: 'time', value: f => f.bestStreak }, 'streak', [
    [3, 'Three in a row', 'Play on three days in a row', 1],
    [7, 'Week streak', 'Play on seven days in a row', 2],
    [30, 'Month streak', 'Play on 30 days in a row', 3],
    [100, 'Unbroken', 'Play on 100 days in a row', 4],
  ]),
  ...ladder({ icon: 'i-carbon-calendar', group: 'time', value: f => f.daysActive }, 'days', [
    [30, 'Thirty days', 'Play on 30 different days', 2],
    [100, 'Hundred days', 'Play on 100 different days', 3],
    [365, 'A year of it', 'Play on 365 different days', 4],
  ]),
  { id: 'xmas', title: 'Ho ho ho', description: 'Play something on Christmas Day', icon: 'i-carbon-gift', group: 'time', tier: 1, hidden: true, value: f => yes(f.specialDays.includes('xmas')), target: 1 },
  { id: 'new-year', title: 'New year, same me', description: 'Play something on New Year\'s Day', icon: 'i-carbon-chart-line-smooth', group: 'time', tier: 1, hidden: true, value: f => yes(f.specialDays.includes('newyear')), target: 1 },
  { id: 'halloween', title: 'Spooky', description: 'Play something on Halloween', icon: 'i-carbon-moon', group: 'time', tier: 1, hidden: true, value: f => yes(f.specialDays.includes('halloween')), target: 1 },
  { id: 'valentine', title: 'Self love', description: 'Play something on Valentine\'s Day', icon: 'i-carbon-favorite', group: 'time', tier: 1, hidden: true, value: f => yes(f.specialDays.includes('valentine')), target: 1 },
  { id: 'april-fools', title: 'No joke', description: 'Play something on April Fools\' Day', icon: 'i-carbon-face-wink', group: 'time', tier: 1, hidden: true, value: f => yes(f.specialDays.includes('aprilfools')), target: 1 },
  { id: 'friday-13', title: 'Lucky anyway', description: 'Play something on a Friday the 13th', icon: 'i-carbon-face-dizzy', group: 'time', tier: 2, hidden: true, value: f => yes(f.specialDays.includes('friday13')), target: 1 },
  { id: 'leap-day', title: 'Once in four years', description: 'Play something on the 29th of February', icon: 'i-carbon-calendar', group: 'time', tier: 3, hidden: true, value: f => yes(f.specialDays.includes('leap')), target: 1 },
  { id: 'birthday', title: 'Happy birthday', description: 'Play something on playhound\'s birthday, the 26th of October', icon: 'i-carbon-gift', group: 'time', tier: 1, hidden: true, value: f => yes(f.specialDays.includes('birthday')), target: 1 },

  // ── Library ─────────────────────────────────────────────────────────────
  { id: 'moving-in', title: 'Moving in', description: 'Open a library folder', icon: 'i-carbon-folder-open', group: 'library', tier: 1, value: f => f.library.videos, target: 1 },
  ...ladder({ icon: 'i-carbon-catalog', group: 'library', value: f => f.library.videos }, 'library', [
    [100, 'Collector', 'A library of 100 videos', 1],
    [500, 'Hoarder', 'A library of 500 videos', 2],
    [1000, 'Curator', 'A library of 1,000 videos', 3],
    [5000, 'Data hoarder', 'A library of 5,000 videos', 4],
  ]),
  { id: 'scripted-100', title: 'Well scripted', description: '100 videos with scripts in your library', icon: 'i-carbon-chart-line', group: 'library', tier: 2, value: f => f.library.scripted, target: 100 },
  { id: 'scripted-1000', title: 'Script library', description: '1,000 videos with scripts in your library', icon: 'i-carbon-chart-line', group: 'library', tier: 3, value: f => f.library.scripted, target: 1000 },
  { id: 'multi-axis', title: 'More axes', description: '10 multi-axis videos in your library', icon: 'i-carbon-3d-mpr-toggle', group: 'library', tier: 2, value: f => f.library.multiAxis, target: 10 },
  { id: 'star-1', title: 'Favourite', description: 'Star a video', icon: 'i-carbon-star', group: 'library', tier: 1, value: f => f.library.starred, target: 1 },
  { id: 'star-50', title: 'Starstruck', description: 'Star 50 videos', icon: 'i-carbon-star-filled', group: 'library', tier: 2, value: f => f.library.starred, target: 50 },
  { id: 'tag-10', title: 'Organised', description: 'Tag 10 videos', icon: 'i-carbon-tag', group: 'library', tier: 1, value: f => f.library.tagged, target: 10 },
  { id: 'tag-100', title: 'Librarian', description: 'Tag 100 videos', icon: 'i-carbon-tag-group', group: 'library', tier: 2, value: f => f.library.tagged, target: 100 },
  { id: 'playlist-1', title: 'Mixtape', description: 'Make a playlist', icon: 'i-carbon-playlist', group: 'library', tier: 1, value: f => f.playlists, target: 1 },
  { id: 'playlist-10', title: 'DJ', description: 'Make 10 playlists', icon: 'i-carbon-music', group: 'library', tier: 2, value: f => f.playlists, target: 10 },
  { id: 'long-player', title: 'Long player', description: 'A playlist of 50 videos', icon: 'i-carbon-list-boxes', group: 'library', tier: 2, value: f => f.biggestPlaylist, target: 50 },
  { id: 'bookmarks', title: 'Dog-eared', description: 'Keep 10 bookmarks', icon: 'i-carbon-bookmark', group: 'library', tier: 1, value: f => f.bookmarks, target: 10 },
  { id: 'audio', title: 'Ears only', description: 'Play an audio file with a script', icon: 'i-carbon-headphones', group: 'library', tier: 1, value: f => c(f, 'audio'), target: 1 },
  { id: 'stream', title: 'From afar', description: 'Play a video streamed from a file host', icon: 'i-carbon-cloud-download', group: 'library', tier: 1, value: f => c(f, 'stream'), target: 1 },
  { id: 'rename-10', title: 'Tidy', description: 'Rename 10 videos in the Organizer', icon: 'i-carbon-clean', group: 'library', tier: 1, value: f => c(f, 'rename'), target: 10 },
  { id: 'download-1', title: 'Fresh off the forum', description: 'Save a script from EroScripts', icon: 'i-carbon-download', group: 'library', tier: 1, value: f => c(f, 'download'), target: 1 },
  { id: 'download-25', title: 'Regular customer', description: 'Save 25 scripts from EroScripts', icon: 'i-carbon-shopping-bag', group: 'library', tier: 2, value: f => c(f, 'download'), target: 25 },

  // ── Making things ───────────────────────────────────────────────────────
  ...ladder({ icon: 'i-carbon-edit', group: 'scripts', value: f => c(f, 'edit-save') }, 'edits', [
    [1, 'Scriptwright', 'Save an edit in the script editor', 1],
    [25, 'Editor', 'Save 25 edits', 2],
    [100, 'Script doctor', 'Save 100 edits', 3],
  ]),
  { id: 'pattern', title: 'Signature move', description: 'Save a pattern in the script editor', icon: 'i-carbon-save-series', group: 'scripts', tier: 1, value: f => f.patterns, target: 1 },
  { id: 'patterns-10', title: 'Repertoire', description: 'Save 10 patterns', icon: 'i-carbon-save-series', group: 'scripts', tier: 2, value: f => f.patterns, target: 10 },
  { id: 'music-1', title: 'Beatmaker', description: 'Make a script from the music', icon: 'i-carbon-music', group: 'scripts', tier: 1, value: f => c(f, 'music-script'), target: 1 },
  { id: 'music-10', title: 'Producer', description: 'Make 10 scripts from the music', icon: 'i-carbon-music', group: 'scripts', tier: 2, value: f => c(f, 'music-script'), target: 10 },
  { id: 'vibe-track', title: 'Good vibrations', description: 'Make a vibe track in the script editor', icon: 'i-carbon-activity', group: 'scripts', tier: 1, value: f => c(f, 'vibe-track'), target: 1 },
  { id: 'record-1', title: 'Live take', description: 'Record a session as a script', icon: 'i-carbon-recording', group: 'scripts', tier: 1, value: f => c(f, 'recording'), target: 1 },
  { id: 'record-10', title: 'Studio time', description: 'Record 10 sessions as scripts', icon: 'i-carbon-recording-filled', group: 'scripts', tier: 2, value: f => c(f, 'recording'), target: 10 },
  { id: 'share-1', title: 'Show and tell', description: 'Make a share card', icon: 'i-carbon-image', group: 'scripts', tier: 1, value: f => c(f, 'share-card'), target: 1 },
  { id: 'share-25', title: 'Poster child', description: 'Make 25 share cards', icon: 'i-carbon-image-copy', group: 'scripts', tier: 2, value: f => c(f, 'share-card'), target: 25 },
  { id: 'programme-1', title: 'Programmed', description: 'Save a programme', icon: 'i-carbon-roadmap', group: 'scripts', tier: 1, value: f => f.programmes, target: 1 },
  { id: 'rule-1', title: 'Automation', description: 'Make a rule', icon: 'i-carbon-rule', group: 'scripts', tier: 1, value: f => f.rules, target: 1 },
  { id: 'rule-10', title: 'Rulebook', description: 'Make 10 rules', icon: 'i-carbon-rule', group: 'scripts', tier: 2, value: f => f.rules, target: 10 },

  // ── Devices ─────────────────────────────────────────────────────────────
  { id: 'tcode', title: 'Hello, stroker', description: 'Connect a TCode device (OSR, SR6…)', icon: 'i-carbon-usb', group: 'devices', tier: 1, value: f => c(f, 'device:tcode'), target: 1 },
  { id: 'tcode-net', title: 'Wireless', description: 'Connect a TCode device over the network', icon: 'i-carbon-wifi', group: 'devices', tier: 2, value: f => c(f, 'device:tcode-net'), target: 1 },
  { id: 'handy', title: 'Handy man', description: 'Connect the Handy', icon: 'i-carbon-bluetooth', group: 'devices', tier: 1, value: f => c(f, 'device:handy'), target: 1 },
  { id: 'intiface', title: 'Plugged in', description: 'Connect to Intiface', icon: 'i-carbon-plug', group: 'devices', tier: 1, value: f => c(f, 'device:intiface'), target: 1 },
  { id: 'toy', title: 'Good vibes', description: 'Have a toy follow along through Intiface', icon: 'i-carbon-activity', group: 'devices', tier: 1, value: f => c(f, 'device:toy'), target: 1 },
  { id: 'devices-2', title: 'Double trouble', description: 'Two devices at once', icon: 'i-carbon-connect', group: 'devices', tier: 2, value: f => c(f, 'devices-max'), target: 2 },
  { id: 'devices-4', title: 'Orchestra', description: 'Four devices at once', icon: 'i-carbon-network-3', group: 'devices', tier: 3, hidden: true, value: f => c(f, 'devices-max'), target: 4 },
  { id: 'estim', title: 'Shocking', description: 'Run e-stim', icon: 'i-carbon-lightning', group: 'devices', tier: 2, value: f => c(f, 'device:estim'), target: 1 },
  { id: 'heart', title: 'Heart on your sleeve', description: 'Connect a heart-rate monitor', icon: 'i-carbon-favorite', group: 'devices', tier: 1, value: f => c(f, 'device:heart'), target: 1 },
  { id: 'gamepad', title: 'Player two', description: 'Drive the stroke with a gamepad', icon: 'i-carbon-game-console', group: 'devices', tier: 1, value: f => c(f, 'gamepad'), target: 1 },
  { id: 'remote', title: 'Remote control', description: 'Control playhound from your phone', icon: 'i-carbon-mobile', group: 'devices', tier: 1, value: f => c(f, 'remote'), target: 1 },
  { id: 'linked', title: 'Linked up', description: 'Play with linked axes on', icon: 'i-carbon-link', group: 'devices', tier: 1, value: f => c(f, 'linked'), target: 1 },
  { id: 'fully-loaded', title: 'Fully loaded', description: 'Connect TCode, the Handy, Intiface and a heart-rate monitor, over time', icon: 'i-carbon-tool-kit', group: 'devices', tier: 4, value: f => ['device:tcode', 'device:handy', 'device:intiface', 'device:heart'].filter(k => c(f, k) > 0).length, target: 4 },

  // ── Exploring ───────────────────────────────────────────────────────────
  { id: 'vr', title: 'Another dimension', description: 'Look around a VR video', icon: 'i-carbon-3d-cursor', group: 'features', tier: 1, value: f => c(f, 'vr-view'), target: 1 },
  { id: 'vr-25', title: 'Virtually always', description: 'Look around 25 VR videos', icon: 'i-carbon-3d-cursor-alt', group: 'features', tier: 2, value: f => c(f, 'vr-view'), target: 25 },
  { id: 'popout', title: 'Picture in picture', description: 'Pop the player out', icon: 'i-carbon-popup', group: 'features', tier: 1, value: f => c(f, 'popout'), target: 1 },
  { id: 'fullscreen', title: 'Big screen', description: 'Go fullscreen', icon: 'i-carbon-maximize', group: 'features', tier: 1, value: f => c(f, 'fullscreen'), target: 1 },
  { id: 'fast', title: 'Fast forward', description: 'Play at 1.5 times the speed or faster', icon: 'i-carbon-forward-10', group: 'features', tier: 1, value: f => c(f, 'speed-fast'), target: 1 },
  { id: 'slow', title: 'Slow motion', description: 'Play at half speed or slower', icon: 'i-carbon-rewind-10', group: 'features', tier: 1, value: f => c(f, 'speed-slow'), target: 1 },
  { id: 'loop', title: 'Again, again', description: 'Loop a part of a video', icon: 'i-carbon-repeat', group: 'features', tier: 1, value: f => c(f, 'loop'), target: 1 },
  { id: 'programme-run', title: 'Sit back', description: 'Run a programme', icon: 'i-carbon-roadmap', group: 'features', tier: 1, value: f => c(f, 'programme'), target: 1 },
  { id: 'programme-10', title: 'Creature of habit', description: 'Run programmes 10 times', icon: 'i-carbon-roadmap', group: 'features', tier: 2, value: f => c(f, 'programme'), target: 10 },
  { id: 'hypno', title: 'You are getting sleepy', description: 'Turn on the hypno overlay', icon: 'i-carbon-circle-dash', group: 'features', tier: 1, value: f => c(f, 'hypno'), target: 1 },
  { id: 'binaural', title: 'Brainwaves', description: 'Play binaural beats', icon: 'i-carbon-headphones', group: 'features', tier: 1, value: f => c(f, 'binaural'), target: 1 },
  { id: 'music-source', title: 'Feel the beat', description: 'Let the music drive the motion', icon: 'i-carbon-music', group: 'features', tier: 1, value: f => c(f, 'music-source'), target: 1 },
  { id: 'plugin-1', title: 'Expanded', description: 'Install a plugin', icon: 'i-carbon-application', group: 'features', tier: 1, value: f => f.plugins, target: 1 },
  { id: 'plugin-5', title: 'Power user', description: 'Install five plugins', icon: 'i-carbon-apps', group: 'features', tier: 2, value: f => f.plugins, target: 5 },
  { id: 'theme', title: 'Fresh coat', description: 'Change the theme', icon: 'i-carbon-color-palette', group: 'features', tier: 1, value: f => c(f, 'theme'), target: 1 },
  { id: 'slideshow', title: 'Slideshow', description: 'Run a slideshow', icon: 'i-carbon-image', group: 'features', tier: 1, value: f => c(f, 'slideshow'), target: 1 },
  { id: 'wall', title: 'Wall of screens', description: 'Open the media wall', icon: 'i-carbon-grid', group: 'features', tier: 1, value: f => c(f, 'wall'), target: 1 },
  { id: 'panic', title: 'Oops', description: 'Press panic', icon: 'i-carbon-warning-alt', group: 'features', tier: 1, hidden: true, value: f => c(f, 'panic'), target: 1 },
  { id: 'panic-10', title: 'Safety first', description: 'Press panic 10 times', icon: 'i-carbon-warning-alt-filled', group: 'features', tier: 2, hidden: true, value: f => c(f, 'panic'), target: 10 },

  // ── About achievements ──────────────────────────────────────────────────
  ...ladder({ icon: 'i-carbon-trophy', group: 'meta', value: f => f.earned }, 'earned', [
    [10, 'Achiever', 'Earn 10 achievements', 1],
    [50, 'Overachiever', 'Earn 50 achievements', 2],
    [100, 'Completionist', 'Earn 100 achievements', 3],
  ]),
]

/** Earn every other playhound achievement. */
ACHIEVEMENTS.push({
  id: 'platinum',
  title: 'Platinum',
  description: 'Earn every other achievement',
  icon: 'i-carbon-trophy-filled',
  group: 'meta',
  tier: 4,
  value: f => f.earned,
  target: ACHIEVEMENTS.length,
})

/** Where one stands: its value, capped at the target, and whether that earns it. */
export function progressOf(a: AchievementDef, f: AchievementFacts): { value: number, done: boolean } {
  const v = a.value(f)
  const value = Number.isFinite(v) ? Math.max(0, v) : 0
  return { value: Math.min(value, a.target), done: value >= a.target }
}

/**
 * The ones newly earned, given those already earned. The ones about
 * achievements count those earned so far, so they settle in a second pass.
 */
export function newlyEarned(f: Omit<AchievementFacts, 'earned'>, earned: ReadonlySet<string>): string[] {
  const out: string[] = []
  const have = new Set(earned)
  for (let pass = 0; pass < 2; pass++) {
    const facts: AchievementFacts = { ...f, earned: [...have].filter(id => ACHIEVEMENTS.some(a => a.id === id)).length }
    for (const a of ACHIEVEMENTS) {
      if (!have.has(a.id) && progressOf(a, facts).done) {
        have.add(a.id)
        out.push(a.id)
      }
    }
  }
  return out
}

// ─── Facts from the session log and the days ──────────────────────────────

/** `YYYY-MM-DD` → a local date. */
function dateOf(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** The special days a local date falls on. */
export function specialDaysOf(d: Date): string[] {
  const m = d.getMonth() + 1
  const day = d.getDate()
  const out: string[] = []
  if (m === 12 && day === 25)
    out.push('xmas')
  if (m === 1 && day === 1)
    out.push('newyear')
  if (m === 10 && day === 31)
    out.push('halloween')
  if (m === 2 && day === 14)
    out.push('valentine')
  if (m === 4 && day === 1)
    out.push('aprilfools')
  if (day === 13 && d.getDay() === 5)
    out.push('friday13')
  if (m === 2 && day === 29)
    out.push('leap')
  if (m === 10 && day === 26)
    out.push('birthday')
  return out
}

/** From the days played on (`YYYY-MM-DD` keys): how many, the best streak, weekend days and special days. */
export function dayFacts(days: Iterable<string>): Pick<AchievementFacts, 'daysActive' | 'bestStreak' | 'weekendDays' | 'specialDays'> {
  const sorted = [...new Set(days)].sort()
  let best = 0
  let run = 0
  let prev: Date | null = null
  let weekend = 0
  const special = new Set<string>()
  for (const k of sorted) {
    const d = dateOf(k)
    if (Number.isNaN(d.getTime()))
      continue
    // A day after the one before (whole days apart, whatever the clocks did).
    run = prev && Math.round((d.getTime() - prev.getTime()) / 86_400_000) === 1 ? run + 1 : 1
    best = Math.max(best, run)
    prev = d
    if (d.getDay() === 0 || d.getDay() === 6)
      weekend++
    for (const s of specialDaysOf(d))
      special.add(s)
  }
  return { daysActive: sorted.length, bestStreak: best, weekendDays: weekend, specialDays: [...special] }
}

/** From the session log: lengths, edges and finishes per session, hours of the day, heart rate. */
export function sessionFacts(sessions: readonly SessionLog[]): Pick<AchievementFacts, 'sessions' | 'longestSessionMs' | 'maxEdgesInSession' | 'maxFinishesInSession' | 'maxVideosInSession' | 'edgesBeforeFinish'
  | 'fastestFinishMs' | 'longestFinishedSessionMs' | 'finishTopSpm' | 'finishLowSpm' | 'heartMax' | 'heartSessions'
  | 'edgeSources' | 'hours' | 'lunchPlays'> {
  const hours = Array.from({ length: 24 }, () => 0)
  const edgeSources: Record<string, number> = {}
  let longest = 0
  let maxEdges = 0
  let maxFinishes = 0
  let maxVideos = 0
  let beforeFinish = 0
  let fastest: number | null = null
  let longestFinished = 0
  let top = 0
  let low: number | null = null
  let heartMax = 0
  let heartSessions = 0
  let lunch = 0
  for (const s of sessions) {
    const len = Math.max(0, s.end - s.start)
    longest = Math.max(longest, len)
    maxEdges = Math.max(maxEdges, s.edges.length)
    maxFinishes = Math.max(maxFinishes, s.finishes.length)
    maxVideos = Math.max(maxVideos, new Set(s.plays.map(p => p.video)).size)
    for (const e of s.edges)
      edgeSources[e.source ?? 'key'] = (edgeSources[e.source ?? 'key'] ?? 0) + 1
    for (const p of s.plays) {
      const d = new Date(p.from)
      hours[d.getHours()]++
      if (d.getHours() === 12 && d.getDay() >= 1 && d.getDay() <= 5)
        lunch++
    }
    if (s.finishes.length) {
      const first = Math.min(...s.finishes.map(f => f.ts))
      beforeFinish = Math.max(beforeFinish, s.edges.filter(e => e.ts < first).length)
      const toFinish = first - s.start
      if (toFinish >= 0)
        fastest = fastest === null ? toFinish : Math.min(fastest, toFinish)
      longestFinished = Math.max(longestFinished, len)
      for (const f of s.finishes) {
        if (f.spm && f.spm > 0) {
          top = Math.max(top, f.spm)
          low = low === null ? f.spm : Math.min(low, f.spm)
        }
      }
    }
    if (s.heart && s.heart.n > 0) {
      heartSessions++
      heartMax = Math.max(heartMax, s.heart.max)
    }
  }
  return {
    sessions: sessions.length,
    longestSessionMs: longest,
    maxEdgesInSession: maxEdges,
    maxFinishesInSession: maxFinishes,
    maxVideosInSession: maxVideos,
    edgesBeforeFinish: beforeFinish,
    fastestFinishMs: fastest,
    longestFinishedSessionMs: longestFinished,
    finishTopSpm: top,
    finishLowSpm: low,
    heartMax,
    heartSessions,
    edgeSources,
    hours,
    lunchPlays: lunch,
  }
}

/** A short line for a counted one's progress: "37 / 100", "6.5 / 10 h". */
export function progressText(a: AchievementDef, value: number): string {
  if (a.unit === 'hours') {
    const v = value >= 10 ? Math.floor(value) : Math.floor(value * 10) / 10
    return `${v} / ${a.target} h`
  }
  return `${Math.floor(value).toLocaleString()} / ${a.target.toLocaleString()}`
}
