
import { Devvit, ModeratorPermission, User, ModNote } from "@devvit/public-api";
import { getAppSettings } from "./main.js";

Devvit.configure({
  redditAPI: true,
});

export const MAX_COMMENT_CHARACTER_COUNT = 10000 as number;

export type RedditPlatform =
  | 'ios'
  | 'android'
  | 'shreddit'
  | 'newreddit'
  | 'oldreddit'
  | 'web'
  | 'app'
  | 'unknown';

/**
 * Returns a detailed platform ID based on the devvit-user-agent metadata.
 * Useful for tailoring URLs or UI behaviors per platform.
 */
export function getRedditPlatform(context: Devvit.Context): RedditPlatform {
  const ua = context.metadata?.['devvit-user-agent']?.values?.[0]?.toLowerCase() ?? '';

  // --- Mobile app detection ---
  if (ua.includes('ios')) return 'ios';
  if (ua.includes('shreddit')) return 'shreddit';
  if (ua.includes('android')) return 'android';

  // --- Web detection ---
  if (ua.includes('newreddit')) return 'newreddit';
  if (ua.includes('oldreddit')) return 'oldreddit';
  if (ua.includes('web')) return 'web';

  return 'unknown';
}

/**
 * Returns a simplified category:
 *  - "app" for iOS / Android / Shreddit
 *  - "web" for new / old Reddit
 */
export function getRedditPlatformGroup(context: Devvit.Context): 'app' | 'web' | 'unknown' {
  const platform = getRedditPlatform(context);
  if (['ios', 'android'].includes(platform)) return 'app';
  if (['shreddit', 'newreddit', 'oldreddit', 'web'].includes(platform)) return 'web';
  return 'unknown';
}

export function isRedditApp(context: Devvit.Context): boolean {
    return getRedditPlatformGroup(context) === 'app';
}

/**
 * Returns the correct Reddit domain for the detected platform.
 */
export function formatRedditUrl(context: Devvit.Context, url: string): string {
  //const platform = getRedditPlatform(context);
  const group = getRedditPlatformGroup(context);

  //TODO if we can ever tell if user is opted into new Reddit or not, handle old vs sh vs www domains

  switch (group) {
    case 'app':
     //return 'https://reddit.app.link/?reddit_url=' + encodeURIComponent(url);
    default:
      // Fallback to normal Reddit
      return url;
  }
}

/**
 * Check mod permissions
 */
export async function getModPerms(context: Devvit.Context) : Promise<ModeratorPermission[]> {
    const subredditName = await context.reddit.getCurrentSubredditName() || '';
    const username = await context.reddit.getCurrentUsername() || '';
    const listing = context.reddit.getModerators({ subredditName });
    const mods = await listing.all(); // <-- convert Listing<User> to User[]
    const mod = mods.find(m => m.username.toLowerCase() === username.toLowerCase());
    const perms = mod ? await mod.getModPermissionsForSubreddit(subredditName) : [];
    return perms;
}

export async function checkForModPerms(context: Devvit.Context, requiredPerms : ModeratorPermission[]) : Promise<boolean> {
    const perms = await getModPerms(context);
    // If the user has "all", they automatically pass.
    if (perms.includes('all')) return true;

    // Otherwise, check if every required permission is present.
    return requiredPerms.every(p => perms.includes(p));
}

function getMainDomain(urlString: string) {
    try {
        const hostname = new URL(urlString).hostname; // e.g., www.google.com
        const parts = hostname.split('.');

        // Take the second-to-last part as the "main domain"
        // Works for www.google.com, but may fail on co.uk
        if (parts.length >= 2) {
            return parts[parts.length - 2];
        }

        return hostname; // fallback for single-part hostnames
    } catch {
        return null; // invalid URL
    }
}