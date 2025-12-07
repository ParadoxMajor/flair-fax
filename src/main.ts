import { Devvit, SettingScope } from "@devvit/public-api";
import './RedditUtils';
import './UserFlairs';

Devvit.configure({
  redditAPI: true,
});

const originalLog = console.log;
console.log = (...args: any[]) => {
  const now = new Date();
  const timestamp = now.toLocaleString();
  originalLog.apply(console, [`[${timestamp}]`, ...args]);
};
const originalError = console.error;
console.error = (...args: any[]) => {
  const now = new Date();
  const timestamp = now.toLocaleString();
  originalError.apply(console, [`[${timestamp}]`, ...args]);
};
const originalWarn= console.warn;
console.warn = (...args: any[]) => {
  const now = new Date();
  const timestamp = now.toLocaleString();
  originalWarn.apply(console, [`[${timestamp}]`, ...args]);
};
const originalDebug= console.debug;
console.debug = (...args: any[]) => {
  const now = new Date();
  const timestamp = now.toLocaleString();
  originalDebug.apply(console, [`[${timestamp}]`, ...args]);
};

Devvit.addSettings(
[
	{
		name: "devvitExecutionTimeoutSeconds",
		type: "number",
		label: "How long until Devvit times out",
		defaultValue: 30,
    scope: SettingScope.App,
	},
]);

export interface AppSettings {

  //how many seconds until Devvit times out execution
  devvitExecutionTimeoutSeconds: number;
}

/**
 * Fetch all app settings in one go
 */
export async function getAppSettings(context: Devvit.Context): Promise<AppSettings> {
  const devvitExecutionTimeoutSeconds = parseInt((await context.settings.get('devvitExecutionTimeoutSeconds')) as string ?? '30', 10);

	return {
    devvitExecutionTimeoutSeconds,
	};
}

export default Devvit;